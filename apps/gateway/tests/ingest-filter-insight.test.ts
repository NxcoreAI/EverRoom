import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilterRulesStore } from "../src/modules/ingest/rules.js";
import { FilterInsightJob } from "../src/modules/ingest/rules-insight.js";
import { ingestEvents } from "../src/infrastructure/database/schema.js";
import type { AgentRuntime, RuntimeRun } from "@nxcore/agent-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger = pino({ level: "silent" });

/** 无头 runtime 桩：start 返回单条 message.completed + run.completed 的事件流。 */
function runtimeStub(content: string | Error) {
  const start = vi.fn(async (_input: unknown) => {
    if (content instanceof Error) throw content;
    const events = (async function* () {
      yield { type: "message.completed", payload: { content } };
      yield { type: "run.completed", payload: {} };
    })();
    return {
      runId: "run-1",
      runtimeSessionRef: "session-ref-1",
      events,
    } as RuntimeRun;
  });
  const deleteSession = vi.fn(async () => undefined);
  return { runtime: { start, deleteSession } as unknown as AgentRuntime, start, deleteSession };
}

async function harness(options: {
  agentContent?: string;
  agentFails?: boolean;
  withAgent?: boolean;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-filter-insight-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const rulesFile = join(dataDir, "ingest", "filter-rules.md");
  const rules = new FilterRulesStore({ filePath: rulesFile, maxBytes: 2048 }, silentLogger);
  await rules.updatePreference("- 默认偏好");
  let stub: ReturnType<typeof runtimeStub> | null = null;
  if (options.withAgent) {
    stub = runtimeStub(options.agentFails ? new Error("agent down") : (options.agentContent ?? "- agent 产物"));
  }
  const job = new FilterInsightJob(
    db, stub?.runtime ?? null, rules,
    { enabled: true, intervalMs: 3_600_000 }, silentLogger,
  );
  return { job, rules, rulesFile, db, sqlite, stub };
}

describe("FilterInsightJob（agent 单路径）", () => {
  it("产出写入洞察段，偏好段不动；一次性会话 + 记忆隔离断言", async () => {
    const { job, rules, sqlite, stub } = await harness({
      withAgent: true, agentContent: "- agent 产物：用户关注 EverRoom",
    });
    await job.refreshNow();
    const view = await rules.load();
    expect(view.insight).toContain("agent 产物");
    expect(view.preference).toBe("- 默认偏好");
    // 一次性会话：run 完即删
    expect(stub!.deleteSession).toHaveBeenCalledWith("session-ref-1");
    const firstCall = stub!.start.mock.calls[0];
    const startInput = firstCall?.[0] as unknown as { sessionId: string; captureMemory: boolean; recallMemory: boolean };
    expect(startInput.sessionId).toMatch(/^ingest-filter-insight:/);
    expect(startInput.captureMemory).toBe(false);
    expect(startInput.recallMemory).toBe(false);
    sqlite.close();
  });

  it("agent 失败：保留旧洞察（无 LLM 降级路径）", async () => {
    const { job, rules, sqlite } = await harness({ withAgent: true, agentFails: true });
    await expect(job.refreshNow()).resolves.toBeUndefined();
    const view = await rules.load();
    // 骨架占位原样保留，绝不变空、绝不变垃圾
    expect(view.insight).not.toContain("down");
    sqlite.close();
  });

  it("无 runtime：静默跳过（保留旧洞察）", async () => {
    const { job, rules, sqlite } = await harness({});
    await expect(job.refreshNow()).resolves.toBeUndefined();
    expect((await rules.load()).preference).toBe("- 默认偏好");
    sqlite.close();
  });

  it("输出超长被防御截断至 600 字", async () => {
    const { job, rules, sqlite } = await harness({ withAgent: true, agentContent: `长${"文".repeat(1000)}` });
    await job.refreshNow();
    const view = await rules.load();
    expect(view.insight.length).toBeLessThanOrEqual(601);
    sqlite.close();
  });

  it("误杀样本进入 prompt（reinstated_at 精确标记），未恢复的不进；素材指引含 L2/L3 不含 L1", async () => {
    const { job, db, sqlite, stub } = await harness({ withAgent: true });
    db.insert(ingestEvents).values({
      id: "evt-miskill",
      sourceKind: "mail",
      sourceId: "connector:gmail:c1:miskill",
      sourceVersion: 1,
      dataType: "mail",
      detectedBy: "extension",
      title: "误杀的决策邮件",
      contentHash: "hash-1",
      parsedId: "parsed-1",
      pipelines: { room: true, wiki: true, memory: true },
      filterStatus: "passed",
      filterVerdict: { informative: false, reason: "无信息量", category: "trivial", confidence: 0.9 },
      reinstatedAt: new Date(),
      originChannel: "connector",
    }).run();
    db.insert(ingestEvents).values({
      id: "evt-not-reinstated",
      sourceKind: "mail",
      sourceId: "connector:gmail:c1:observe-only",
      sourceVersion: 1,
      dataType: "mail",
      detectedBy: "extension",
      title: "observe 模式放行的噪音",
      contentHash: "hash-2",
      parsedId: "parsed-2",
      pipelines: { room: true, wiki: true, memory: true },
      filterStatus: "passed",
      filterVerdict: { informative: false, reason: "无信息量", category: "trivial", confidence: 0.9 },
      originChannel: "connector",
    }).run();
    await job.refreshNow();
    const call = stub!.start.mock.calls[0];
    const prompt = (call?.[0] as { prompt: string }).prompt;
    expect(prompt).toContain("误杀的决策邮件");
    expect(prompt).toContain("曾被判：无信息量");
    expect(prompt).not.toContain("observe 模式放行的噪音");
    // 素材域：L3 画像 + L2 场景 + wiki；明确排除 L1
    expect(prompt).toContain("L3 画像与 L2 场景");
    expect(prompt).toContain("不是偏好信号源");
    // agent 主路径不预取画像/wiki 快照（有工具自己查）
    expect(prompt).not.toContain("【用户核心画像");
    expect(prompt).not.toContain("【Wiki 页面标题清单");
    sqlite.close();
  });
});
