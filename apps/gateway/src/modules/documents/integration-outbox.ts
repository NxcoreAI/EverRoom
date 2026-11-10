import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";

export const DOCUMENT_HISTORY_BACKFILL_JOB_TYPE = "document.history.backfill";

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
