import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalAgentInvocationTarget, RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentEvents } from "../src/infrastructure/database/schema.js";
import { AgentEventBroker } from "../src/modules/agent/event-broker.js";
import { AgentService } from "../src/modules/agent/service.js";

const temporaryDirectories: string[] = [];

class RecordingRuntime implements AgentRuntime {
  readonly id = "recording";
  readonly starts: StartRuntimeRunInput[] = [];

  constructor(private readonly events: RuntimeEvent[] = [{ type: "run.completed", payload: {} }]) {}

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input);
    const events = new AsyncEventQueue<RuntimeEvent>();
    for (const event of this.events) events.push(event);
    events.end();
    return { runId: input.runId, runtimeSessionRef: `${this.id}-${input.sessionId}`, events };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("not supported");
  }

  async sendInput(): Promise<void> {}
  async cancel(_runId: string): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const codexTarget: LocalAgentInvocationTarget = {
  id: "codex:/usr/local/bin/codex",
  provider: "codex",
  displayName: "Codex",
  executablePath: "/usr/local/bin/codex",
  workingDirectory: "/tmp/everroom-sandbox/codex",
  permissionProfile: "inspect",
  card: {
    name: "Codex",
    description: "OpenAI Codex CLI",
    version: "1.0.0",
    supportedInterfaces: [],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  },
};

const claudeTarget: LocalAgentInvocationTarget = {
  ...codexTarget,
  id: "claude:/usr/local/bin/claude",
  provider: "claude",
  displayName: "Claude Code",
  workingDirectory: "/tmp/everroom-sandbox/claude",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness(runtime: RecordingRuntime = new RecordingRuntime()) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-referenced-local-agent-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new AgentService(database.db, runtime, new AgentEventBroker());
  return { ...database, runtime, service };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("Agent referenced local Agents (@ mentions)", () => {
  it("lists all mentioned Agents for autonomous dispatch and passes targets through", async () => {
    const { service, runtime, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await service.startRun(session.id, {
      prompt: "先让 @codex 审代码，再让 @claude-code 修",
      idempotencyKey: "mention-multi",
      targetAgentId: "main",
      referencedLocalAgents: [codexTarget, claudeTarget],
      context: { referencedLocalAgentIds: [codexTarget.id, claudeTarget.id] },
    });

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.prompt).toContain("Codex");
    expect(runtime.starts[0]?.prompt).toContain(codexTarget.id);
    expect(runtime.starts[0]?.prompt).toContain("Claude Code");
    expect(runtime.starts[0]?.prompt).toContain(claudeTarget.id);
    expect(runtime.starts[0]?.prompt).toContain("local_agent_dispatch");
    expect(runtime.starts[0]?.prompt).not.toContain("MUST call");
    expect(runtime.starts[0]?.referencedLocalAgents).toEqual([
      expect.objectContaining({ id: codexTarget.id }),
      expect.objectContaining({ id: claudeTarget.id }),
    ]);
    expect(service.getSnapshot(session.id)?.session.activeAgentId).toBe("main");
    await service.dispose();
    sqlite.close();
  });

  it("rejects a mention outside Main, combined conversation contexts, and mismatched targets", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await expect(service.startRun(session.id, {
      prompt: "点名",
      idempotencyKey: "mention-non-main",
      targetAgentId: codexTarget.id,
      localAgent: codexTarget,
      referencedLocalAgents: [codexTarget],
      context: { referencedLocalAgentIds: [codexTarget.id] },
    })).rejects.toThrow("referenced_local_agent_requires_main_agent");

    await expect(service.startRun(session.id, {
      prompt: "点名",
      idempotencyKey: "mention-conflict",
      targetAgentId: "main",
      referencedLocalAgents: [codexTarget],
      context: { referencedLocalAgentIds: [codexTarget.id], referencedConversationId: "thread-1" },
    })).rejects.toThrow("agent_conversation_context_conflict");

    await expect(service.startRun(session.id, {
      prompt: "点名",
      idempotencyKey: "mention-no-target",
      targetAgentId: "main",
      context: { referencedLocalAgentIds: [codexTarget.id] },
    })).rejects.toThrow("referenced_local_agent_target_mismatch");

    await expect(service.startRun(session.id, {
      prompt: "点名",
      idempotencyKey: "mention-partial-targets",
      targetAgentId: "main",
      referencedLocalAgents: [codexTarget, claudeTarget],
      context: { referencedLocalAgentIds: [codexTarget.id] },
    })).rejects.toThrow("referenced_local_agent_target_mismatch");

    await service.dispose();
    sqlite.close();
  });

  it("leaves terminal events untouched when a mentioned Agent is never dispatched", async () => {
    const { service, db, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await service.startRun(session.id, {
      prompt: "@codex 主 Agent 自己回答了",
      idempotencyKey: "mention-skip-dispatch",
      targetAgentId: "main",
      referencedLocalAgents: [codexTarget],
      context: { referencedLocalAgentIds: [codexTarget.id] },
    });
    await settle();

    const completed = db.select().from(agentEvents)
      .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.type, "run.completed")))
      .all();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toEqual({});
    await service.dispose();
    sqlite.close();
  });

  it("leaves terminal events untouched when no local Agent was addressed", async () => {
    const { service, db, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await service.startRun(session.id, {
      prompt: "普通一轮",
      idempotencyKey: "no-mention",
      targetAgentId: "main",
    });
    await settle();

    const completed = db.select().from(agentEvents)
      .where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.type, "run.completed")))
      .all();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toEqual({});
    await service.dispose();
    sqlite.close();
  });
});
