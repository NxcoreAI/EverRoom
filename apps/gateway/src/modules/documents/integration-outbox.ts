import { randomUUID } from "node:crypto";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";

export const DOCUMENT_INGEST_JOB_TYPE = "document.ingest";
export const DOCUMENT_DELETE_JOB_TYPE = "document.delete";

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
