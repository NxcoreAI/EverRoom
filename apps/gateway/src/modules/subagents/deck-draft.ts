/**
 * deck-composer 子 Agent 的工具面支撑（DeckGen 比赛项目 W2）：
 * 主 Agent 的 deck_draft 工具与 write_append 引用转交（deck 草稿落 Context Doc）
 * 共用本文件的 DraftSpec 归一/校验与 markdown 渲染。契约唯一真源：
 * deckgen 仓 docs/contracts/draft-spec.schema.json（v1.0-rc1）。
 * 本文件只放与 orchestrator 无耦合的纯函数与常量（与 document-draft.ts 同构）。
 */
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { splitIntoAppendChunks } from "./document-draft.js";

export const DECK_COMPOSER_AGENT_ID = "deck-composer";
export const DECK_DRAFT_TASK_LABEL = "生成 PPT 草稿";

export const DECK_BLOCK_KINDS = ["claim", "evidence", "data", "quote", "visual"] as const;
export type DeckBlockKind = (typeof DECK_BLOCK_KINDS)[number];

export interface DeckDraftBlock {
  id: string;
  kind: DeckBlockKind;
  content: string;
  sourceRefs: string[];
}

export interface DeckDraftSpec {
  title: string;
  thesis: string | null;
  blocks: DeckDraftBlock[];
}

const BLOCK_ID_PATTERN = /^blk_[a-z0-9]+(_[a-z0-9]+)*$/;
const SOURCE_REF_PATTERN = /^everroom:\/\/(room\/[^/]+\/[^/]+\/[^/]+|memory\/[^/]+\/[^/]+)$/;
/** 契约（SKILL.md 规则 3）：这三类块的 sourceRefs 必须非空。 */
const KINDS_REQUIRING_SOURCES: ReadonlySet<string> = new Set(["data", "quote", "evidence"]);

const KIND_LABELS: Record<DeckBlockKind, string> = {
  claim: "论点",
  evidence: "论据",
  data: "数据",
  quote: "引述",
  visual: "图示",
};

function rowOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 溯源引用的展示名与合法集合：来自网关注入的 materialSources / memoryIndex。 */
export interface DeckSourceIndex {
  uris: Set<string>;
  labels: Map<string, string>;
}

export function deckSourceIndexOf(input: unknown): DeckSourceIndex {
  const uris = new Set<string>();
  const labels = new Map<string, string>();
  const record = rowOf(input) ?? {};
  const push = (uri: string, label: unknown): void => {
    uris.add(uri);
    if (typeof label === "string" && label.trim() && !labels.has(uri)) {
      labels.set(uri, label.trim().slice(0, 200));
    }
  };
  for (const entry of Array.isArray(record.materialSources) ? record.materialSources : []) {
    const row = rowOf(entry);
    if (!row) continue;
    const roomId = typeof row.roomId === "string" ? row.roomId : "";
    const documentId = typeof row.documentId === "string" ? row.documentId : "";
    const blockId = typeof row.blockId === "string" ? row.blockId : "";
    if (!roomId || !documentId || !blockId) continue;
    push(`everroom://room/${roomId}/${documentId}/${blockId}`, row.label);
  }
  for (const entry of Array.isArray(record.memoryIndex) ? record.memoryIndex : []) {
    const row = rowOf(entry);
    if (!row) continue;
    const roomId = typeof row.roomId === "string" ? row.roomId : "";
    const memoryId = typeof row.memoryId === "string" ? row.memoryId : "";
    if (!roomId || !memoryId) continue;
    push(`everroom://memory/${roomId}/${memoryId}`, row.label);
  }
  return { uris, labels };
}

function sourceMarker(uri: string, labels: Map<string, string>): string {
  const label = labels.get(uri) ?? uri.slice(uri.lastIndexOf("/") + 1);
  return `^[${label}](${uri})`;
}

/**
 * DraftSpec 归一与校验（Ajv 只保证单字段形态，这里复核跨字段语义）：
 * 块 id 唯一且合规、kind 合法、data/quote/evidence 必须带溯源引用。
 * 注意：引用不强制 ∈ 网关注入集合——子 Agent 素材自取（context_room_document_read）
 * 得到的来源不在注入索引里，只做 URI 形态校验；防自造依赖 SKILL 约束与下游抽查，
 * 与 doc-writer 块索引标记同一信任级别。
 */
export function normalizeDeckDraftSpec(output: Record<string, unknown>): DeckDraftSpec | null {
  const title = typeof output.title === "string" ? output.title.trim() : "";
  if (!title || title.length > 120) return null;
  const thesis = typeof output.thesis === "string" && output.thesis.trim()
    ? output.thesis.trim().slice(0, 300)
    : null;
  if (!Array.isArray(output.blocks) || output.blocks.length < 4 || output.blocks.length > 40) return null;
  const blocks: DeckDraftBlock[] = [];
  const seenIds = new Set<string>();
  for (const entry of output.blocks) {
    const row = rowOf(entry);
    if (!row) return null;
    const id = typeof row.id === "string" ? row.id : "";
    if (!BLOCK_ID_PATTERN.test(id) || seenIds.has(id)) return null;
    if (!(DECK_BLOCK_KINDS as readonly string[]).includes(String(row.kind))) return null;
    const kind = row.kind as DeckBlockKind;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content || content.length > 2000) return null;
    const refs: string[] = [];
    for (const ref of Array.isArray(row.sourceRefs) ? row.sourceRefs : []) {
      if (typeof ref !== "string" || !SOURCE_REF_PATTERN.test(ref)) return null;
      if (!refs.includes(ref)) refs.push(ref);
    }
    if (KINDS_REQUIRING_SOURCES.has(kind) && refs.length === 0) return null;
    seenIds.add(id);
    blocks.push({ id, kind, content, sourceRefs: refs });
  }
  return { title, thesis, blocks };
}

/**
 * 草稿文档的 markdown 序列化：块标题行编码「序号. [类型] id」，内容与溯源标记随其后。
 * 用户在 Context Doc 中编辑内容；下游（受众重排/密度编排）按标题行确定性解析回
 * DraftSpec——文档本身即结构化草稿的真源，无第二份数据。
 */
export function renderDeckDraftMarkdown(spec: DeckDraftSpec, labels: Map<string, string>): string {
  const lines: string[] = [];
  if (spec.thesis) {
    lines.push(`> **核心主张**：${spec.thesis}`, "");
  }
  lines.push("## 内容块", "");
  for (const [index, block] of spec.blocks.entries()) {
    lines.push(`### ${index + 1}. [${KIND_LABELS[block.kind]}] ${block.id}`, "", block.content, "");
    if (block.sourceRefs.length > 0) {
      lines.push(block.sourceRefs.map((uri) => sourceMarker(uri, labels)).join(" "), "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export interface DeckDraftContent {
  spec: DeckDraftSpec;
  chunks: string[];
  labels: Map<string, string>;
}

/** 从已完成 invocation 归一 deck 草稿（write_append 转交与 deck_draft 增量回读共用）。 */
export function deckDraftFromInvocation(invocation: SubagentInvocation): DeckDraftContent | null {
  const structured = invocation.result?.structuredOutput;
  const output = rowOf(structured);
  if (!output) return null;
  const spec = normalizeDeckDraftSpec(output);
  if (!spec) return null;
  const index = deckSourceIndexOf(invocation.input);
  return {
    spec,
    chunks: splitIntoAppendChunks(renderDeckDraftMarkdown(spec, index.labels)),
    labels: index.labels,
  };
}
