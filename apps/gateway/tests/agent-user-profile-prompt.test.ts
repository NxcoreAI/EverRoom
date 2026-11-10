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

/**
 * 用户画像注入：每轮 run 把画像文本交给 runtime，由 runtime 拼进 system prompt。
 * 这里只钉住网关这一环（start input 里带上了、没画像时不带、provider 抛错不影响对话），
 * runtime 侧如何拼 prompt 由 `@nxcore/agent-runtime-pi` 自己的用例覆盖。
 */

const temporaryDirectories: string[] = [];

class RecordingRuntime implements AgentRuntime {
  readonly starts: StartRuntimeRunInput[] = [];
  /** createSession 会把 runtime id 落库（agent_sessions.runtime_id NOT NULL）。 */
  readonly id = "pi:main";

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input);
    const events = new AsyncEventQueue<RuntimeEvent>();
    events.push({ type: "run.completed", payload: {} });
    events.end();
    return { runId: input.runId, runtimeSessionRef: `primary-${input.sessionId}`, events };
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
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-profile-prompt-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const runtime = new RecordingRuntime();
  const service = new AgentService(database.db, runtime, new AgentEventBroker());
  return { ...database, runtime, service };
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

describe("用户画像注入 system prompt", () => {
  it("每轮 run 把画像文本带进 start input", async () => {
    const { service, runtime, sqlite } = await createHarness();
    service.setUserProfileProvider(() => "【用户画像】\n- 职业：前端负责人");

    const session = service.createSession({ pageLabel: "Home", roomId: null });
    await service.startRun(session.id, { prompt: "继续", idempotencyKey: "profile-run-1", context: {} });
    await settle();

    expect(runtime.starts[0]?.userProfilePrompt).toBe("【用户画像】\n- 职业：前端负责人");
    await service.dispose();
    sqlite.close();
  });

  it("没有画像时不带该字段（不塞空串，避免各 runtime 各自解释空值）", async () => {
    const { service, runtime, sqlite } = await createHarness();
    service.setUserProfileProvider(() => null);

    const session = service.createSession({ pageLabel: "Home", roomId: null });
    await service.startRun(session.id, { prompt: "继续", idempotencyKey: "profile-run-2", context: {} });
    await settle();

    expect("userProfilePrompt" in (runtime.starts[0] ?? {})).toBe(false);
    await service.dispose();
    sqlite.close();
  });

  it("provider 抛错只当作没有画像，对话照常开始", async () => {
    const { service, runtime, sqlite } = await createHarness();
    service.setUserProfileProvider(() => { throw new Error("memory store broken") });

    const session = service.createSession({ pageLabel: "Home", roomId: null });
    await service.startRun(session.id, { prompt: "继续", idempotencyKey: "profile-run-3", context: {} });
    await settle();

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.userProfilePrompt).toBeUndefined();
    await service.dispose();
    sqlite.close();
  });

  it("画像更新后下一轮立即生效（不用重开会话）", async () => {
    const { service, runtime, sqlite } = await createHarness();
    let profile = "【用户画像】\n- 偏好：简体中文";
    service.setUserProfileProvider(() => profile);

    const session = service.createSession({ pageLabel: "Home", roomId: null });
    await service.startRun(session.id, { prompt: "第一轮", idempotencyKey: "profile-run-4a", context: {} });
    await settle();

    profile = "【用户画像】\n- 偏好：简体中文\n- 职业：前端负责人";
    await service.startRun(session.id, { prompt: "第二轮", idempotencyKey: "profile-run-4b", context: {} });
    await settle();

    expect(runtime.starts[1]?.userProfilePrompt).toContain("职业：前端负责人");
    await service.dispose();
    sqlite.close();
  });
});
