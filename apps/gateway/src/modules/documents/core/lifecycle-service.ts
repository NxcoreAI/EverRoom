import type { RoomDocument } from "@nxcore/agent-contract";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { documents, jobs } from "../../../infrastructure/database/schema.js";
import { DocumentServiceError } from "../errors.js";
import {
  DOCUMENT_HISTORY_BACKFILL_JOB_TYPE,
  enqueueDocumentDelete,
  enqueueDocumentIngest,
} from "../integration-outbox.js";
import { enqueueWritingStyleExtract } from "../../writing-style/jobs.js";
import { enqueueSearchIndex } from "../../search/jobs.js";
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
    this.db.transaction((tx) => {
      tx.update(documents).set({ deletedAt: now, updatedAt: now })
        .where(eq(documents.id, documentId)).run();
      // 回收站对知识侧不可见：trash 即入队清理 job（room_entity_facts 等
      // 投影残留是线上缺陷——只看最新 primaryRoomId 漏清理；与
      // deletePermanently 同款持久化 outbox，含重试账本）。restore 会撤销。
      enqueueDocumentDelete(tx, { documentId: current.id, roomId: current.roomId }, now);
      // 风格语料跟随文档生命周期：trash 后 worker 会看到 deletedAt 并清 sketch。
      enqueueWritingStyleExtract(tx, { documentId, roomId: current.roomId, version: current.version }, now);
      enqueueSearchIndex(tx, { itemType: "document", refId: documentId, priority: "high" });
    });
    const trashed = this.repository.get(documentId)!;
    this.hooks.trashed?.(trashed);
    return trashed;
  }

  restore(documentId: string): RoomDocument {
    const current = this.requireDocument(documentId);
    if (!current.deletedAt) return current;
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(documents).set({ deletedAt: null, updatedAt: now })
        .where(eq(documents.id, documentId)).run();
      // 撤销 trash 排定的清理 job（避免迟到清理删掉刚重建的投影），并重新
      // 入队 ingest 让知识侧按当前版本重建事实/提及投影。
      this.cancelPendingDeleteJobs(tx, documentId);
      enqueueDocumentIngest(tx, {
        documentId: current.id,
        roomId: current.roomId,
        version: current.version,
        sourceTransactionId: null,
      }, now);
      // 恢复后重新评估风格语料资格。
      enqueueWritingStyleExtract(tx, { documentId, roomId: current.roomId, version: current.version }, now);
      enqueueSearchIndex(tx, { itemType: "document", refId: documentId, priority: "high" });
    });
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
      // trash 已入队清理 job；幂等补一个仅当历史缺失（如旧库直接永久删的旁路）。
      this.enqueueDeleteIfMissing(tx, current, now);
      enqueueWritingStyleExtract(tx, { documentId: current.id, roomId: current.roomId, version: current.version }, now);
      tx.delete(documents).where(eq(documents.id, documentId)).run();
    });
    this.hooks.deleted?.(current);
    return current;
  }

  emptyTrash(roomId: string): RoomDocument[] {
    const trashed = this.repository.list(roomId, true);
    if (trashed.length === 0) return trashed;
    const now = new Date();
    this.db.transaction((tx) => {
      for (const document of trashed) {
        this.removeHistoryBackfillJob(tx, document.id);
        this.enqueueDeleteIfMissing(tx, document, now);
        enqueueWritingStyleExtract(tx, { documentId: document.id, roomId: document.roomId, version: document.version }, now);
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

  /** 撤销 trash 排定的 pending 清理 job（restore 场景；completed 的已生效，由重新 ingest 重建）。 */
  private cancelPendingDeleteJobs(tx: GatewayDatabase, documentId: string): void {
    const pending = tx.select({ id: jobs.id, payload: jobs.payload, status: jobs.status }).from(jobs)
      .where(eq(jobs.type, "document.delete")).all()
      .filter((job) => job.status === "pending"
        && (job.payload as { documentId?: string }).documentId === documentId);
    for (const job of pending) tx.delete(jobs).where(eq(jobs.id, job.id)).run();
  }

  /** trash 已入队清理 job；仅在缺失（历史旁路）时补一个，保证不重复。 */
  private enqueueDeleteIfMissing(tx: GatewayDatabase, document: RoomDocument, now: Date): void {
    const exists = tx.select({ id: jobs.id, payload: jobs.payload }).from(jobs)
      .where(eq(jobs.type, "document.delete")).all()
      .some((job) => (job.payload as { documentId?: string }).documentId === document.id);
    if (!exists) enqueueDocumentDelete(tx, { documentId: document.id, roomId: document.roomId }, now);
  }
}
