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

async function createHarness(tiers: string[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-switch-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const primary = new RecordingRuntime("primary");
  const channel = new RecordingRuntime(CHANNEL_AGENT_ID);
  const direct = new RecordingRuntime("main-direct");
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
  // lite 永不注册：覆盖「lite 未配置回落 smart」路径；direct 按需注册。
  service.setTierRuntimeResolver((agentId) => (tiers.includes(agentId) ? direct : null));
  return { ...database, primary, channel, direct, service };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("Agent session mid-session target switch", () => {
  it("switches an existing session to a channel and routes the next run there", async () => {
    const { service, primary, channel, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    const updated = service.updateSession(session.id, { channelAgentId: CHANNEL_AGENT_ID });
    expect(updated?.activeAgentId).toBe(CHANNEL_AGENT_ID);
    expect(updated?.channelAgentId).toBe(CHANNEL_AGENT_ID);
    expect(updated?.modelPreference).toBeUndefined();

    const run = await service.startRun(session.id, {
      prompt: "切渠道后的第一轮",
      idempotencyKey: "switch-channel-run",
      invocationMode: "explicit_switch",
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
    expect(channel.starts).toHaveLength(1);
    expect(primary.starts).toHaveLength(0);

    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("switches a channel session back to a configured tier", async () => {
    const { service, channel, direct, sqlite } = await createHarness(["main-direct"]);
    const session = service.createSession({ pageLabel: "Home", roomId: null, channelAgentId: CHANNEL_AGENT_ID });

    const updated = service.updateSession(session.id, { channelAgentId: null, modelPreference: "primary" });
    expect(updated?.activeAgentId).toBe("main-direct");
    expect(updated?.channelAgentId).toBeUndefined();
    expect(updated?.modelPreference).toBe("primary");

    const run = await service.startRun(session.id, {
      prompt: "退出渠道回到档位",
      idempotencyKey: "switch-tier-run",
      context: {},
    });
    expect(run.agentId).toBe("main-direct");
    expect(direct.starts).toHaveLength(1);
    expect(channel.starts).toHaveLength(0);

    await settle();
    await service.dispose();
    sqlite.close();
  });

  it("falls back to smart when the requested tier is unconfigured", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });

    const updated = service.updateSession(session.id, { channelAgentId: null, modelPreference: "lite" });
    expect(updated?.activeAgentId).toBe("main");
    expect(updated?.modelPreference).toBe("smart");

    await service.dispose();
    sqlite.close();
  });

  it("rejects switching while a run is active", async () => {
    const { service, sqlite } = await createHarness();
    const session = service.createSession({ pageLabel: "Home", roomId: null });
    sqlite.prepare("UPDATE agent_sessions SET status = 'running' WHERE id = ?").run(session.id);

    expect(() => service.updateSession(session.id, { channelAgentId: CHANNEL_AGENT_ID }))
      .toThrow("agent_session_busy");

    await service.dispose();
    sqlite.close();
  });
});
