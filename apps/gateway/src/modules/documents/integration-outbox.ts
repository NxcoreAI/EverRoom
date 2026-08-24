import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";

export const DOCUMENT_INGEST_JOB_TYPE = "document.ingest";
export const DOCUMENT_DELETE_JOB_TYPE = "document.delete";
export const DOCUMENT_HISTORY_BACKFILL_JOB_TYPE = "document.history.backfill";

export interface DocumentIngestJobPayload {
  documentId: string;
  roomId: string;
  version: number;
  sourceTransactionId: string | null;
  attempts: number;
}

export interface DocumentDeleteJobPayload {
  documentId: string;
  roomId: string;
  attempts: number;
}

export interface DocumentHistoryBackfillJobPayload {
  documentId: string;
  attempts: number;
}

export function enqueueDocumentHistoryBackfill(
  tx: GatewayDatabase,
  documentId: string,
  now: Date,
): void {
  const id = `document-history-backfill:${documentId}`;
  if (tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE))).get()) {
    return;
  }
  tx.insert(jobs).values({
    id,
    type: DOCUMENT_HISTORY_BACKFILL_JOB_TYPE,
    status: "pending",
    payload: { documentId, attempts: 0 } satisfies DocumentHistoryBackfillJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}

export function enqueueDocumentIngest(
  tx: GatewayDatabase,
  input: Omit<DocumentIngestJobPayload, "attempts">,
  now: Date,
): void {
  tx.insert(jobs).values({
    id: `document-ingest:${input.documentId}:${input.version}:${randomUUID()}`,
    type: DOCUMENT_INGEST_JOB_TYPE,
    status: "pending",
    payload: { ...input, attempts: 0 } satisfies DocumentIngestJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}

export function enqueueDocumentDelete(
  tx: GatewayDatabase,
  input: Omit<DocumentDeleteJobPayload, "attempts">,
  now: Date,
): void {
  tx.insert(jobs).values({
    id: `document-delete:${input.documentId}:${randomUUID()}`,
    type: DOCUMENT_DELETE_JOB_TYPE,
    status: "pending",
    payload: { ...input, attempts: 0 } satisfies DocumentDeleteJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}
