import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilterRulesStore } from "../src/modules/ingest/rules.js";
import { FilterInsightJob } from "../src/modules/ingest/rules-insight.js";
import { ingestEvents } from "../src/infrastructure/database/schema.js";
import type { MemoryService } from "../src/modules/memory/service.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";
import type { KnowledgeLlm } from "../src/modules/knowledge/llm.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger = pino({ level: "silent" });

async function harness(options: {
  llmResponse?: string;
  llmFails?: boolean;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-filter-insight-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const rulesFile = join(dataDir, "ingest", "filter-rules.md");
  const rules = new FilterRulesStore({ filePath: rulesFile, maxBytes: 2048 }, silentLogger);
  await rules.updatePreference("- 默认偏好");
  const memory = {
    readCore: vi.fn().mockResolvedValue({ content: "用户是 EverRoom 的开发者", version: 1, updatedAt: "2026-08-21T00:00:00Z" }),
    listAtomic: vi.fn().mockResolvedValue({ items: [
      { id: "a1", type: "instruction", content: "技术决策要记录", background: null, createdAt: "", updatedAt: "" },
    ], total: 1 }),
  } as unknown as MemoryService;
  const knowledge = {
    enabled: true,
    listRoomWikis: vi.fn().mockReturnValue([
      { roomId: "room-1", knowledgeId: "wiki-1", status: "active", createdAt: new Date() },
      { roomId: "room-2", knowledgeId: "wiki-2", status: "archived", createdAt: new Date() },
    ]),
    listRoomWikiPages: vi.fn().mockResolvedValue({ status: "ready", items: [
      { id: "p1", title: "EverRoom 架构", type: "page", path: "wiki/a.md" },
      { id: "p2", title: "记忆系统设计", type: "page", path: "wiki/b.md" },
    ], pageCount: 2 }),
  } as unknown as KnowledgeService;
  const llm = {
    chatForFilterInsight: options.llmFails
      ? vi.fn().mockRejectedValue(new Error("llm down"))
      : vi.fn().mockResolvedValue(options.llmResponse ?? "- 用户关注 EverRoom 开发\n- 不关心营销内容"),
  } as unknown as KnowledgeLlm;
  const job = new FilterInsightJob(db, memory, knowledge, llm, rules, { enabled: true, intervalMs: 3_600_000 }, silentLogger);
  return { job, rules, rulesFile, db, sqlite, memory, knowledge, llm };
}

describe("FilterInsightJob", () => {
  it("refreshNow 蒸馏素材重写洞察段，偏好段不动", async () => {
    const { job, rules, sqlite } = await harness({});
    await job.refreshNow();
    const view = await rules.load();
    expect(view.insight).toContain("EverRoom 开发");
    expect(view.preference).toBe("- 默认偏好");
    sqlite.close();
  });

  it("LLM 输出超长被防御截断至 600 字", async () => {
    const { job, rules, sqlite } = await harness({ llmResponse: `长${"文".repeat(1000)}` });
    await job.refreshNow();
    const view = await rules.load();
    expect(view.insight.length).toBeLessThanOrEqual(601); // 600 + 可能的截断字符
    sqlite.close();
  });

  it("LLM 失败保留旧洞察（fail-safe）", async () => {
    const { job, rules, sqlite } = await harness({ llmFails: true });
    await expect(job.refreshNow()).resolves.toBeUndefined();
    const view = await rules.load();
    // 从未成功写入：保持骨架占位（或既有洞察），绝不变空、绝不变垃圾
    expect(view.insight).not.toContain("llm down");
    sqlite.close();
  });

  it("误杀样本进入素材（informative=false 的 passed 事件）", async () => {
    const { job, db, sqlite, llm } = await harness({});
    // 直接插一条台账行：verdict.informative=false 且已 passed = 曾被误杀后恢复
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
      originChannel: "connector",
    }).run();
    await job.refreshNow();
    const call = (llm as unknown as { chatForFilterInsight: ReturnType<typeof vi.fn> }).chatForFilterInsight.mock.calls[0];
    const prompt = call?.[0] as string;
    expect(prompt).toContain("误杀的决策邮件");
    sqlite.close();
  });

  it("素材全空时不调 LLM（省成本）", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-filter-insight-empty-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const rules = new FilterRulesStore({ filePath: join(dataDir, "f.md"), maxBytes: 2048 }, silentLogger);
    const memory = {
      readCore: vi.fn().mockResolvedValue({ content: null, version: 0, updatedAt: "" }),
      listAtomic: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as MemoryService;
    const llm = { chatForFilterInsight: vi.fn() } as unknown as KnowledgeLlm;
    const job = new FilterInsightJob(db, memory, null, llm, rules, { enabled: true, intervalMs: 3_600_000 }, silentLogger);
    await job.refreshNow();
    expect((llm as unknown as { chatForFilterInsight: ReturnType<typeof vi.fn> }).chatForFilterInsight).not.toHaveBeenCalled();
    sqlite.close();
  });
});
