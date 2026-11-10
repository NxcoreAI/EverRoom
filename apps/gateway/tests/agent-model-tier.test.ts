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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-model-tier-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const primary = new RecordingRuntime("primary");
  const direct = new RecordingRuntime("main-direct");
  const lite = new RecordingRuntime("main-lite");
  const service = new AgentService(database.db, primary, new AgentEventBroker());
  const tiers = new Map<string, RecordingRuntime>([
    ["main-direct", direct],
    ["main-lite", lite],
  ]);
  service.setTierRuntimeResolver((agentId) => tiers.get(agentId) ?? null);
  return { ...database, primary, direct, lite, service, tiers };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("Agent session model tiers", () => {
  it("locks modelPreference to activeAgentId at session creation", async () => {
    const { service, sqlite } = await createHarness();

    const smart = service.createSession({ pageLabel: "Home", roomId: null });
    expect(smart.activeAgentId).toBe("main");
    expect(smart.modelPreference).toBe("smart");

    const primary = service.createSession({ pageLabel: "Home", roomId: null, modelPreference: "primary" });
    expect(primary.activeAgentId).toBe("main-direct");
    expect(primary.modelPreference).toBe("primary");

    const lite = service.createSession({ pageLabel: "Home", roomId: null, modelPreference: "lite" });
    expect(lite.activeAgentId).toBe("main-lite");
    expect(lite.modelPreference).toBe("lite");

    await service.dispose();
    sqlite.close();
  });

  it("silently falls back to smart when the requested tier runtime is unavailable", async () => {
    const { service, sqlite } = await createHarness();
    service.setTierRuntimeResolver(() => null);

    const session = service.createSession({ pageLabel: "Home", roomId: null, modelPreference: "lite" });
    expect(session.activeAgentId).toBe("main");
    expect(session.modelPreference).toBe("smart");

    await service.dispose();
    sqlite.close();
  });

  it("routes runs of a locked session to the tier runtime and reports the tier agentId", async () => {
    const { service, primary, direct, lite, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null, modelPreference: "lite" });

    // targetAgentId 省略：按会话锁定的档位运行（渲染层已不再传 'main'）。
    const run = await service.startRun(session.id, {
      prompt: "轻量直答",
      idempotencyKey: "tier-run-lite",
      context: {},
    });

    expect(run.agentId).toBe("main-lite");
    expect(lite.starts).toHaveLength(1);
    expect(direct.starts).toHaveLength(0);
    expect(primary.starts).toHaveLength(0);
    expect(service.getSnapshot(session.id)?.session.activeAgentId).toBe("main-lite");
    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("forces a different tier request back to the tier locked on the session", async () => {
    const { service, primary, direct, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    const run = await service.startRun(session.id, {
      prompt: "想换强模型",
      idempotencyKey: "tier-locked",
      targetAgentId: "main-direct",
      context: {},
    });

    expect(run.agentId).toBe("main");
    expect(primary.starts).toHaveLength(1);
    expect(direct.starts).toHaveLength(0);
    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("falls back to the primary runtime when the tier runtime disappears mid-session", async () => {
    const { service, primary, direct, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null, modelPreference: "primary" });

    service.setTierRuntimeResolver(() => null);
    const run = await service.startRun(session.id, {
      prompt: "lite 配置被移除后继续",
      idempotencyKey: "tier-fallback",
      context: {},
    });

    expect(run.agentId).toBe("main-direct");
    expect(primary.starts).toHaveLength(1);
    expect(direct.starts).toHaveLength(0);
    await settle();
    await service.dispose();
    sqlite.close();
  });
});
