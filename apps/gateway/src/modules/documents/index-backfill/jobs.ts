import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { jobs } from "../../../infrastructure/database/schema.js";

/** 文档索引回溯（blockIndexMark）：给存量文档的段落自动补挂来源索引标记。 */
export const DOCUMENT_INDEX_BACKFILL_JOB_TYPE = "document.index-backfill";

export interface DocumentIndexBackfillJobPayload {
  documentId: string;
  roomId: string;
  /** 入队时的版本，仅记录用；处理时以实读为准。 */
  version: number;
  attempts: number;
}

/** 每文档单键：新版本入队前先淘汰未处理的旧任务（与 writing-style 入队同语义）。 */
export function enqueueDocumentIndexBackfill(
  tx: GatewayDatabase,
  input: Omit<DocumentIndexBackfillJobPayload, "attempts">,
  now: Date,
): void {
  const id = `document-index-backfill:${input.documentId}`;
  tx.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE))).run();
  tx.insert(jobs).values({
    id,
    type: DOCUMENT_INDEX_BACKFILL_JOB_TYPE,
    status: "pending",
    payload: { ...input, attempts: 0 } satisfies DocumentIndexBackfillJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}
