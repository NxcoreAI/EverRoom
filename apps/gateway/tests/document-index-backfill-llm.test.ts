import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@nxcore/agent-runtime";

import {
  VERIFY_CONFIDENCE_THRESHOLD,
  buildJudgePrompt,
  buildVerifyPrompt,
  filterJudgeVerdicts,
  filterVerifyVerdicts,
  IndexBackfillLlm,
  IndexBackfillLlmError,
  JUDGE_CONFIDENCE_THRESHOLD,
  parseJudgeResponse,
  parseJudgeSourceId,
  parseVerifyResponse,
} from "../src/modules/documents/index-backfill/llm.js";

const INPUT = {
  paragraphs: [
    { ordinal: 0, normalized: "PyTorch 支持动态计算图与自动求导，本文总结其核心特性。" },
    { ordinal: 3, normalized: "张量系统是 PyTorch 的基础抽象。" },
  ],
  documents: [
    { blockId: "block-1", documentTitle: "来源甲", textPreview: "动态计算图与自动求导的介绍" },
    { blockId: "block-2", documentTitle: "来源乙", textPreview: "张量系统介绍" },
  ],
  memories: [
    { memoryId: "room-1-memory-1", type: "事实", content: "用户偏好中文技术文档" },
  ],
};

/** invokeRuntime 兼容的最小 fake runtime（writing-style-llm 同款）。 */
function fakeRuntime(respond: (prompt: string) => string): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = [];
  const runtime = {
    id: "fake-index-backfill",
    getCapabilities: async () => ({ streaming: false, reasoning: false, tools: false, steering: false, resume: false }),
    start: async (input: { prompt: string }) => {
      calls.push(input.prompt);
      return {
        runtimeSessionRef: null,
        events: (async function* generate() {
          yield { type: "message.completed", payload: { content: respond(input.prompt) } };
          yield { type: "run.completed", payload: {} };
        })(),
      };
    },
    cancel: async () => undefined,
    deleteSession: async () => undefined,
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

describe("index backfill llm", () => {
  it("builds a prompt with both candidate sections, budget caps, and the untrusted-data warning", () => {
    const prompt = buildJudgePrompt({
      paragraphs: Array.from({ length: 35 }, (_, index) => ({ ordinal: index, normalized: "段".repeat(10) })),
      documents: Array.from({ length: 50 }, (_, index) => ({
        blockId: `block-${index}`,
        documentTitle: "标题",
        textPreview: "预".repeat(20),
      })),
      memories: Array.from({ length: 30 }, (_, index) => ({
        memoryId: `room-1-memory-${index}`,
        type: "事实",
        content: "记".repeat(20),
      })),
    });
    expect(prompt).toContain("不可信数据");
    expect(prompt).toContain("宁缺毋滥");
    expect(prompt).toContain("【候选来源块】");
    expect(prompt).toContain("【候选记忆项】");
    // 预算裁剪：来源块 40、记忆项 24 封顶。
    expect(prompt).toContain("sourceId=doc:block-39");
    expect(prompt).not.toContain("sourceId=doc:block-40");
    expect(prompt).toContain("sourceId=mem:room-1-memory-23");
    expect(prompt).not.toContain("sourceId=mem:room-1-memory-24");
    expect(prompt.length).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("paragraphOrdinal");
  });

  it("parses fenced and prose-wrapped arrays and validates fields", () => {
    expect(parseJudgeResponse('[{"paragraphOrdinal":0,"sourceId":"doc:b","confidence":0.9}]'))
      .toEqual([{ paragraphOrdinal: 0, sourceId: "doc:b", confidence: 0.9 }]);
    expect(parseJudgeResponse('好的，结果如下：\n```json\n[{"paragraphOrdinal":0,"sourceId":"mem:m","confidence":1.7}]\n```'))
      .toEqual([{ paragraphOrdinal: 0, sourceId: "mem:m", confidence: 1 }]);
    expect(parseJudgeResponse('[{"paragraphOrdinal":0.5,"sourceId":"doc:b","confidence":1},2,{"sourceId":"doc:x"}]')).toEqual([]);
    expect(() => parseJudgeResponse("没有数组")).toThrow(IndexBackfillLlmError);
  });

  it("parses sourceId into kind-aware references and rejects malformed prefixes", () => {
    expect(parseJudgeSourceId("doc:block-7")).toEqual({ kind: "document", blockId: "block-7" });
    expect(parseJudgeSourceId("mem:room-1-memory-3")).toEqual({ kind: "memory", memoryId: "room-1-memory-3" });
    expect(parseJudgeSourceId("block-7")).toBeNull();
    expect(parseJudgeSourceId("doc:")).toBeNull();
    expect(parseJudgeSourceId("mem:")).toBeNull();
  });

  it("filters verdicts: threshold, sourceId whitelist across both kinds, ordinal scope, first-wins", () => {
    const verdicts = parseJudgeResponse(JSON.stringify([
      { paragraphOrdinal: 0, sourceId: "doc:block-1", confidence: 0.9 },
      { paragraphOrdinal: 3, sourceId: "mem:room-1-memory-1", confidence: JUDGE_CONFIDENCE_THRESHOLD },
      { paragraphOrdinal: 0, sourceId: "doc:block-2", confidence: 0.99 },
      { paragraphOrdinal: 0, sourceId: "doc:block-1", confidence: 0.5 },
      { paragraphOrdinal: 9, sourceId: "doc:block-1", confidence: 0.99 },
      { paragraphOrdinal: 3, sourceId: "doc:forged-id", confidence: 0.99 },
      { paragraphOrdinal: 3, sourceId: "block-2", confidence: 0.99 },
    ]));
    const filtered = filterJudgeVerdicts(verdicts, INPUT);
    expect(filtered).toEqual([
      { paragraphOrdinal: 0, sourceId: "doc:block-1", confidence: 0.9 },
      { paragraphOrdinal: 3, sourceId: "mem:room-1-memory-1", confidence: JUDGE_CONFIDENCE_THRESHOLD },
    ]);
  });

  it("judge retries once with feedback then throws on persistent garbage", async () => {
    const { runtime, calls } = fakeRuntime(() => "这不是 JSON");
    const llm = new IndexBackfillLlm(runtime);
    await expect(llm.judge(INPUT)).rejects.toThrow(IndexBackfillLlmError);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("上一次输出无法解析");
  });

  it("judge returns filtered verdicts on success", async () => {
    const { runtime } = fakeRuntime(() =>
      '[{"paragraphOrdinal":0,"sourceId":"doc:block-1","confidence":0.95},{"paragraphOrdinal":0,"sourceId":"doc:forged","confidence":1}]');
    const llm = new IndexBackfillLlm(runtime);
    await expect(llm.judge(INPUT)).resolves.toEqual([
      { paragraphOrdinal: 0, sourceId: "doc:block-1", confidence: 0.95 },
    ]);
  });
});

describe("index backfill verify", () => {
  const ENTRIES = [
    { index: 0, paragraph: "PyTorch 支持动态计算图与自动求导的改写表述。", sourceKind: "document" as const, sourceLabel: "来源甲", sourcePreview: "动态计算图与自动求导" },
    { index: 1, paragraph: "完全无关的新段落，讨论烹饪与旅行。", sourceKind: "memory" as const, sourceLabel: "事实", sourcePreview: "用户偏好中文技术文档" },
  ];

  it("builds a verify prompt with per-entry sources, caps, and the untrusted-data warning", () => {
    const prompt = buildVerifyPrompt(Array.from({ length: 35 }, (_, index) => ({
      index,
      paragraph: "段".repeat(400),
      sourceKind: "document" as const,
      sourceLabel: `标题${index}`,
      sourcePreview: "预".repeat(300),
    })));
    expect(prompt).toContain("不可信数据");
    expect(prompt).toContain("宁可保留标记");
    expect(prompt).toContain("stillDerived");
    expect(prompt).toContain("《标题29》");
    expect(prompt).not.toContain("《标题30》");
    expect(prompt.length).toBeLessThanOrEqual(16_000);
  });

  it("parses verify responses leniently and validates fields", () => {
    expect(parseVerifyResponse('[{"index":0,"stillDerived":true,"confidence":0.7}]'))
      .toEqual([{ index: 0, stillDerived: true, confidence: 0.7 }]);
    expect(parseVerifyResponse('```json\n[{"index":1,"stillDerived":false,"confidence":2}]\n```'))
      .toEqual([{ index: 1, stillDerived: false, confidence: 1 }]);
    expect(parseVerifyResponse('[{"index":0,"stillDerived":"yes","confidence":1}]')).toEqual([]);
    expect(parseVerifyResponse('[{"index":0.5,"stillDerived":false,"confidence":1}]')).toEqual([]);
    expect(() => parseVerifyResponse("不是数组")).toThrow(IndexBackfillLlmError);
  });

  it("filters verify verdicts: index whitelist, low-confidence stillDerived=false dropped, first-wins", () => {
    const verdicts = parseVerifyResponse(JSON.stringify([
      { index: 0, stillDerived: true, confidence: 0.1 },
      { index: 1, stillDerived: false, confidence: 0.9 },
      { index: 1, stillDerived: true, confidence: 1 },
      { index: 1, stillDerived: false, confidence: 0.5 },
      { index: 9, stillDerived: false, confidence: 0.99 },
    ]));
    expect(filterVerifyVerdicts(verdicts, ENTRIES)).toEqual([
      { index: 0, stillDerived: true, confidence: 0.1 },
      { index: 1, stillDerived: false, confidence: 0.9 },
    ]);
    expect(VERIFY_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it("verify retries once with feedback then throws on persistent garbage", async () => {
    const { runtime, calls } = fakeRuntime(() => " garbage ");
    const llm = new IndexBackfillLlm(runtime);
    await expect(llm.verify(ENTRIES)).rejects.toThrow(IndexBackfillLlmError);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("上一次输出无法解析");
  });

  it("verify returns filtered verdicts on success", async () => {
    const { runtime } = fakeRuntime(() =>
      '[{"index":1,"stillDerived":false,"confidence":0.95},{"index":0,"stillDerived":true,"confidence":0.6}]');
    const llm = new IndexBackfillLlm(runtime);
    await expect(llm.verify(ENTRIES)).resolves.toEqual([
      { index: 1, stillDerived: false, confidence: 0.95 },
      { index: 0, stillDerived: true, confidence: 0.6 },
    ]);
  });
});
