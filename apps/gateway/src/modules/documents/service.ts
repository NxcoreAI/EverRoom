import { createHash, randomUUID } from "node:crypto";
import type {
  AcknowledgeDocumentTransactionInput,
  DocumentEvent,
  ImportRoomDocumentInput,
  RoomDocument,
  SaveRoomDocumentInput,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documentOps,
  documentTransactions,
  documentVersions,
  documents,
  roomDocumentLinks,
} from "../../infrastructure/database/schema.js";
import { DocumentEventBroker } from "./event-broker.js";

const EMPTY_DOCUMENT: TiptapJsonContent = { type: "doc", content: [] };
const CHUNK_MAX_BYTES = 64 * 1024;
const TRANSACTION_MAX_BYTES = 2 * 1024 * 1024;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const RENDERER_ACK_TIMEOUT_MS = 180_000;

export class DocumentServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

class DocumentWriteQueue {
  private tail = Promise.resolve();

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface PendingAcknowledgement {
  promise: Promise<TiptapJsonContent>;
  resolve: (content: TiptapJsonContent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertContentJson(value: unknown): asserts value is TiptapJsonContent {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "doc") {
    throw new DocumentServiceError("INVALID_CONTENT", "Document content must be a Tiptap document");
  }
}

function toDocument(
  row: typeof documents.$inferSelect,
  roomId: string,
): RoomDocument {
  return {
    id: row.id,
    roomId,
    title: row.title,
    contentJson: row.contentJson as TiptapJsonContent,
    version: row.version,
    status: row.status,
    activeTransactionId: row.activeTransactionId,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentService {
  private readonly queue = new DocumentWriteQueue();
  private readonly pending = new Map<string, PendingAcknowledgement>();
  private readonly expiryTimer: NodeJS.Timeout;

  constructor(
    private readonly db: GatewayDatabase,
    readonly broker: DocumentEventBroker,
  ) {
    this.recoverInterruptedTransactions();
    this.expiryTimer = setInterval(() => void this.expireTransactions(), 30_000);
    this.expiryTimer.unref();
  }

  dispose(): void {
    clearInterval(this.expiryTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Document service stopped"));
    }
    this.pending.clear();
  }

  list(roomId: string, trashed = false): RoomDocument[] {
    return this.db.select({ document: documents })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(
        eq(roomDocumentLinks.roomId, roomId),
        trashed ? isNotNull(documents.deletedAt) : isNull(documents.deletedAt),
      ))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .all()
      .map(({ document }) => toDocument(document, roomId));
  }

  get(documentId: string): RoomDocument | null {
    const result = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .get();
    return result ? toDocument(result.document, result.roomId) : null;
  }

  replayPending(roomId: string): DocumentEvent[] {
    const transactions = this.db.select().from(documentTransactions).where(and(
      eq(documentTransactions.roomId, roomId),
      eq(documentTransactions.status, "open"),
    )).all();
    const events: DocumentEvent[] = [];
    for (const transaction of transactions) {
      const operations = this.db.select().from(documentOps).where(eq(
        documentOps.transactionId,
        transaction.id,
      )).orderBy(asc(documentOps.sequence)).all();
      for (const operation of operations) {
        if (operation.appliedContentJson) continue;
        events.push(this.createEvent(
          transaction.roomId,
          transaction.documentId,
          transaction.id,
          "document.appended",
          { sequence: operation.sequence, text: operation.markdown },
        ));
      }
      if (this.pending.has(`${transaction.id}:commit`)) {
        events.push(this.createEvent(
          transaction.roomId,
          transaction.documentId,
          transaction.id,
          "document.commit-requested",
          { finalSequence: transaction.nextSequence - 1 },
        ));
      }
    }
    return events;
  }

  import(input: ImportRoomDocumentInput): Promise<RoomDocument> {
    assertContentJson(input.contentJson);
    return this.queue.enqueue(() => {
      const existing = this.get(input.id);
      if (existing) {
        if (existing.roomId !== input.roomId) {
          throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
        }
        return existing;
      }
      const now = new Date();
      this.db.transaction((tx) => {
        tx.insert(documents).values({
          id: input.id,
          title: input.title.trim().slice(0, 120),
          contentJson: input.contentJson,
          version: 1,
          status: "active",
          createdAt: now,
          updatedAt: now,
        }).run();
        tx.insert(roomDocumentLinks).values({ roomId: input.roomId, documentId: input.id, linkedAt: now }).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId: input.id,
          version: 1,
          contentJson: input.contentJson,
          createdAt: now,
        }).run();
      });
      const imported = this.get(input.id)!;
      this.publish(input.roomId, input.id, null, "document.updated", { document: imported });
      return imported;
    });
  }

  save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument> {
    assertContentJson(input.contentJson);
    return this.queue.enqueue(() => {
      const current = this.get(documentId);
      if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (current.deletedAt) {
        throw new DocumentServiceError("DOCUMENT_TRASHED", "Restore the document before editing it", 409);
      }
      if (current.activeTransactionId) {
        throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
      }
      if (JSON.stringify(current.contentJson) === JSON.stringify(input.contentJson)) return current;
      if (current.version !== input.baseVersion) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409);
      }
      const nextVersion = current.version + 1;
      const now = new Date();
      this.db.transaction((tx) => {
        tx.update(documents).set({ contentJson: input.contentJson, version: nextVersion, updatedAt: now })
          .where(eq(documents.id, documentId)).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId,
          version: nextVersion,
          contentJson: input.contentJson,
          createdAt: now,
        }).run();
      });
      const updated = this.get(documentId)!;
      this.publish(updated.roomId, documentId, null, "document.updated", { document: updated });
      return updated;
    });
  }

  delete(documentId: string): Promise<void> {
    return this.queue.enqueue(() => {
      const current = this.get(documentId);
      if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (current.deletedAt) return;
      if (current.activeTransactionId) {
        throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
      }
      const now = new Date();
      this.db.update(documents).set({ deletedAt: now, updatedAt: now })
        .where(eq(documents.id, documentId)).run();
      const trashed = this.get(documentId)!;
      this.publish(current.roomId, documentId, null, "document.trashed", { document: trashed });
    });
  }

  restore(documentId: string): Promise<RoomDocument> {
    return this.queue.enqueue(() => {
      const current = this.get(documentId);
      if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (!current.deletedAt) return current;
      const now = new Date();
      this.db.update(documents).set({ deletedAt: null, updatedAt: now })
        .where(eq(documents.id, documentId)).run();
      const restored = this.get(documentId)!;
      this.publish(restored.roomId, documentId, null, "document.restored", { document: restored });
      return restored;
    });
  }

  deletePermanently(documentId: string): Promise<void> {
    return this.queue.enqueue(() => {
      const current = this.get(documentId);
      if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (!current.deletedAt) {
        throw new DocumentServiceError("DOCUMENT_NOT_TRASHED", "Move the document to trash first", 409);
      }
      const transactions = this.db.select({ id: documentTransactions.id })
        .from(documentTransactions)
        .where(eq(documentTransactions.documentId, documentId))
        .all();
      for (const transaction of transactions) {
        this.rejectTransactionAcknowledgements(
          transaction.id,
          new DocumentServiceError("DOCUMENT_DELETED", "Document was deleted", 410),
        );
      }
      this.db.transaction((tx) => {
        tx.delete(documentTransactions).where(eq(documentTransactions.documentId, documentId)).run();
        tx.delete(documents).where(eq(documents.id, documentId)).run();
      });
      this.publish(current.roomId, documentId, null, "document.deleted", { documentId });
    });
  }

  begin(input: {
    title: string;
    roomId: string;
    agentSessionId: string;
    runId: string;
  }): Promise<{ transactionId: string; document: RoomDocument; expiresAt: string }> {
    return this.queue.enqueue(() => {
      if (!input.roomId) throw new DocumentServiceError("ROOM_REQUIRED", "Open a Context Room first");
      const transactionId = randomUUID();
      const documentId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TRANSACTION_TTL_MS);
      this.db.transaction((tx) => {
        tx.insert(documents).values({
          id: documentId,
          title: input.title.trim().slice(0, 120),
          contentJson: EMPTY_DOCUMENT,
          version: 0,
          status: "draft",
          activeTransactionId: transactionId,
          createdAt: now,
          updatedAt: now,
        }).run();
        tx.insert(roomDocumentLinks).values({ roomId: input.roomId, documentId, linkedAt: now }).run();
        tx.insert(documentTransactions).values({
          id: transactionId,
          documentId,
          roomId: input.roomId,
          agentSessionId: input.agentSessionId,
          runId: input.runId,
          workingContentJson: EMPTY_DOCUMENT,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        }).run();
      });
      const document = this.get(documentId)!;
      this.publish(input.roomId, documentId, transactionId, "document.opened", { document });
      return { transactionId, document, expiresAt: expiresAt.toISOString() };
    });
  }

  async append(input: {
    transactionId: string;
    sessionId: string;
    sequence: number;
    text: string;
  }): Promise<{ duplicate: boolean; totalBytes: number; nextSequence: number }> {
    const prepared = await this.queue.enqueue(() => this.prepareAppend(input));
    if (prepared.appliedContent) return prepared.result;
    const acknowledgement = this.waitForAcknowledgement(`${input.transactionId}:${String(input.sequence)}`);
    this.publish(
      prepared.transaction.roomId,
      prepared.transaction.documentId,
      input.transactionId,
      "document.appended",
      { sequence: input.sequence, text: input.text },
    );
    await acknowledgement;
    return prepared.result;
  }

  async commit(input: {
    transactionId: string;
    sessionId: string;
    finalSequence: number;
  }): Promise<RoomDocument> {
    const transaction = await this.queue.enqueue(() => {
      const current = this.requireTransaction(input.transactionId, input.sessionId);
      if (input.finalSequence !== current.nextSequence - 1) {
        throw new DocumentServiceError("SEQUENCE_GAP", "Final sequence does not match received chunks");
      }
      return current;
    });
    const acknowledgement = this.waitForAcknowledgement(`${input.transactionId}:commit`);
    this.publish(transaction.roomId, transaction.documentId, transaction.id, "document.commit-requested", {
      finalSequence: input.finalSequence,
    });
    const finalContent = await acknowledgement;
    return this.queue.enqueue(() => {
      const current = this.requireTransaction(input.transactionId, input.sessionId);
      const now = new Date();
      this.db.transaction((tx) => {
        tx.update(documentTransactions).set({
          status: "committed",
          workingContentJson: finalContent,
          updatedAt: now,
          completedAt: now,
        }).where(eq(documentTransactions.id, current.id)).run();
        tx.update(documents).set({
          contentJson: finalContent,
          version: 1,
          status: "active",
          activeTransactionId: null,
          updatedAt: now,
        }).where(eq(documents.id, current.documentId)).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId: current.documentId,
          version: 1,
          contentJson: finalContent,
          sourceTransactionId: current.id,
          createdAt: now,
        }).run();
      });
      const document = this.get(current.documentId)!;
      this.publish(current.roomId, current.documentId, current.id, "document.committed", { document });
      return document;
    });
  }

  abort(transactionId: string, sessionId: string, reason = "aborted"): Promise<void> {
    return this.queue.enqueue(() => this.abortInternal(transactionId, sessionId, reason, "aborted"));
  }

  abortSession(sessionId: string, reason: string): Promise<void> {
    return this.queue.enqueue(() => {
      const transactions = this.db.select().from(documentTransactions)
        .where(and(eq(documentTransactions.agentSessionId, sessionId), eq(documentTransactions.status, "open")))
        .all();
      for (const transaction of transactions) this.abortRow(transaction, reason, "aborted");
    });
  }

  acknowledge(transactionId: string, input: AcknowledgeDocumentTransactionInput): Promise<void> {
    assertContentJson(input.contentJson);
    return this.queue.enqueue(() => {
      const transaction = this.db.select().from(documentTransactions)
        .where(eq(documentTransactions.id, transactionId)).get();
      if (!transaction || transaction.status !== "open") {
        throw new DocumentServiceError("TRANSACTION_NOT_FOUND", "Open transaction not found", 404);
      }
      const now = new Date();
      if (input.sequence > 0) {
        const op = this.db.select().from(documentOps).where(and(
          eq(documentOps.transactionId, transactionId),
          eq(documentOps.sequence, input.sequence),
        )).get();
        if (!op) throw new DocumentServiceError("SEQUENCE_GAP", "Document operation not found", 409);
        this.db.update(documentOps).set({ appliedContentJson: input.contentJson }).where(eq(documentOps.id, op.id)).run();
      }
      this.db.update(documentTransactions).set({ workingContentJson: input.contentJson, updatedAt: now })
        .where(eq(documentTransactions.id, transactionId)).run();
      this.db.update(documents).set({ contentJson: input.contentJson, updatedAt: now })
        .where(eq(documents.id, transaction.documentId)).run();
      this.resolveAcknowledgement(`${transactionId}:${String(input.sequence)}`, input.contentJson);
      if (input.sequence === transaction.nextSequence - 1) {
        this.resolveAcknowledgement(`${transactionId}:commit`, input.contentJson);
      }
    });
  }

  private prepareAppend(input: {
    transactionId: string;
    sessionId: string;
    sequence: number;
    text: string;
  }) {
    const transaction = this.requireTransaction(input.transactionId, input.sessionId);
    const bytes = Buffer.byteLength(input.text, "utf8");
    if (bytes > CHUNK_MAX_BYTES) {
      throw new DocumentServiceError("SIZE_LIMIT", "Document chunk exceeds 64 KiB");
    }
    const hash = sha256(input.text);
    const existing = this.db.select().from(documentOps).where(and(
      eq(documentOps.transactionId, input.transactionId),
      eq(documentOps.sequence, input.sequence),
    )).get();
    if (existing) {
      if (existing.sha256 !== hash || existing.markdown !== input.text) {
        throw new DocumentServiceError("SEQUENCE_CONFLICT", "Sequence already contains different content", 409);
      }
      return {
        transaction,
        appliedContent: existing.appliedContentJson as TiptapJsonContent | null,
        result: {
          duplicate: true,
          totalBytes: transaction.totalBytes,
          nextSequence: transaction.nextSequence,
        },
      };
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== transaction.nextSequence) {
      throw new DocumentServiceError("SEQUENCE_GAP", "Document chunks must be strictly consecutive", 409);
    }
    if (transaction.totalBytes + bytes > TRANSACTION_MAX_BYTES) {
      throw new DocumentServiceError("SIZE_LIMIT", "Document transaction exceeds 2 MiB");
    }
    const now = new Date();
    const nextSequence = input.sequence + 1;
    const totalBytes = transaction.totalBytes + bytes;
    const expiresAt = new Date(now.getTime() + TRANSACTION_TTL_MS);
    this.db.transaction((tx) => {
      tx.insert(documentOps).values({
        id: randomUUID(),
        transactionId: input.transactionId,
        sequence: input.sequence,
        markdown: input.text,
        sha256: hash,
        byteLength: bytes,
        createdAt: now,
      }).run();
      tx.update(documentTransactions).set({ nextSequence, totalBytes, expiresAt, updatedAt: now })
        .where(eq(documentTransactions.id, input.transactionId)).run();
    });
    return {
      transaction: { ...transaction, nextSequence, totalBytes, expiresAt },
      appliedContent: null,
      result: { duplicate: false, totalBytes, nextSequence },
    };
  }

  private requireTransaction(transactionId: string, sessionId: string) {
    const transaction = this.db.select().from(documentTransactions)
      .where(eq(documentTransactions.id, transactionId)).get();
    if (!transaction || transaction.status !== "open") {
      throw new DocumentServiceError("TRANSACTION_NOT_FOUND", "Open transaction not found", 404);
    }
    if (transaction.agentSessionId !== sessionId) {
      throw new DocumentServiceError("TRANSACTION_FORBIDDEN", "Transaction belongs to another Agent session", 403);
    }
    if (transaction.expiresAt.getTime() <= Date.now()) {
      this.abortRow(transaction, "transaction-expired", "expired");
      throw new DocumentServiceError("TRANSACTION_EXPIRED", "Document transaction expired", 410);
    }
    return transaction;
  }

  private abortInternal(
    transactionId: string,
    sessionId: string,
    reason: string,
    status: "aborted" | "expired" | "interrupted",
  ): void {
    const transaction = this.requireTransaction(transactionId, sessionId);
    this.abortRow(transaction, reason, status);
  }

  private abortRow(
    transaction: typeof documentTransactions.$inferSelect,
    reason: string,
    status: "aborted" | "expired" | "interrupted",
  ): void {
    const now = new Date();
    this.publish(transaction.roomId, transaction.documentId, transaction.id, "document.aborted", { reason });
    this.rejectTransactionAcknowledgements(transaction.id, new Error(`Document transaction ${status}`));
    this.db.transaction((tx) => {
      tx.update(documentTransactions).set({ status, completedAt: now, updatedAt: now })
        .where(eq(documentTransactions.id, transaction.id)).run();
      tx.delete(documents).where(eq(documents.id, transaction.documentId)).run();
    });
  }

  private waitForAcknowledgement(key: string): Promise<TiptapJsonContent> {
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolvePromise!: (content: TiptapJsonContent) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<TiptapJsonContent>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(key);
      rejectPromise(new DocumentServiceError("EDITOR_TIMEOUT", "Editor did not acknowledge document content", 504));
    }, RENDERER_ACK_TIMEOUT_MS);
    this.pending.set(key, {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
    return promise;
  }

  private resolveAcknowledgement(key: string, content: TiptapJsonContent): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(content);
  }

  private rejectTransactionAcknowledgements(transactionId: string, error: Error): void {
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(`${transactionId}:`)) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private recoverInterruptedTransactions(): void {
    const open = this.db.select().from(documentTransactions)
      .where(eq(documentTransactions.status, "open")).all();
    for (const transaction of open) this.abortRow(transaction, "gateway-restarted", "interrupted");
  }

  private expireTransactions(): Promise<void> {
    return this.queue.enqueue(() => {
      const expired = this.db.select().from(documentTransactions).where(and(
        eq(documentTransactions.status, "open"),
        lt(documentTransactions.expiresAt, new Date()),
      )).all();
      for (const transaction of expired) this.abortRow(transaction, "transaction-expired", "expired");
    });
  }

  private publish(
    roomId: string,
    documentId: string,
    transactionId: string | null,
    type: DocumentEvent["type"],
    payload: unknown,
  ): void {
    this.broker.publish(this.createEvent(roomId, documentId, transactionId, type, payload));
  }

  private createEvent(
    roomId: string,
    documentId: string,
    transactionId: string | null,
    type: DocumentEvent["type"],
    payload: unknown,
  ): DocumentEvent {
    return {
      id: randomUUID(),
      roomId,
      documentId,
      transactionId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
  }
}
