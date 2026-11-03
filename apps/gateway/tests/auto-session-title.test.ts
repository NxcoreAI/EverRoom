import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  agentMessages,
  agentRuns,
  agentSessions,
  agentWorkspaces,
} from "../src/infrastructure/database/schema.js";
import { AgentEventBroker } from "../src/modules/agent/event-broker.js";
import { AgentService } from "../src/modules/agent/service.js";
import { AutoSessionTitles } from "../src/modules/processing/auto-session-title.js";
import type { SessionTitleInput } from "../src/modules/processing/session-title.js";

/**
 * 工作会话「LLM 总结标题」的服务端兜底（`docs/workspace-session-title.zh-CN.md`）。
 *
 * 渲染层是首选实现（对话面板开着时）；这里覆盖后台跑完 / 计划指派 / 面板没开的情况。
 * 共同前提：只有标题仍是「首条 prompt 截断」的自动占位时才替换。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class RecordingRuntime implements AgentRuntime {
  readonly id = "fake";

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    const events = new AsyncEventQueue<RuntimeEvent>();
    events.push({ type: "run.completed", payload: {} });
    events.end();
    return { runId: input.runId, runtimeSessionRef: `fake-${input.sessionId}`, events };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("not supported");
  }

  async sendInput(): Promise<void> {}
  async cancel(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const USER_PROMPT = "帮我整理这个季度的成本对比表，并核对物料单价";

async function createHarness(options: { workspaceId?: string | null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-session-title-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const now = new Date("2026-11-03T10:00:00.000Z");
  database.db.insert(agentWorkspaces).values({
    id: "ws-1",
    name: "成本分析",
    kind: "custom",
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  }).run();

  const workspaceId = options.workspaceId === undefined ? "ws-1" : options.workspaceId;
  database.db.insert(agentSessions).values({
    id: "s-1",
    workspaceId,
    pageLabel: "Agent",
    runtimeId: "fake",
    activeAgentId: "main",
    title: USER_PROMPT.slice(0, 48),
    status: "running",
    createdAt: now,
    updatedAt: now,
  }).run();
  database.db.insert(agentRuns).values({
    id: "run-1",
    sessionId: "s-1",
    agentId: "main",
    idempotencyKey: "key-1",
    prompt: USER_PROMPT,
    status: "running",
    startedAt: now,
    createdAt: now,
  }).run();
  database.db.insert(agentMessages).values([
    {
      id: "m-user",
      sessionId: "s-1",
      runId: "run-1",
      role: "user",
      content: USER_PROMPT,
      createdAt: now,
    },
    {
      id: "m-assistant",
      sessionId: "s-1",
      runId: "run-1",
      role: "assistant",
      content: "已整理出 Q3 成本对比表，并标出两处物料单价异常。",
      createdAt: new Date(now.getTime() + 1_000),
    },
  ]).run();

  const generate = vi.fn(async (_input: SessionTitleInput) => ({ title: "Q3 成本对比表核对" }));
  const titles = new AutoSessionTitles({ db: database.db, generate, delayMs: 0 });
  return { ...database, titles, generate, now };
}

function sessionTitle(database: ReturnType<typeof createDatabase>): string | null {
  return database.db
    .select({ title: agentSessions.title })
    .from(agentSessions)
    .where(eq(agentSessions.id, "s-1"))
    .get()?.title ?? null;
}

describe("AutoSessionTitles · 触发条件", () => {
  it("首次成功跑完：用一次 LLM 总结替换占位标题", async () => {
    const harness = await createHarness();
    harness.titles.schedule("s-1", "run-1");
    await settle();

    expect(harness.generate).toHaveBeenCalledTimes(1);
    const input = harness.generate.mock.calls[0]![0];
    expect(input.userText).toContain("成本对比表");
    expect(input.assistantText).toContain("物料单价异常");
    expect(input.language).toBe("zh-CN");
    expect(sessionTitle(harness)).toBe("Q3 成本对比表核对");
  });

  it("已经有过成功 run：不再总结（标题稳定，不重复花 LLM）", async () => {
    const harness = await createHarness();
    const now = harness.now;
    harness.db.insert(agentRuns).values({
      id: "run-0",
      sessionId: "s-1",
      agentId: "main",
      idempotencyKey: "key-0",
      prompt: "上一轮",
      status: "completed",
      startedAt: new Date(now.getTime() - 60_000),
      completedAt: new Date(now.getTime() - 50_000),
      createdAt: new Date(now.getTime() - 60_000),
    }).run();

    harness.titles.schedule("s-1", "run-1");
    await settle();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("用户改过名（标题已不是自动占位）：尊重既有命名", async () => {
    const harness = await createHarness();
    harness.db.update(agentSessions)
      .set({ title: "我自己的工作名" })
      .run();

    harness.titles.schedule("s-1", "run-1");
    await settle();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(sessionTitle(harness)).toBe("我自己的工作名");
  });

  it("工作空间外的会话（workspaceId 为空）：不做额外 LLM 开销", async () => {
    const harness = await createHarness({ workspaceId: null });
    harness.titles.schedule("s-1", "run-1");
    await settle();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("生成失败：静默保留占位标题，不抛错", async () => {
    const harness = await createHarness();
    harness.generate.mockRejectedValueOnce(new Error("title_runtime_unavailable"));

    expect(() => harness.titles.schedule("s-1", "run-1")).not.toThrow();
    await settle();
    expect(sessionTitle(harness)).toBe(USER_PROMPT.slice(0, 48));
  });

  it("生成期间标题被改：不覆盖用户/渲染层刚写的标题", async () => {
    const harness = await createHarness();
    harness.generate.mockImplementationOnce(async () => {
      harness.db.update(agentSessions).set({ title: "渲染层写的标题" }).run();
      return { title: "服务端总结标题" };
    });

    harness.titles.schedule("s-1", "run-1");
    await settle();
    expect(sessionTitle(harness)).toBe("渲染层写的标题");
  });

  it("延迟窗口内渲染层已写好标题：到期检查时直接让路", async () => {
    const harness = await createHarness();
    const delayed = new AutoSessionTitles({ db: harness.db, generate: harness.generate, delayMs: 40 });
    try {
      delayed.schedule("s-1", "run-1");
      // 模拟渲染层在 8 秒窗口内先完成改名。
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      harness.db.update(agentSessions).set({ title: "渲染层标题" }).run();
      await settle(60);
      expect(harness.generate).not.toHaveBeenCalled();
      expect(sessionTitle(harness)).toBe("渲染层标题");
    } finally {
      delayed.dispose();
    }
  });
});

describe("AutoSessionTitles · 与 AgentService 接线", () => {
  it("run.completed 触发回调，后台会话也能拿到总结标题", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-session-title-wire-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const now = new Date("2026-11-03T10:00:00.000Z");
    database.db.insert(agentWorkspaces).values({
      id: "ws-1",
      name: "成本分析",
      kind: "custom",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    }).run();

    const service = new AgentService(database.db, new RecordingRuntime(), new AgentEventBroker());
    const generate = vi.fn(async (_input: SessionTitleInput) => ({ title: "季度成本核对" }));
    const titles = new AutoSessionTitles({ db: database.db, generate, delayMs: 0 });
    service.setSessionTitleGenerator((sessionId, runId) => titles.schedule(sessionId, runId));

    const session = service.createSession({ pageLabel: "Agent", roomId: null, workspaceId: "ws-1" });
    await service.startRun(session.id, {
      prompt: "帮我核对一下这个季度的成本表",
      idempotencyKey: "wire-key-1",
    });
    await settle(80);

    expect(generate).toHaveBeenCalledTimes(1);
    const updated = service.listSessions(undefined, undefined, "ws-1").find((item) => item.id === session.id);
    expect(updated?.title).toBe("季度成本核对");
  });
});
