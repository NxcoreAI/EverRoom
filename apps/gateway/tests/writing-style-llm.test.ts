import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { documentVersions, documents, roomDocumentLinks } from "../src/infrastructure/database/schema.js";
import { WritingStyleService } from "../src/modules/writing-style/service.js";
import { WritingStyleLlm, parseQualitative, type WritingStyleEvidence } from "../src/modules/writing-style/llm.js";
import { analyzeWritingStyle } from "../src/modules/writing-style/analyzer.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

const QUALITATIVE_JSON = JSON.stringify({
  tone: ["冷静克制", "偏书面"],
  phrases: ["值得注意的是"],
  preferences: { do: ["短句收尾"], dont: ["避免长定语从句"] },
  examples: ["本文采用渐进披露原则，先给出最小可用集合。", "第二条范例句会被截断到八十字以内" + "长".repeat(100)],
  summary: "工程笔记型作者，重结构与可核查性。",
});

/** invokeRuntime 兼容的最小 fake runtime：依次返回预置响应。 */
function fakeRuntime(responses: string[]): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const runtime = {
    id: "fake-writing-style",
    getCapabilities: async () => ({ streaming: false, reasoning: false, tools: false, steering: false, resume: false }),
    start: async (input: { prompt: string }) => {
      calls.push(input.prompt);
      const content = responses[Math.min(index, responses.length - 1)] ?? "";
      index += 1;
      return {
        runtimeSessionRef: null,
        events: (async function* generate() {
          yield { type: "message.completed", payload: { content } };
          yield { type: "run.completed", payload: {} };
        })(),
      };
    },
    cancel: async () => undefined,
    deleteSession: async () => undefined,
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

async function setup(llm?: WritingStyleLlm): Promise<{ database: DatabaseClient; service: WritingStyleService }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-llm-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, service: new WritingStyleService(database.db, llm ?? null) };
}

function seedDocument(database: DatabaseClient, id: string, seed: string): void {
  const parts: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    parts.push(`${seed}${seed}模块的接口设计遵循渐进披露原则，先给出最小可用集合，再按需补充高级选项与回退说明。`);
  }
  const contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: parts.join("") }] }] };
  const now = new Date();
  database.db.insert(documents).values({
    id, title: id, contentJson, contentSchemaVersion: 3, version: 1, status: "active", createdAt: now, updatedAt: now,
  }).run();
  database.db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: id, linkedAt: now }).run();
  database.db.insert(documentVersions).values({
    id: `${id}-v1`, documentId: id, version: 1, title: id, contentJson, contentSchemaVersion: 3,
    sourceTransactionId: null, createdAt: now,
  }).run();
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.sqlite.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe("parseQualitative", () => {
  it("剥围栏并校验结构，收敛数组条数与长度", () => {
    const fenced = "```json\n" + QUALITATIVE_JSON + "\n```";
    const parsed = parseQualitative(fenced);
    expect(parsed.tone).toEqual(["冷静克制", "偏书面"]);
    expect(parsed.preferences.dont).toEqual(["避免长定语从句"]);
    expect(parsed.summary).toContain("工程笔记");
    // 原文范例（2026-09-02 修订）：≤2 条、每条 ≤80 字。
    expect(parsed.examples).toHaveLength(2);
    expect(parsed.examples[0]).toContain("渐进披露");
    expect(parsed.examples[1]!.length).toBeLessThanOrEqual(80);
  });

  it("非 JSON / 缺字段抛错（供重试反馈）；examples 缺省兼容旧库定性行", () => {
    expect(() => parseQualitative("不是 JSON")).toThrow();
    expect(() => parseQualitative('{"tone": "应是数组"}')).toThrow();
    expect(() => parseQualitative('{"tone": [], "phrases": []}')).not.toThrow();
    expect(parseQualitative('{"tone": [], "phrases": [], "summary": ""}').examples).toEqual([]);
  });

  it("提炼 prompt 携带规则化与原文范例要求（回归锚）", () => {
    const runtime = fakeRuntime([QUALITATIVE_JSON]);
    const llm = new WritingStyleLlm(runtime.runtime as never);
    const evidence: WritingStyleEvidence = {
      sections: { vocabulary: ["高频用词：使用"], sentence: [], structure: [] },
      supportedTokens: [],
      sketchCount: 3,
      charCount: 4000,
      evidenceLines: ["开篇：本文采用渐进披露原则。"],
    };
    void llm.summarize(evidence);
    const prompt = runtime.calls[0]!;
    expect(prompt).toContain("可以直接执行");
    expect(prompt).toContain("禁止纯形容词");
    expect(prompt).toContain("逐字复制");
    expect(prompt).toContain('"examples"');
  });
});

