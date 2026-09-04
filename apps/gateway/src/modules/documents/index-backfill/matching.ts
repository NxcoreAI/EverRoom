import type { TiptapJsonContent } from "@nxcore/agent-contract";
import {
  buildIndexProbe,
  documentBodyContent,
  normalizeIndexText,
  tiptapText,
} from "@nxcore/document-model";

import { BLOCK_INDEX_MARK_NODE } from "../block-index-mark.js";

/** 段落归一化文本低于此值跳过：太短的段落匹配必然是误配。 */
const MIN_PARAGRAPH_LENGTH = 40;
/** 候选来源文档封顶（createdAt asc），超大 Room 取最早的。 */
const MAX_SOURCE_DOCUMENTS = 50;
/** 候选来源块全 Room 封顶。 */
const MAX_SOURCE_BLOCKS = 200;
/** 候选记忆项封顶（记忆量级远小于文档块，实际很少触顶）。 */
const MAX_MEMORY_ITEMS = 50;

export interface IndexSourceCandidate {
  roomId: string;
  documentId: string;
  blockId: string;
  documentTitle: string;
  textPreview: string;
  probe: string;
  sourceCreatedAt: number;
}

/**
 * 记忆项候选（contextRooms.data.memoryItems 投影）。记忆是蒸馏产物没有
 * 时间戳，方向启发式不适用；逐字包含级匹配本身高精度，精度由匹配算法
 * 与 LLM 置信护栏兜住。
 */
export interface IndexMemoryCandidate {
  roomId: string;
  memoryId: string;
  type: string;
  content: string;
  probe: string;
}

export type IndexCandidate = IndexSourceCandidate | IndexMemoryCandidate;

export function isMemoryCandidate(candidate: IndexCandidate): candidate is IndexMemoryCandidate {
  return "memoryId" in candidate;
}

export interface IndexParagraphTarget {
  node: TiptapJsonContent;
  /** 顶层序号，仅供 LLM 交互使用；落库对位用 blockId。 */
  ordinal: number;
  blockId: string | null;
  normalized: string;
}

export interface PlannedIndexMark {
  paragraphBlockId: string | null;
  paragraphOrdinal: number;
  candidate: IndexCandidate;
}

/**
 * 枚举目标文档中可挂索引的顶层段落：仅 paragraph（heading/list/blockquote/
 * table/codeBlock 天然排除），已含任何 blockIndexMark 的段落跳过（每段一标），
 * 归一化文本过短跳过。
 */
export function collectParagraphTargets(content: TiptapJsonContent): IndexParagraphTarget[] {
  const targets: IndexParagraphTarget[] = [];
  const children = documentBodyContent(content).content ?? [];
  children.forEach((node, ordinal) => {
    if (node.type !== "paragraph") return;
    const normalized = normalizeIndexText(tiptapText(node));
    if (normalized.length < MIN_PARAGRAPH_LENGTH) return;
    if (containsIndexMark(node)) return;
    targets.push({
      node,
      ordinal,
      blockId: typeof node.attrs?.id === "string" && node.attrs.id ? node.attrs.id : null,
      normalized,
    });
  });
  return targets;
}

function containsIndexMark(node: TiptapJsonContent): boolean {
  if (node.type === BLOCK_INDEX_MARK_NODE) return true;
  return (node.content ?? []).some((child) => containsIndexMark(child));
}

/**
 * 确定性匹配：段落归一化文本包含候选 probe 即命中；多命中取 probe 最长者
 * （更具体），同长时文档候选优先（有方向启发式背书）、文档之间取来源更旧
 * 者，记忆候选同长取输入序（收集序稳定）。文档来源方向由调用方（createdAt
 * 严格早于目标）保证；记忆候选只接受逐字包含——蒸馏文本被整句复述才命中。
 */
export function matchDeterministic(
  targets: IndexParagraphTarget[],
  candidates: IndexCandidate[],
): Map<number, IndexCandidate> {
  const planned = new Map<number, IndexCandidate>();
  for (const target of targets) {
    let best: IndexCandidate | null = null;
    for (const candidate of candidates) {
      if (!target.normalized.includes(candidate.probe)) continue;
      if (!best || betterCandidate(candidate, best)) best = candidate;
    }
    if (best) planned.set(target.ordinal, best);
  }
  return planned;
}

