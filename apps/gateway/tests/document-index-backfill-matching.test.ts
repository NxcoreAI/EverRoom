import { describe, expect, it } from "vitest";
import { normalizeIndexText, tiptapText } from "@nxcore/document-model";

import {
  applyMarkRemovals,
  applyPlannedMarks,
  buildIndexMarkNode,
  collectExistingMarks,
  collectParagraphTargets,
  isDriftSuspect,
  matchDeterministic,
  type IndexMemoryCandidate,
  type IndexSourceCandidate,
  type PlannedMarkRemoval,
  type PlannedIndexMark,
} from "../src/modules/documents/index-backfill/matching.js";

function paragraph(id: string | null, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "paragraph",
    ...(id ? { attrs: { id } } : {}),
    content: [{ type: "text", text }],
    ...extra,
  };
}

function candidate(overrides: Partial<IndexSourceCandidate> = {}): IndexSourceCandidate {
  return {
    roomId: "room-1",
    documentId: "doc-source",
    blockId: "block-1",
    documentTitle: "来源文档",
    textPreview: "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，支持动态计算图与自动求导。",
    probe: "PyTorch是一种基于Torch的开源深度学习框架，由MetaAI维护，支持动态计算图与自动求导。".slice(0, 80),
    sourceCreatedAt: 1_000,
    ...overrides,
  };
}

const SOURCE_TEXT = "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，支持动态计算图与自动求导、张量系统与 Python 优先的设计哲学。";

const MEMORY_CONTENT = "团队约定：深度学习相关文档统一使用 PyTorch 作为示例框架，示例代码必须可独立运行。";

function memoryCandidate(overrides: Partial<IndexMemoryCandidate> = {}): IndexMemoryCandidate {
  return {
    roomId: "room-1",
    memoryId: "room-1-memory-1",
    type: "事实",
    content: MEMORY_CONTENT,
    probe: "团队约定：深度学习相关文档统一使用PyTorch作为示例框架，示例代码必须可独立运行。".slice(0, 80),
    ...overrides,
  };
}