describe("analyzer 采样证据", () => {
  it("sketch 携带开篇/收尾/长短句与高频词用例", () => {
    const contentJson = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "以下是风控模块的设计概要。".repeat(20) }] },
        { type: "paragraph", content: [{ type: "text", text: "综上，接口按最小集合交付。" }] },
      ],
    };
    const stats = analyzeWritingStyle(contentJson);
    expect(stats.samples.openingExcerpt).toContain("设计概要");
    expect(stats.samples.closingExcerpt).toContain("综上");
    expect(stats.samples.longestSentence.length).toBeGreaterThanOrEqual(stats.samples.shortestSentence.length);
    expect(stats.samples.representativeSentences.length).toBeGreaterThan(0);
    expect(stats.samples.tokenExamples.some(([token]) => token.includes("风控") || token.length > 0)).toBe(true);
  });
});

describe("WritingStyleService LLM 定性层", () => {
  it("达到触发条件时写入定性结论并重组生成摘要", async () => {
    const { runtime, calls } = fakeRuntime([QUALITATIVE_JSON]);
    const { database, service } = await setup(new WritingStyleLlm(runtime));
    for (const id of ["doc-1", "doc-2", "doc-3"]) {
      seedDocument(database, id, `种子${id}`);
      service.extractDocument(id, "room-1", 1);
    }
    const result = await service.refreshProfile();
    expect(result.llm).toBe("updated");
    expect(calls).toHaveLength(1);
    // prompt 只送统计与采样证据，不送全文。
    expect(calls[0]).toContain("统计摘要");
    expect(calls[0]!.length).toBeLessThan(20_000);

    const profile = service.getProfile();
    expect(profile.sections.qualitative.join("")).toContain("冷静克制");
    expect(service.getProfileText().content).toContain("语气：冷静克制");
  });

  it("语料未变化时复用结论（cursor 命中 → skipped）", async () => {
    const { runtime, calls } = fakeRuntime([QUALITATIVE_JSON]);
    const { database, service } = await setup(new WritingStyleLlm(runtime));
    for (const id of ["doc-1", "doc-2", "doc-3"]) {
      seedDocument(database, id, `种子${id}`);
      service.extractDocument(id, "room-1", 1);
    }
    await service.refreshProfile();
    const second = await service.refreshProfile();
    expect(second.llm).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("样本不足（<3 篇）不触发", async () => {
    const { runtime, calls } = fakeRuntime([QUALITATIVE_JSON]);
    const { database, service } = await setup(new WritingStyleLlm(runtime));
    seedDocument(database, "doc-1", "种子");
    seedDocument(database, "doc-2", "种子");
    service.extractDocument("doc-1", "room-1", 1);
    service.extractDocument("doc-2", "room-1", 1);
    const result = await service.refreshProfile();
    expect(result.llm).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("LLM 两次失败 → 保留统计层与上次定性结论，结果标记 failed", async () => {
    const { runtime, calls } = fakeRuntime(["垃圾输出", "还是垃圾"]);
    const { database, service } = await setup(new WritingStyleLlm(runtime));
    for (const id of ["doc-1", "doc-2", "doc-3"]) {
      seedDocument(database, id, `种子${id}`);
      service.extractDocument(id, "room-1", 1);
    }
    const result = await service.refreshProfile();
    expect(result.llm).toBe("failed");
    expect(calls).toHaveLength(2); // 一次内部重试
    // 统计层照常落库。
    const profile = service.getProfile();
    expect(profile.sampleDocumentCount).toBe(3);
    expect(profile.sections.qualitative).toEqual([]);
    expect(service.getProfileText().content).not.toContain("语气：");
  });

  it("未配置 LLM → disabled，统计层正常", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1", "种子");
    service.extractDocument("doc-1", "room-1", 1);
    const result = await service.refreshProfile();
    expect(result.llm).toBe("disabled");
    expect(service.getProfile().sampleDocumentCount).toBe(1);
  });
});
