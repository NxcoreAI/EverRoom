import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { AgentEventBroker } from "../src/modules/agent/event-broker.js";
import { AgentService } from "../src/modules/agent/service.js";

const temporaryDirectories: string[] = [];

class RecordingRuntime implements AgentRuntime {
  readonly starts: StartRuntimeRunInput[] = [];

  constructor(readonly id: string) {}

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input);
    const events = new AsyncEventQueue<RuntimeEvent>();
    events.push({ type: "run.completed", payload: {} });
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

const CHANNEL_AGENT_ID = "codex:/usr/local/bin/codex";

const STUB_CARD = {
  name: "Codex",
  description: "CLI coding agent",
  version: "1.0.0",
  supportedInterfaces: [{ url: "stub", protocolBinding: "acp", protocolVersion: "1" }],
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-channel-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const primary = new RecordingRuntime("primary");
  const channel = new RecordingRuntime(CHANNEL_AGENT_ID);
  const service = new AgentService(
    database.db,
    primary,
    new AgentEventBroker(),
    { info: () => undefined },
    undefined,
    undefined,
    undefined,
    true,
    (target) => (target.id === CHANNEL_AGENT_ID ? channel : null),
  );
  return { ...database, primary, channel, service };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("Agent session CLI channel", () => {
  it("locks channelAgentId as activeAgentId at creation and ignores modelPreference", async () => {
    const { service, sqlite } = await createHarness();

    const session = service.createSession({
      pageLabel: "Home",
      roomId: null,
      channelAgentId: CHANNEL_AGENT_ID,
      modelPreference: "primary",
    });
    expect(session.activeAgentId).toBe(CHANNEL_AGENT_ID);
    expect(session.channelAgentId).toBe(CHANNEL_AGENT_ID);
    expect(session.modelPreference).toBeUndefined();

    await service.dispose();
    sqlite.close();
  });

  it("routes runs of a locked channel session to the channel runtime without targetAgentId", async () => {
    const { service, primary, channel, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null, channelAgentId: CHANNEL_AGENT_ID });

    // 渲染层渠道会话每轮显式带 targetAgentId；这里同时覆盖省略的路径——
    // 网关按 session.activeAgentId 兜底到渠道。
    for (const targetAgentId of [CHANNEL_AGENT_ID, undefined] as const) {
      const run = await service.startRun(session.id, {
        prompt: `渠道连续对话 ${targetAgentId ?? "auto"}`,
        idempotencyKey: `channel-run-${targetAgentId ?? "auto"}`,
        invocationMode: "explicit_switch",
        ...(targetAgentId ? { targetAgentId } : {}),
        localAgent: {
          id: CHANNEL_AGENT_ID,
          provider: "codex",
          displayName: "Codex",
          executablePath: "/usr/local/bin/codex",
          workingDirectory: "/tmp/sandbox",
          permissionProfile: "inspect",
          card: STUB_CARD,
          acpAdapter: null,
        },
        context: {},
      });
      expect(run.agentId).toBe(CHANNEL_AGENT_ID);
    }

    expect(channel.starts).toHaveLength(2);
    expect(primary.starts).toHaveLength(0);
    const snapshot = service.getSnapshot(session.id);
    expect(snapshot?.session.channelAgentId).toBe(CHANNEL_AGENT_ID);
    expect(snapshot?.session.activeAgentId).toBe(CHANNEL_AGENT_ID);
    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("rejects a channel run whose localAgent does not match the channel", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null, channelAgentId: CHANNEL_AGENT_ID });

    await expect(service.startRun(session.id, {
      prompt: "错配的 localAgent",
      idempotencyKey: "channel-run-mismatch",
      localAgent: {
        id: "claude:/usr/local/bin/claude",
        provider: "claude",
        displayName: "Claude Code",
        executablePath: "/usr/local/bin/claude",
        workingDirectory: "/tmp/sandbox",
        permissionProfile: "inspect",
        card: { ...STUB_CARD, name: "Claude Code" },
        acpAdapter: null,
      },
      context: {},
    })).rejects.toThrow("local_agent_target_invalid");

    await service.dispose();
    sqlite.close();
  });
});