describe("index backfill matching", () => {
  it("collects eligible top-level paragraphs only", () => {
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: SOURCE_TEXT }] },
        paragraph("p1", SOURCE_TEXT),
        paragraph("p2", "太短的段落"),
        paragraph("p3", `${SOURCE_TEXT}尾注`, { content: [
          { type: "text", text: `${SOURCE_TEXT}尾注` },
          { type: "blockIndexMark", attrs: { kind: "document" } },
        ] }),
        { type: "codeBlock", content: [{ type: "text", text: SOURCE_TEXT }] },
      ],
    };
    const targets = collectParagraphTargets(content);
    expect(targets.map((target) => target.blockId)).toEqual(["p1"]);
    expect(targets[0]!.ordinal).toBe(1);
    expect(targets[0]!.normalized).not.toMatch(/\s/);
  });

  it("matches deterministically and prefers the longest probe, then the older source", () => {
    const long = candidate({ blockId: "long", probe: "a".repeat(80), sourceCreatedAt: 2_000 });
    const short = candidate({ blockId: "short", probe: "a".repeat(40), sourceCreatedAt: 1_000 });
    const older = candidate({ blockId: "older", probe: "a".repeat(80), sourceCreatedAt: 500 });
    const targets = collectParagraphTargets({
      type: "doc",
      content: [paragraph("p1", `${" a".repeat(100)}命中长探针的段落，内容足够长以通过下限校验。`)],
    });
    const planned = matchDeterministic(targets, [short, long, older]);
    expect(planned.get(0)).toMatchObject({ blockId: "older" });
  });

  it("matches a verbatim memory candidate and prefers a longer document probe on equal length", () => {
    const targets = collectParagraphTargets({
      type: "doc",
      content: [paragraph("p1", `${MEMORY_CONTENT}这条约定已写入团队文档。`)],
    });
    // 逐字包含记忆内容 → 命中记忆候选。
    const memoryOnly = matchDeterministic(targets, [memoryCandidate()]);
    expect(memoryOnly.get(0)).toMatchObject({ memoryId: "room-1-memory-1", type: "事实" });

    // 记忆改写（非逐字）不命中——记忆候选只接受逐字包含。
    const paraphrased = memoryCandidate({ probe: "深度学习文档一律选用PyTorch写示例" });
    expect(matchDeterministic(targets, [paraphrased]).get(0)).toBeUndefined();

    // 同长探针：文档候选优先（有方向启发式背书），更长探针仍赢过文档。
    const tieDoc = candidate({ probe: memoryCandidate().probe, sourceCreatedAt: 1_000 });
    expect(matchDeterministic(targets, [memoryCandidate(), tieDoc]).get(0)).toMatchObject({ blockId: "block-1" });
    const longerMemory = memoryCandidate({ memoryId: "mem-long", probe: `${memoryCandidate().probe}这条约定已写入` });
    expect(matchDeterministic(targets, [tieDoc, longerMemory]).get(0)).toMatchObject({ memoryId: "mem-long" });
  });

  it("builds mark nodes with the canonical attrs shape", async () => {
    expect(buildIndexMarkNode(candidate({ documentTitle: "很长的标题".repeat(50) }))).toEqual({
      type: "blockIndexMark",
      attrs: {
        kind: "document",
        targetRoomId: "room-1",
        targetDocumentId: "doc-source",
        targetBlockId: "block-1",
        targetMemoryId: "",
        fallbackTitle: "很长的标题".repeat(50).slice(0, 120),
        fallbackPreview: candidate().textPreview,
      },
    });
    expect(buildIndexMarkNode(memoryCandidate())).toEqual({
      type: "blockIndexMark",
      attrs: {
        kind: "memory",
        targetRoomId: "room-1",
        targetDocumentId: "",
        targetBlockId: "",
        targetMemoryId: "room-1-memory-1",
        fallbackTitle: "事实",
        fallbackPreview: MEMORY_CONTENT,
      },
    });
  });

  it("applies planned marks by blockId and leaves content untouched when nothing applies", () => {
    const content = { type: "doc", content: [paragraph("p1", SOURCE_TEXT), paragraph("p2", SOURCE_TEXT)] };
    const planned: PlannedIndexMark[] = [
      { paragraphBlockId: "p2", paragraphOrdinal: 1, candidate: candidate() },
      { paragraphBlockId: "gone", paragraphOrdinal: 9, candidate: candidate() },
    ];
    const applied = applyPlannedMarks(content, planned);
    expect(applied.applied).toBe(1);
    expect(applied.documentMarks).toBe(1);
    expect(applied.memoryMarks).toBe(0);
    expect(applied.content.content?.[1]?.content?.at(-1)).toMatchObject({ type: "blockIndexMark" });
    // 原树不被修改。
    expect(content.content?.[1]?.content).toHaveLength(1);

    const untouched = applyPlannedMarks(content, []);
    expect(untouched.applied).toBe(0);
    expect(untouched.content).toEqual(content);

    const memoryPlanned = applyPlannedMarks(content, [
      { paragraphBlockId: "p1", paragraphOrdinal: 0, candidate: memoryCandidate() },
    ]);
    expect(memoryPlanned.applied).toBe(1);
    expect(memoryPlanned.documentMarks).toBe(0);
    expect(memoryPlanned.memoryMarks).toBe(1);
  });

  it("collects existing marks with paragraph context and original probes", () => {
    const markAttrs = (overrides: Record<string, unknown> = {}) => ({
      kind: "document",
      targetRoomId: "room-1",
      targetDocumentId: "doc-source",
      targetBlockId: "block-1",
      targetMemoryId: "",
      fallbackTitle: "来源文档",
      fallbackPreview: SOURCE_TEXT,
      ...overrides,
    });
    const content = {
      type: "doc",
      content: [
        paragraph("p1", SOURCE_TEXT, { content: [
          { type: "text", text: SOURCE_TEXT },
          { type: "blockIndexMark", attrs: markAttrs() },
          { type: "blockIndexMark", attrs: markAttrs({ kind: "memory", targetDocumentId: "", targetBlockId: "", targetMemoryId: "room-1-memory-1", fallbackPreview: "太短" }) },
        ] }),
        { type: "heading", attrs: { level: 1 }, content: [
          { type: "blockIndexMark", attrs: markAttrs() },
        ] },
        paragraph("p2", "没有标记的段落，长度补齐以示区别。"),
      ],
    };
    const marks = collectExistingMarks(content);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      paragraphBlockId: "p1",
      paragraphOrdinal: 0,
      markIndex: 1,
      kind: "document",
      targetDocumentId: "doc-source",
      targetMemoryId: "",
    });
    expect(marks[0]!.paragraphNormalized).toBe(normalizeIndexText(tiptapText(content.content?.[0]!)));
    expect(marks[0]!.originalProbe).toBeTruthy();
    // 预览过短 → originalProbe 为 null（漂移门不可据此判定）。
    expect(marks[1]).toMatchObject({ markIndex: 2, kind: "memory", targetMemoryId: "room-1-memory-1", originalProbe: null });
    // heading 内的标记不在顶层段落，不收集。
  });

  it("flags drift only when neither the original nor the current probe is contained", () => {
    const mark = collectExistingMarks({
      type: "doc",
      content: [paragraph("p1", SOURCE_TEXT, { content: [
        { type: "text", text: SOURCE_TEXT },
        { type: "blockIndexMark", attrs: {
          kind: "document",
          targetDocumentId: "doc-source",
          targetBlockId: "block-1",
          targetMemoryId: "",
          fallbackPreview: SOURCE_TEXT,
        } },
      ] }),
      ],
    })[0]!;
    const paragraphNormalized = mark.paragraphNormalized;
    const currentProbe = "当前来源块换了 completely different 主题内容的一段全新文本探针，足够长。".slice(0, 80);

    // 段落仍含原文探针 → 不是漂移。
    expect(isDriftSuspect(mark, paragraphNormalized, currentProbe)).toBe(false);
    // 段落含当前探针 → 不是漂移。
    expect(isDriftSuspect(mark, `${currentProbe}的延续`, currentProbe)).toBe(false);
    // 双探针都不含 → 漂移候选。
    expect(isDriftSuspect(mark, "与来源毫无关系的全新段落文本，讨论完全不同的话题内容足够长以判读。", currentProbe)).toBe(true);
    // 双探针都取不到 → 不可判，不判漂移（宁留勿删）。
    expect(isDriftSuspect({ ...mark, originalProbe: null }, "与来源毫无关系的全新段落文本，讨论完全不同的话题内容足够长以判读。", null)).toBe(false);
  });

  it("applies mark removals by paragraph and target identity, leaving the original tree untouched", () => {
    const markAttrs = (overrides: Record<string, unknown> = {}) => ({
      kind: "document",
      targetDocumentId: "doc-source",
      targetBlockId: "block-1",
      targetMemoryId: "",
      ...overrides,
    });
    const content = { type: "doc", content: [
      paragraph("p1", SOURCE_TEXT, { content: [
        { type: "text", text: SOURCE_TEXT },
        { type: "blockIndexMark", attrs: markAttrs() },
        { type: "blockIndexMark", attrs: markAttrs({ targetBlockId: "block-2" }) },
      ] }),
      paragraph("p2", SOURCE_TEXT, { content: [
        { type: "text", text: SOURCE_TEXT },
        { type: "blockIndexMark", attrs: markAttrs({ targetBlockId: "block-2" }) },
      ] }),
    ] };
    const removals: PlannedMarkRemoval[] = [
      { paragraphBlockId: "p1", paragraphOrdinal: 0, kind: "document", targetDocumentId: "doc-source", targetBlockId: "block-1", targetMemoryId: "", reason: "document_gone" },
      // p1 的 block-2 标记不受影响；p2 的 block-2 被摘（目标身份不同段落独立）。
      { paragraphBlockId: "p2", paragraphOrdinal: 1, kind: "document", targetDocumentId: "doc-source", targetBlockId: "block-2", targetMemoryId: "", reason: "llm_not_derived" },
      // 段落不存在的条目被丢弃。
      { paragraphBlockId: "gone", paragraphOrdinal: 9, kind: "document", targetDocumentId: "doc-source", targetBlockId: "block-9", targetMemoryId: "", reason: "document_trashed" },
    ];
    const applied = applyMarkRemovals(content, removals);
    expect(applied.removed).toBe(2);
    const p1Marks = applied.content.content?.[0]?.content?.filter((child) => child.type === "blockIndexMark") ?? [];
    const p2Marks = applied.content.content?.[1]?.content?.filter((child) => child.type === "blockIndexMark") ?? [];
    expect(p1Marks).toHaveLength(1);
    expect(p1Marks[0]).toMatchObject({ attrs: { targetBlockId: "block-2" } });
    expect(p2Marks).toHaveLength(0);
    expect(applied.content.content?.[1]?.content?.[0]).toMatchObject({ type: "text" });
    // 原树不动。
    expect(content.content?.[0]?.content).toHaveLength(3);
    expect(content.content?.[1]?.content).toHaveLength(2);
  });

  it("skips paragraphs that already carry a mark when applying", () => {
    const content = { type: "doc", content: [paragraph("p1", SOURCE_TEXT)] };
    const once = applyPlannedMarks(content, [
      { paragraphBlockId: "p1", paragraphOrdinal: 0, candidate: candidate() },
    ]);
    const twice = applyPlannedMarks(once.content, [
      { paragraphBlockId: "p1", paragraphOrdinal: 0, candidate: candidate({ blockId: "other" }) },
    ]);
    expect(twice.applied).toBe(0);
    // 仍是文本 + 标记两节点,没有被追加第二个标记。
    expect(twice.content.content?.[0]?.content).toHaveLength(2);
  });
});
