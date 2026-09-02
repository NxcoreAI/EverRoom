/**
 * doc-writer 引用透传（doc-writer-subagent-plan M3/V2）的内容解析契约。
 * 只有类型声明放 documents 侧（DocumentService 字段与 CapabilityBackend pick 用）；
 * 工厂实现在 subagents 模块（`subagents/doc-writer-content.ts`，复用分块器），
 * 由 create-server 装配注入——与 selection-rewrite-content 同款注入模式，
 * documents 模块不直接依赖 subagents。
 */
import type { DocumentMutationTarget } from "@nxcore/agent-contract";

/** patch_hunk 可消费的修改项（edit 的 hunk 原样；continue 的 chunk 映射为文末 insert）。 */
export interface DocWriterDraftItem {
  operation: "insert" | "replace" | "delete";
  target: DocumentMutationTarget;
  markdown: string;
}

/** 归一化后的 doc-writer 草稿内容：write_append 消费 chunks，patch_hunk 消费 items。 */
export interface DocWriterDraftContent {
  kind: "draft-create" | "draft-edit" | "draft-continue";
  title: string | null;
  baseVersion: number | null;
  /** 追加块序列（create/continue）；create 亦可由 contentMarkdown 服务端分块。 */
  chunks: string[];
  /** 修改项序列（edit=hunks；continue=chunk 映射 insert/{at:"end"}）。 */
  items: Array<DocWriterDraftItem>;
}

/**
 * invocationId → 草稿内容解析器。返回 null 表示 invocation 缺失、未完成、
 * 未授权（非本 run 的 document_draft 派发）或无可消费输出。
 */
export type DocWriterDraftResolver = (
  invocationId: string,
  context: { runId: string },
) => DocWriterDraftContent | null;
