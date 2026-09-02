/**
 * doc-writer 子 Agent 的工具面支撑（doc-writer-subagent-plan §4）：
 * 主 Agent 的 document_draft 工具与本模块共同完成"网关侧组装 → dispatch →
 * 结构化产物归一"链路；本文件只放与 orchestrator 无耦合的纯函数与契约常量。
 */
import type { SubagentResultValidator } from "./runtime-manager.js";

export const DOC_WRITER_AGENT_ID = "doc-writer";

export type DocWriterTask = "draft-create" | "draft-edit" | "draft-continue" | "rewrite";

/** document_draft 的文档快照数据源（DocumentService.readDocumentForAgent 的结构化投影）。 */
export interface DocumentDraftSnapshot {
  document: { id: string; title: string; version: number; roomId: string };
  blocks: Array<{ blockId: string; type: string; ordinal: number; depth: number; textPreview: string }>;
  markdown: string;
}

export const DOC_WRITER_TASK_LABELS: Record<DocWriterTask, string> = {
  "draft-create": "起草新文档正文",
  "draft-edit": "产出文档修改提案",
  "draft-continue": "续写文档",
  rewrite: "改写选中文本",
};

/** write_append 单块上限 64KiB，预留 headroom 到 48KiB。 */
export const APPEND_CHUNK_MAX_BYTES = 48 * 1024;
/** 与 write 流累计上限对齐（create-plugin）。 */
export const DRAFT_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
/** documentMarkdown 组装预算（开放问题⑦的初值）。 */
export const DOCUMENT_MARKDOWN_MAX_CHARS = 200_000;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * 把整篇 markdown 切成 ≤maxBytes 的追加块：优先在自然段（空行）边界切，
 * 段内超限降级到行边界，行超限按字符硬切（保证多字节字符不截半）。
 * 不变量：chunks.join("") 与原文逐字节一致；内容不做任何改写。
 */
export function splitIntoAppendChunks(markdown: string, maxBytes = APPEND_CHUNK_MAX_BYTES): string[] {
  if (byteLength(markdown) > DRAFT_TOTAL_MAX_BYTES) throw new Error("doc_writer_output_too_large");
  if (byteLength(markdown) <= maxBytes) return markdown ? [markdown] : [];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const flush = (): void => {
    if (current) chunks.push(current);
    current = "";
    currentBytes = 0;
  };
  for (const paragraph of markdown.split(/(?<=\n\n)/)) {
    if (byteLength(paragraph) > maxBytes) {
      flush();
      chunks.push(...splitOversizedPiece(paragraph, maxBytes));
      continue;
    }
    if (currentBytes + byteLength(paragraph) > maxBytes) flush();
    current += paragraph;
    currentBytes += byteLength(paragraph);
  }
  flush();
  return chunks;
}

function splitOversizedPiece(piece: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  const flush = (): void => {
    if (current) out.push(current);
    current = "";
    currentBytes = 0;
  };
  for (const line of piece.split(/(?<=\n)/)) {
    if (byteLength(line) > maxBytes) {
      flush();
      let start = 0;
      while (start < line.length) {
        let end = start;
        let bytes = 0;
        while (end < line.length && bytes + byteLength(line[end]!) <= maxBytes) {
          bytes += byteLength(line[end]!);
          end += 1;
        }
        out.push(line.slice(start, end));
        start = end;
      }
      continue;
    }
    if (currentBytes + byteLength(line) > maxBytes) flush();
    current += line;
    currentBytes += byteLength(line);
  }
  flush();
  return out;
}

/**
 * doc-writer 输出的跨字段语义校验（registerAgentResultValidator 注册）：
 * Ajv 只保证单字段形态，这里复核 baseVersion 回显、hunks 目标 ∈ blockIndex、
 * 分块与总量的字节预算。抛错会被 subagent_submit_result 归类为可恢复失败，
 * 子 Agent 修正后重试一次。
 */
export function createDocWriterResultValidator(): SubagentResultValidator {
  return (invocationInput, result) => {
    const input = invocationInput !== null && typeof invocationInput === "object" && !Array.isArray(invocationInput)
      ? invocationInput as Record<string, unknown>
      : {};
    const kind = typeof result.kind === "string" ? result.kind : "";
    if (kind === "draft-edit" || kind === "draft-continue") {
      if (typeof input.baseVersion === "number" && result.baseVersion !== input.baseVersion) {
        throw new Error("doc_writer_base_version_mismatch: baseVersion 必须原样回显输入快照版本");
      }
    }
    if (kind === "draft-edit") {
      const known = new Set(
        Array.isArray(input.blockIndex)
          ? input.blockIndex
            .filter((entry): entry is Record<string, unknown> =>
              entry !== null && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => String(entry.blockId ?? ""))
            .filter(Boolean)
          : [],
      );
      const hunks = Array.isArray(result.hunks) ? result.hunks : [];
      for (const hunk of hunks) {
        if (hunk === null || typeof hunk !== "object" || Array.isArray(hunk)) continue;
        const target = (hunk as Record<string, unknown>).target;
        if (target === null || typeof target !== "object" || Array.isArray(target)) continue;
        for (const blockId of [
          (target as Record<string, unknown>).blockId,
          (target as Record<string, unknown>).fromBlockId,
          (target as Record<string, unknown>).toBlockId,
        ]) {
          if (typeof blockId === "string" && blockId && known.size > 0 && !known.has(blockId)) {
            throw new Error(`doc_writer_hunk_target_not_in_snapshot: ${blockId}`);
          }
        }
      }
    }
    let total = 0;
    if (Array.isArray(result.appendChunks)) {
      for (const chunk of result.appendChunks) {
        if (typeof chunk !== "string" || !chunk) throw new Error("doc_writer_chunk_invalid");
        const bytes = byteLength(chunk);
        if (bytes > APPEND_CHUNK_MAX_BYTES) throw new Error("doc_writer_chunk_too_large");
        total += bytes;
      }
    }
    if (typeof result.contentMarkdown === "string") total += byteLength(result.contentMarkdown);
    if (total > DRAFT_TOTAL_MAX_BYTES) throw new Error("doc_writer_output_too_large");
  };
}