function betterCandidate(challenger: IndexCandidate, incumbent: IndexCandidate): boolean {
  if (challenger.probe.length !== incumbent.probe.length) {
    return challenger.probe.length > incumbent.probe.length;
  }
  const challengerMemory = isMemoryCandidate(challenger);
  const incumbentMemory = isMemoryCandidate(incumbent);
  if (challengerMemory !== incumbentMemory) return incumbentMemory;
  if (!challengerMemory && !incumbentMemory) {
    return challenger.sourceCreatedAt < incumbent.sourceCreatedAt;
  }
  return false;
}

/** 构造追加到段末的 blockIndexMark 节点（attrs 形态与 headless 扩展一致）。 */
export function buildIndexMarkNode(candidate: IndexCandidate): TiptapJsonContent {
  if (isMemoryCandidate(candidate)) {
    return {
      type: BLOCK_INDEX_MARK_NODE,
      attrs: {
        kind: "memory",
        targetRoomId: candidate.roomId,
        targetDocumentId: "",
        targetBlockId: "",
        targetMemoryId: candidate.memoryId,
        fallbackTitle: candidate.type.slice(0, 120),
        fallbackPreview: candidate.content.slice(0, 240),
      },
    };
  }
  return {
    type: BLOCK_INDEX_MARK_NODE,
    attrs: {
      kind: "document",
      targetRoomId: candidate.roomId,
      targetDocumentId: candidate.documentId,
      targetBlockId: candidate.blockId,
      targetMemoryId: "",
      fallbackTitle: candidate.documentTitle.slice(0, 120),
      fallbackPreview: candidate.textPreview.slice(0, 240),
    },
  };
}

/**
 * 把计划好的标记追加到各段末尾（深拷贝后原位修改）。按段落 blockId（无 id 时
 * 退回 ordinal）对位；段落已不存在或已被标记则丢弃该条。返回实际追加数。
 *
 * 注意不能经 documentBodyContent 取子节点——stripDocumentTitle 内部会再克隆
 * 一次，返回的节点不属于本函数的克隆树；这里直接在克隆树 content 上原位改。
 */
export function applyPlannedMarks(
  content: TiptapJsonContent,
  planned: PlannedIndexMark[],
): { content: TiptapJsonContent; applied: number; documentMarks: number; memoryMarks: number } {
  const clone = structuredClone(content);
  const children = clone.content ?? [];
  let applied = 0;
  let documentMarks = 0;
  let memoryMarks = 0;
  for (const mark of planned) {
    const paragraph = children.find((node, ordinal) => node.type === "paragraph"
      && (mark.paragraphBlockId
        ? node.attrs?.id === mark.paragraphBlockId
        : ordinal === mark.paragraphOrdinal));
    if (!paragraph || containsIndexMark(paragraph)) continue;
    paragraph.content = [...(paragraph.content ?? []), buildIndexMarkNode(mark.candidate)];
    applied += 1;
    if (isMemoryCandidate(mark.candidate)) memoryMarks += 1;
    else documentMarks += 1;
  }
  return { content: clone, applied, documentMarks, memoryMarks };
}

export const INDEX_BACKFILL_MATCH_LIMITS = {
  minParagraphLength: MIN_PARAGRAPH_LENGTH,
  maxSourceDocuments: MAX_SOURCE_DOCUMENTS,
  maxSourceBlocks: MAX_SOURCE_BLOCKS,
  maxMemoryItems: MAX_MEMORY_ITEMS,
} as const;

export type MarkRemovalReason =
  | "document_gone"
  | "document_trashed"
  | "memory_missing"
  | "llm_not_derived";

/** 文档中已存在的 blockIndexMark 标记投影（复检阶段的输入）。 */
export interface ExistingIndexMark {
  paragraphBlockId: string | null;
  paragraphOrdinal: number;
  /** 标记节点在 paragraph.content 中的位置。 */
  markIndex: number;
  /** 所在段落的归一化文本（漂移门用）。 */
  paragraphNormalized: string;
  kind: string;
  targetDocumentId: string;
  targetBlockId: string;
  targetMemoryId: string;
  fallbackTitle: string;
  fallbackPreview: string;
  /** 挂标时原文的探针（fallbackPreview 前 80 归一化字符）；预览过短为 null。 */
  originalProbe: string | null;
}

