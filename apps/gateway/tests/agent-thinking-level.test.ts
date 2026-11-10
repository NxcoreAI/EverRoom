import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentThinkingLevel, RuntimeCapabilities } from "@nxcore/agent-contract";
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
  /** 结构化可选方法：网关经结构类型调用，用于记录每轮预热收到的 (sessionId, level)。 */
  readonly thinkingLevelCalls: Array<{ sessionId: string; level: AgentThinkingLevel | null }> = [];
  readonly forgottenThinkingSessions: string[] = [];

  constructor(readonly id: string) {}

  async setSessionThinkingLevel(
    sessionId: string,
    level: AgentThinkingLevel | null,
  ): Promise<{ applied: boolean }> {
    this.thinkingLevelCalls.push({ sessionId, level });
    return { applied: true };
  }

  forgetSessionThinkingLevel(sessionId: string): void {
    this.forgottenThinkingSessions.push(sessionId);
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: true, tools: true, steering: false, resume: false };
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-thinking-level-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const runtime = new RecordingRuntime("primary");
  const service = new AgentService(database.db, runtime, new AgentEventBroker());
  return { ...database, runtime, service };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("Agent session thinking level", () => {
  it("persists thinkingLevel at creation and exposes null when omitted", async () => {
    const { service, sqlite } = await createHarness();

    const withLevel = service.createSession({ pageLabel: "Home", roomId: null, thinkingLevel: "high" });
    expect(withLevel.thinkingLevel).toBe("high");
    expect(service.getSnapshot(withLevel.id)?.session.thinkingLevel).toBe("high");

    const withoutLevel = service.createSession({ pageLabel: "Home", roomId: null });
    expect(withoutLevel.thinkingLevel).toBeNull();
    expect(service.getSnapshot(withoutLevel.id)?.session.thinkingLevel).toBeNull();

    await service.dispose();
    sqlite.close();
  });

  it("preheats the runtime with the session thinking level on every run", async () => {
    const { service, runtime, sqlite } = await createHarness();

    const overridden = service.createSession({ pageLabel: "Home", roomId: null, thinkingLevel: "minimal" });
    await service.startRun(overridden.id, { prompt: "开档", idempotencyKey: "thinking-run-minimal", context: {} });
    expect(runtime.thinkingLevelCalls).toContainEqual({ sessionId: overridden.id, level: "minimal" });

    const following = service.createSession({ pageLabel: "Home", roomId: null });
    await service.startRun(following.id, { prompt: "跟随配置", idempotencyKey: "thinking-run-null", context: {} });
    expect(runtime.thinkingLevelCalls).toContainEqual({ sessionId: following.id, level: null });

    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("updates the stored level without applying it when no run is active", async () => {
    const { service, runtime, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await expect(service.setSessionThinkingLevel(session.id, "xhigh")).resolves.toEqual({
      thinkingLevel: "xhigh",
      applied: false,
    });
    expect(service.getSnapshot(session.id)?.session.thinkingLevel).toBe("xhigh");
    expect(runtime.thinkingLevelCalls).toHaveLength(0);

    await service.dispose();
    sqlite.close();
  });

  it("clears the override back to null", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null, thinkingLevel: "max" });

    await expect(service.setSessionThinkingLevel(session.id, null)).resolves.toEqual({
      thinkingLevel: null,
      applied: false,
    });
    expect(service.getSnapshot(session.id)?.session.thinkingLevel).toBeNull();

    await service.dispose();
    sqlite.close();
  });

  it("rejects invalid levels and unknown sessions", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    await expect(service.setSessionThinkingLevel(session.id, "ultra" as AgentThinkingLevel))
      .rejects.toThrow("agent_thinking_level_invalid");
    await expect(service.setSessionThinkingLevel("missing-session", "low"))
      .rejects.toThrow("agent_session_not_found");

    await service.dispose();
    sqlite.close();
  });
});