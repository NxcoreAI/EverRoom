import type { RoomDocument } from "@nxcore/agent-contract";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { documents, jobs } from "../../../infrastructure/database/schema.js";
import { DocumentServiceError } from "../errors.js";
import { DOCUMENT_HISTORY_BACKFILL_JOB_TYPE, enqueueDocumentDelete } from "../integration-outbox.js";
import { DocumentRepository } from "./repository.js";

export interface DocumentLifecycleHooks {
  trashed?: (document: RoomDocument) => void;
  restored?: (document: RoomDocument) => void;
  deleted?: (document: RoomDocument) => void;
}

export class DocumentLifecycleService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly repository: DocumentRepository,
    private readonly hooks: DocumentLifecycleHooks = {},
  ) {}

  trash(documentId: string): RoomDocument {
    const current = this.requireDocument(documentId);
    if (current.deletedAt) return current;
    if (current.activeTransactionId) {
      throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
    }
    const now = new Date();
    this.db.update(documents).set({ deletedAt: now, updatedAt: now })
      .where(eq(documents.id, documentId)).run();
    const trashed = this.repository.get(documentId)!;
    this.hooks.trashed?.(trashed);
    return trashed;
  }

  restore(documentId: string): RoomDocument {
    const current = this.requireDocument(documentId);
    if (!current.deletedAt) return current;
    const now = new Date();
    this.db.update(documents).set({ deletedAt: null, updatedAt: now })
      .where(eq(documents.id, documentId)).run();
    const restored = this.repository.get(documentId)!;
    this.hooks.restored?.(restored);
    return restored;
  }

  deletePermanently(documentId: string): RoomDocument {
    const current = this.requireDocument(documentId);
    if (!current.deletedAt) {
      throw new DocumentServiceError("DOCUMENT_NOT_TRASHED", "Move the document to trash first", 409);
    }
    const now = new Date();
    this.db.transaction((tx) => {
      this.removeHistoryBackfillJob(tx, current.id);
      enqueueDocumentDelete(tx, { documentId: current.id, roomId: current.roomId }, now);
      tx.delete(documents).where(eq(documents.id, documentId)).run();
    });
    this.hooks.deleted?.(current);
    return current;
  }

  emptyTrash(roomId: string): RoomDocument[] {
    const trashed = this.repository.list(roomId, true);
    if (trashed.length === 0) return trashed;
    this.db.transaction((tx) => {
      for (const document of trashed) {
        this.removeHistoryBackfillJob(tx, document.id);
        enqueueDocumentDelete(tx, { documentId: document.id, roomId: document.roomId }, new Date());
        tx.delete(documents).where(eq(documents.id, document.id)).run();
      }
    });
    for (const document of trashed) this.hooks.deleted?.(document);
    return trashed;
  }

  private requireDocument(documentId: string): RoomDocument {
    const document = this.repository.get(documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    return document;
  }

  private removeHistoryBackfillJob(tx: GatewayDatabase, documentId: string): void {
    tx.delete(jobs).where(and(
      eq(jobs.id, `document-history-backfill:${documentId}`),
      eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE),
    )).run();
  }
}
