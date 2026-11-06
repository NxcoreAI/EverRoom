/**
 * doc-writer 引用透传（doc-writer-subagent-plan M3/V2）的解析器工厂：
 * write_append / patch_hunk 携带 invocationId + 序号时，服务端从
 * doc-writer invocation 的 structuredOutput 转交正文，主 Agent 上下文
 * 不再经过全文。授权口径：必须是本 run（parentRunId 匹配）经
 * document_draft 派发（source=primary_agent）的 completed doc-writer 调用。
 */
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { DocumentMutationTarget } from "@nxcore/agent-contract";
import type {
  DocWriterDraftContent,
  DocWriterDraftItem,
  DocWriterDraftResolver,
} from "../documents/capabilities/doc-writer-content.js";
import { DOC_WRITER_AGENT_ID, splitIntoAppendChunks } from "./document-draft.js";

function structuredOutputOf(invocation: SubagentInvocation): Record<string, unknown> | null {
  const structured = invocation.result?.structuredOutput;
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) return null;
  return structured as Record<string, unknown>;
}

function chunksOf(output: Record<string, unknown>): string[] | null {
  if (Array.isArray(output.appendChunks)) {
    const chunks = output.appendChunks.filter((chunk): chunk is string =>
      typeof chunk === "string" && Boolean(chunk));
    return chunks.length ? chunks : null;
  }
  if (typeof output.contentMarkdown === "string" && output.contentMarkdown.trim()) {
    try {
      return splitIntoAppendChunks(output.contentMarkdown);
    } catch {
      return null;
    }
  }
  return null;
}

function itemsOf(output: Record<string, unknown>): DocWriterDraftItem[] | null {
  if (!Array.isArray(output.hunks) || !output.hunks.length) return null;
  const items: DocWriterDraftItem[] = [];
  for (const hunk of output.hunks) {
    if (hunk === null || typeof hunk !== "object" || Array.isArray(hunk)) return null;
    const row = hunk as Record<string, unknown>;
    if (row.operation !== "insert" && row.operation !== "replace" && row.operation !== "delete") return null;
    if (row.target === null || typeof row.target !== "object" || Array.isArray(row.target)) return null;
    items.push({
      operation: row.operation,
      target: row.target as DocumentMutationTarget,
      markdown: typeof row.markdown === "string" ? row.markdown : "",
    });
  }
  return items;
}

/**
 * 把 doc-writer invocation 的 structuredOutput 归一化为草稿内容。
 * resolver（write/patch 引用转交）与 document_draft（previousInvocationId
 * 增量迭代回读上一稿）共用同一归一化。
 */
export function docWriterDraftFromStructuredOutput(
  output: Record<string, unknown>,
): DocWriterDraftContent | null {
  const kind = typeof output.kind === "string" ? output.kind : "";
  const title = typeof output.title === "string" && output.title.trim() ? output.title : null;
  const baseVersion = typeof output.baseVersion === "number" ? output.baseVersion : null;
  if (kind === "draft-create") {
    const chunks = chunksOf(output);
    if (!chunks) return null;
    return { kind, title, baseVersion: null, chunks, items: [] };
  }
  if (kind === "draft-continue") {
    const chunks = chunksOf(output);
    if (!chunks) return null;
    return {
      kind,
      title: null,
      baseVersion,
      chunks,
      items: chunks.map((markdown) => ({
        operation: "insert" as const,
        target: { at: "end" } as DocumentMutationTarget,
        markdown,
      })),
    };
  }
  if (kind === "draft-edit") {
    const items = itemsOf(output);
    if (!items) return null;
    return { kind, title: null, baseVersion, chunks: [], items };
  }
  return null;
}

export function createDocWriterDraftResolver(deps: {
  getInvocation: (invocationId: string) => SubagentInvocation | null;
}): DocWriterDraftResolver {
  return (invocationId, context) => {
    const invocation = deps.getInvocation(invocationId);
    if (!invocation) return null;
    if (invocation.agentDefinitionId !== DOC_WRITER_AGENT_ID) return null;
    if (invocation.source !== "primary_agent") return null;
    if (invocation.parentRunId !== context.runId) return null;
    if (invocation.status !== "completed" || !invocation.result) return null;
    const output = structuredOutputOf(invocation);
    if (!output) return null;
    return docWriterDraftFromStructuredOutput(output);
  };
}