/**
 * 收集文档中已挂的索引标记。不限段落长度（手动挂标没有阈值），每段可多条。
 */
export function collectExistingMarks(content: TiptapJsonContent): ExistingIndexMark[] {
  const marks: ExistingIndexMark[] = [];
  const children = documentBodyContent(content).content ?? [];
  children.forEach((node, ordinal) => {
    if (node.type !== "paragraph") return;
    (node.content ?? []).forEach((child, markIndex) => {
      if (child.type !== BLOCK_INDEX_MARK_NODE) return;
      const attrs = child.attrs ?? {};
      const fallbackPreview = typeof attrs.fallbackPreview === "string" ? attrs.fallbackPreview : "";
      marks.push({
        paragraphBlockId: typeof node.attrs?.id === "string" && node.attrs.id ? node.attrs.id : null,
        paragraphOrdinal: ordinal,
        markIndex,
        paragraphNormalized: normalizeIndexText(tiptapText(node)),
        kind: typeof attrs.kind === "string" ? attrs.kind : "document",
        targetDocumentId: typeof attrs.targetDocumentId === "string" ? attrs.targetDocumentId : "",
        targetBlockId: typeof attrs.targetBlockId === "string" ? attrs.targetBlockId : "",
        targetMemoryId: typeof attrs.targetMemoryId === "string" ? attrs.targetMemoryId : "",
        fallbackTitle: typeof attrs.fallbackTitle === "string" ? attrs.fallbackTitle : "",
        fallbackPreview,
        originalProbe: buildIndexProbe(fallbackPreview),
      });
    });
  });
  return marks;
}

/**
 * 漂移门：段落既不含挂标时原文探针、也不含当前目标文本探针 → 漂移候选
 * （交给 LLM 复验）。任一探针命中即不算漂移；两个探针都取不到则不可判，
 * 宁留勿删。
 */
export function isDriftSuspect(
  mark: ExistingIndexMark,
  paragraphNormalized: string,
  currentProbe: string | null,
): boolean {
  if (mark.originalProbe && paragraphNormalized.includes(mark.originalProbe)) return false;
  if (currentProbe && paragraphNormalized.includes(currentProbe)) return false;
  return mark.originalProbe != null || currentProbe != null;
}

/** 复检摘除计划；对位键 = 段落 blockId + 目标身份（CAS 重放时 markIndex 不可靠）。 */
export interface PlannedMarkRemoval {
  paragraphBlockId: string | null;
  paragraphOrdinal: number;
  kind: string;
  targetDocumentId: string;
  targetBlockId: string;
  targetMemoryId: string;
  reason: MarkRemovalReason;
}

function matchesRemoval(
  attrs: Record<string, unknown>,
  removal: PlannedMarkRemoval,
): boolean {
  return String(attrs.kind ?? "document") === removal.kind
    && String(attrs.targetDocumentId ?? "") === removal.targetDocumentId
    && String(attrs.targetBlockId ?? "") === removal.targetBlockId
    && String(attrs.targetMemoryId ?? "") === removal.targetMemoryId;
}

/**
 * 把摘除计划落到克隆树上：按段落 blockId（缺则 ordinal）定位段落，剔除身份
 * 匹配的标记节点；段落不存在或标记已被摘则丢弃该条。返回实际摘除数。
 */
export function applyMarkRemovals(
  content: TiptapJsonContent,
  planned: PlannedMarkRemoval[],
): { content: TiptapJsonContent; removed: number } {
  const clone = structuredClone(content);
  const children = clone.content ?? [];
  let removed = 0;
  for (const removal of planned) {
    const paragraph = children.find((node, ordinal) => node.type === "paragraph"
      && (removal.paragraphBlockId
        ? node.attrs?.id === removal.paragraphBlockId
        : ordinal === removal.paragraphOrdinal));
    if (!paragraph) continue;
    const before = paragraph.content?.length ?? 0;
    paragraph.content = (paragraph.content ?? []).filter(
      (child) => !(child.type === BLOCK_INDEX_MARK_NODE && matchesRemoval(child.attrs ?? {}, removal)),
    );
    removed += before - (paragraph.content?.length ?? 0);
  }
  return { content: clone, removed };
}
