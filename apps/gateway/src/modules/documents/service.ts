import { createHash, randomUUID } from "node:crypto";
import type {
  AcknowledgeDocumentTransactionInput,
  AcceptDocumentContinuationBlockInput,
  AcceptDocumentContinuationBlockResult,
  AgentActiveDocumentContext,
  AppendDocumentPatchHunkInput,
  ApplyDocumentPatchInput,
  ApplyDocumentPatchResult,
  CreateDocumentPatchInput,
  DocumentBlockResolution,
  DocumentBlockSummary,
  DocumentContinuationBlock,
  DocumentEvent,
  DocumentPatch,
  DocumentPatchHunk,
  DocumentPatchStatus,
  DocumentPatchSummary,
  ImportRoomDocumentInput,
  ResolveDocumentBlockReferencesInput,
  RejectDocumentContinuationBlockInput,
  RejectDocumentContinuationBlockResult,
  RoomDocument,
  SaveRoomDocumentInput,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  contextRooms,
  documentBlocks,
  documentOps,
  documentPatchHunks,
  documentPatches,
  documentTransactions,
  documentVersions,
  documents,
  roomDocumentLinks,
} from "../../infrastructure/database/schema.js";
import {
  applyDocumentPatchHunk,
  collectDocumentReferences,
  findBlockPath,
  nodeAtPath,
  normalizeDocumentContent,
  patchTargetBlockIds,
  targetsOverlap,
  tiptapText,
} from "./content-model.js";
import { DocumentEventBroker } from "./event-broker.js";
import { DocumentServiceError } from "./errors.js";

export { DocumentServiceError } from "./errors.js";

const EMPTY_DOCUMENT: TiptapJsonContent = { type: "doc", content: [] };
const CHUNK_MAX_BYTES = 64 * 1024;
const TRANSACTION_MAX_BYTES = 2 * 1024 * 1024;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PATCH_TTL_MS = 10 * 60 * 1000;

class DocumentWriteQueue {
  private tail = Promise.resolve();

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface CommittedAgentDocument {
  sessionId: string;
  roomId: string;
  runId: string;
  transactionId: string;
  documentId: string;
  title: string;
  markdown: string;
}

export type DocumentCommittedHandler = (document: CommittedAgentDocument) => void;

export interface AppliedAgentDocumentPatch {
  sessionId: string;
  roomId: string;
  runId: string;
  patchId: string;
  documentId: string;
  title: string;
  instruction: string;
  originalText: string;
  replacementText: string;
}

export type DocumentPatchAppliedHandler = (patch: AppliedAgentDocumentPatch) => void;

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

function toPatchHunk(row: typeof documentPatchHunks.$inferSelect): DocumentPatchHunk {
  return {
    id: row.id,
    sequence: row.sequence,
    operation: row.operation,
    target: row.target,
    markdown: row.markdown,
    before: row.beforeJson,
    after: row.afterJson,
    addedCharacters: row.addedCharacters,
    deletedCharacters: row.deletedCharacters,
  };
}

function continuationBlocks(hunks: DocumentPatchHunk[]): DocumentContinuationBlock[] {
  const result: DocumentContinuationBlock[] = [];
  for (const hunk of hunks) {
    if (hunk.operation !== "insert") continue;
    for (const [index, source] of hunk.after.entries()) {
      const explicitId = source.attrs?.id;
      const blockId = typeof explicitId === "string" && explicitId.trim()
        ? explicitId
        : `${hunk.id}:${index + 1}`;
      const contentJson: TiptapJsonContent = {
        ...source,
        attrs: { ...source.attrs, id: blockId },
      };
      const previous = result.at(-1);
      result.push({
        blockId,
        sequence: result.length + 1,
        hunkId: hunk.id,
        target: previous ? { blockId: previous.blockId, edge: "after" } : hunk.target,
        contentJson,
        textPreview: tiptapText(contentJson).replace(/\s+/g, " ").trim().slice(0, 240),
        addedCharacters: tiptapText(contentJson).length,
      });
    }
  }
  return result;
}

function nextContinuationBlock(
  blocks: DocumentContinuationBlock[],
  acceptedBlockIds: string[],
  rejectedBlockIds: string[],
): DocumentContinuationBlock | null {
  const decided = new Set([...acceptedBlockIds, ...rejectedBlockIds]);
  const next = blocks.find((block) => !decided.has(block.blockId));
  if (!next) return null;
  const lastAcceptedId = acceptedBlockIds.at(-1);
  return lastAcceptedId
    ? { ...next, target: { blockId: lastAcceptedId, edge: "after" } }
    : { ...next, target: blocks[0]?.target ?? next.target };
}

function toPatchSummary(
  row: typeof documentPatches.$inferSelect,
  documentTitle: string,
  hunks: DocumentPatchHunk[],
): DocumentPatchSummary {
  return {
    id: row.id,
    roomId: row.roomId,
    documentId: row.documentId,
    documentTitle,
    baseVersion: row.baseVersion,
    sessionId: row.agentSessionId,
    runId: row.runId,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    hunkCount: hunks.length,
    addedCharacters: hunks.reduce((total, hunk) => total + hunk.addedCharacters, 0),
    deletedCharacters: hunks.reduce((total, hunk) => total + hunk.deletedCharacters, 0),
    acceptedHunkIds: row.acceptedHunkIds ?? [],
    rejectedHunkIds: row.rejectedHunkIds ?? [],
    acceptedBlockIds: row.acceptedBlockIds ?? [],
    rejectedBlockIds: row.rejectedBlockIds ?? [],
    appliedVersion: row.appliedVersion,
    conflictVersion: row.conflictVersion,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentService {
  private readonly queue = new DocumentWriteQueue();
  private readonly markdown = new MarkdownManager({
    extensions: [StarterKit, TaskList, TaskItem],
  });
  private readonly expiryTimer: NodeJS.Timeout;

  constructor(
    private readonly db: GatewayDatabase,
    readonly broker: DocumentEventBroker,
    private readonly onDocumentCommitted?: DocumentCommittedHandler,
    private readonly onDocumentPatchApplied?: DocumentPatchAppliedHandler,
  ) {
    this.recoverInterruptedTransactions();
    this.recoverInterruptedPatches();
    this.normalizeStoredDocuments();
    this.expiryTimer = setInterval(() => void this.expireTransactions(), 30_000);
    this.expiryTimer.unref();
  }

  dispose(): void {
    clearInterval(this.expiryTimer);
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

  listBlocks(documentId: string): DocumentBlockSummary[] {
    const document = this.get(documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    return this.db.select().from(documentBlocks)
      .where(eq(documentBlocks.documentId, documentId))
      .orderBy(asc(documentBlocks.ordinal)).all()
      .map((row) => ({
        id: row.id,
        documentId,
        roomId: document.roomId,
        parentBlockId: row.parentBlockId,
        type: row.type,
        ordinal: row.ordinal,
        path: row.path,
        textPreview: row.textPreview,
      }));
  }

  resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): DocumentBlockResolution[] {
    if (!input.sourceRoomId) throw new DocumentServiceError("ROOM_REQUIRED", "sourceRoomId is required");
    return input.references.map((reference) => {
      if (reference.roomId !== input.sourceRoomId) {
        throw new DocumentServiceError("CROSS_ROOM_REFERENCE", "Document block references must stay in one Room", 409);
      }
      const room = this.db.select().from(contextRooms).where(eq(contextRooms.id, reference.roomId)).get();
      if (!room || room.deletedAt) {
        return { ...reference, status: "room_unavailable", title: null, textPreview: null, version: null };
      }
      const document = this.get(reference.documentId);
      if (!document || document.roomId !== reference.roomId) {
        return { ...reference, status: "document_deleted", title: null, textPreview: null, version: null };
      }
      if (document.deletedAt) {
        return {
          ...reference,
          status: "document_trashed",
          title: document.title,
          textPreview: null,
          version: document.version,
        };
      }
      const block = this.db.select().from(documentBlocks).where(and(
        eq(documentBlocks.documentId, reference.documentId),
        eq(documentBlocks.id, reference.blockId),
      )).get();
      return {
        ...reference,
        status: block ? "available" : "block_missing",
        title: document.title,
        textPreview: block?.textPreview ?? null,
        version: document.version,
      };
    });
  }

  validateActiveDocumentContext(
    context: AgentActiveDocumentContext,
    roomId: string | null,
  ): AgentActiveDocumentContext {
    const document = this.get(context.documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Active document not found", 404);
    if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Active document is in trash", 409);
    if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Active document is busy", 409);
    if (document.roomId !== context.roomId || (roomId && document.roomId !== roomId)) {
      throw new DocumentServiceError("ROOM_MISMATCH", "Active document belongs to another Room", 409);
    }
    if (document.version !== context.version) {
      throw new DocumentServiceError("DOCUMENT_CONFLICT", "Active document version has changed", 409, {
        currentVersion: document.version,
        currentDocument: document,
      });
    }
    const candidate = context.cursorAnchorCandidate;
    if (candidate) {
      const path = findBlockPath(document.contentJson, candidate.blockId);
      if (!path) throw new DocumentServiceError("BLOCK_NOT_FOUND", "Cursor block was not found", 409);
      const text = tiptapText(nodeAtPath(document.contentJson, path));
      const length = text.length;
      if (!Number.isSafeInteger(candidate.offset) || candidate.offset < 0 || candidate.offset > length) {
        throw new DocumentServiceError("ANCHOR_INVALID", "Cursor offset is outside the target block", 409);
      }
      if (candidate.offset > 0 && candidate.offset < length) {
        const previous = text.charCodeAt(candidate.offset - 1);
        const next = text.charCodeAt(candidate.offset);
        if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
          throw new DocumentServiceError("ANCHOR_INVALID", "Cursor offset splits a Unicode character", 409);
        }
      }
    }
    return {
      ...context,
      roomId: document.roomId,
      documentId: document.id,
      title: document.title,
      version: document.version,
      defaultAnchor: "end",
    };
  }

  readDocumentForAgent(documentId: string, roomId: string): {
    document: RoomDocument;
    blocks: DocumentBlockSummary[];
    markdown: string;
  } {
    const document = this.get(documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    if (document.roomId !== roomId) {
      throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
    }
    if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
    const blocks = this.listBlocks(documentId);
    let markdown: string;
    try {
      markdown = this.markdown.serialize(document.contentJson);
    } catch {
      markdown = blocks.map((block) => `<!-- block:${block.id} type:${block.type} -->\n${block.textPreview}`).join("\n\n");
    }
    return { document, blocks, markdown };
  }

  replayPending(_roomId: string): DocumentEvent[] {
    return [];
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
      const normalized = this.normalizeContent(input.id, input.roomId, input.contentJson);
      this.db.transaction((tx) => {
        tx.insert(documents).values({
          id: input.id,
          title: input.title.trim().slice(0, 120),
          contentJson: normalized.content,
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
          contentJson: normalized.content,
          createdAt: now,
        }).run();
        if (normalized.blocks.length > 0) {
          tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
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
      const title = input.title === undefined ? current.title : input.title.trim();
      if (!title) throw new DocumentServiceError("INVALID_TITLE", "Document title cannot be empty");
      if (title.length > 120) {
        throw new DocumentServiceError("INVALID_TITLE", "Document title cannot exceed 120 characters");
      }
      const normalized = this.normalizeContent(documentId, current.roomId, input.contentJson, current.contentJson);
      const contentChanged = JSON.stringify(current.contentJson) !== JSON.stringify(normalized.content);
      const titleChanged = current.title !== title;
      if (!contentChanged && !titleChanged) return current;
      if (current.version !== input.baseVersion) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409);
      }
      const nextVersion = current.version + 1;
      const now = new Date();
      this.db.transaction((tx) => {
        tx.update(documents).set({ title, contentJson: normalized.content, version: nextVersion, updatedAt: now })
          .where(eq(documents.id, documentId)).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId,
          version: nextVersion,
          contentJson: normalized.content,
          createdAt: now,
        }).run();
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, documentId)).run();
        if (normalized.blocks.length > 0) {
          tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
      });
      const updated = this.get(documentId)!;
      this.markPendingPatchesConflicted(documentId, nextVersion);
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
      this.db.transaction((tx) => {
        tx.delete(documentTransactions).where(eq(documentTransactions.documentId, documentId)).run();
        tx.delete(documents).where(eq(documents.id, documentId)).run();
      });
      this.publish(current.roomId, documentId, null, "document.deleted", { documentId });
    });
  }

  emptyTrash(roomId: string): Promise<void> {
    return this.queue.enqueue(() => {
      const trashed = this.list(roomId, true);
      if (trashed.length === 0) return;
      this.db.transaction((tx) => {
        for (const document of trashed) {
          tx.delete(documentTransactions).where(eq(documentTransactions.documentId, document.id)).run();
          tx.delete(documents).where(eq(documents.id, document.id)).run();
        }
      });
      for (const document of trashed) {
        this.publish(roomId, document.id, null, "document.deleted", { documentId: document.id });
      }
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

  append(input: {
    transactionId: string;
    sessionId: string;
    sequence: number;
    text: string;
  }): Promise<{ duplicate: boolean; totalBytes: number; nextSequence: number }> {
    return this.queue.enqueue(() => {
      const prepared = this.prepareAppend(input);
      if (!prepared.result.duplicate) {
        this.publish(
          prepared.transaction.roomId,
          prepared.transaction.documentId,
          input.transactionId,
          "document.appended",
          {
            sequence: input.sequence,
            text: input.text,
            document: this.get(prepared.transaction.documentId)!,
          },
        );
      }
      return prepared.result;
    });
  }

  commit(input: {
    transactionId: string;
    sessionId: string;
    finalSequence: number;
  }): Promise<RoomDocument> {
    return this.queue.enqueue(() => {
      const current = this.requireTransaction(input.transactionId, input.sessionId);
      if (input.finalSequence !== current.nextSequence - 1) {
        throw new DocumentServiceError("SEQUENCE_GAP", "Final sequence does not match received chunks");
      }
      const prepared = this.normalizeContent(
        current.documentId,
        current.roomId,
        current.workingContentJson as TiptapJsonContent,
        current.workingContentJson as TiptapJsonContent,
      );
      const finalContent = prepared.content;
      this.publish(current.roomId, current.documentId, current.id, "document.commit-requested", {
        finalSequence: input.finalSequence,
        document: this.get(current.documentId)!,
      });
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
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, current.documentId)).run();
        if (prepared.blocks.length > 0) {
          tx.insert(documentBlocks).values(prepared.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
      });
      const document = this.get(current.documentId)!;
      this.publish(current.roomId, current.documentId, current.id, "document.committed", { document });
      const markdown = this.db.select({ markdown: documentOps.markdown })
        .from(documentOps)
        .where(eq(documentOps.transactionId, current.id))
        .orderBy(asc(documentOps.sequence))
        .all()
        .map((operation) => operation.markdown)
        .join("");
      this.onDocumentCommitted?.({
        sessionId: current.agentSessionId,
        roomId: current.roomId,
        runId: current.runId,
        transactionId: current.id,
        documentId: current.documentId,
        title: document.title,
        markdown,
      });
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
      const patches = this.db.select().from(documentPatches).where(and(
        eq(documentPatches.agentSessionId, sessionId),
        eq(documentPatches.status, "building"),
      )).all();
      for (const patch of patches) {
        this.finishPatch(patch, "aborted", "document.patch-aborted", { reason });
      }
    });
  }

  acknowledge(transactionId: string, input: AcknowledgeDocumentTransactionInput): Promise<void> {
    assertContentJson(input.contentJson);
    return this.queue.enqueue(() => {
      const transaction = this.db.select().from(documentTransactions)
        .where(eq(documentTransactions.id, transactionId)).get();
      if (!transaction) {
        throw new DocumentServiceError("TRANSACTION_NOT_FOUND", "Document transaction not found", 404);
      }
      if (input.sequence > 0) {
        const op = this.db.select().from(documentOps).where(and(
          eq(documentOps.transactionId, transactionId),
          eq(documentOps.sequence, input.sequence),
        )).get();
        if (!op) throw new DocumentServiceError("SEQUENCE_GAP", "Document operation not found", 409);
      }
    });
  }

  listPatches(documentId?: string, status?: DocumentPatchStatus): DocumentPatchSummary[] {
    const conditions = [
      ...(documentId ? [eq(documentPatches.documentId, documentId)] : []),
      ...(status ? [eq(documentPatches.status, status)] : []),
    ];
    const rows = this.db.select().from(documentPatches)
      .where(conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(documentPatches.createdAt)).all();
    return rows.map((row) => {
      const document = this.get(row.documentId);
      const hunks = this.db.select().from(documentPatchHunks)
        .where(eq(documentPatchHunks.patchId, row.id))
        .orderBy(asc(documentPatchHunks.sequence)).all().map(toPatchHunk);
      return toPatchSummary(row, document?.title ?? "Deleted document", hunks);
    });
  }

  getPatch(patchId: string): DocumentPatch | null {
    const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
    if (!row) return null;
    const document = this.get(row.documentId);
    const hunks = this.db.select().from(documentPatchHunks)
      .where(eq(documentPatchHunks.patchId, patchId))
      .orderBy(asc(documentPatchHunks.sequence)).all().map(toPatchHunk);
    const summary = toPatchSummary(row, document?.title ?? "Deleted document", hunks);
    const blocks = row.kind === "continue" ? continuationBlocks(hunks) : [];
    return {
      ...summary,
      baseContentJson: row.baseContentJson,
      proposedContentJson: row.proposedContentJson,
      hunks,
      continuationBlocks: blocks,
      nextPendingBlock: summary.status === "pending"
        ? nextContinuationBlock(blocks, summary.acceptedBlockIds, summary.rejectedBlockIds)
        : null,
    };
  }

  beginPatch(input: CreateDocumentPatchInput & {
    roomId: string;
    agentSessionId: string;
    runId: string;
  }): Promise<{ patch: DocumentPatch; expiresAt: string }> {
    return this.queue.enqueue(() => {
      const document = this.get(input.documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.roomId !== input.roomId) {
        throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
      }
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      if (document.version !== input.baseVersion) {
        throw new DocumentServiceError("PATCH_CONFLICT", "Document version has changed", 409, {
          currentVersion: document.version,
          currentDocument: document,
        });
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PATCH_TTL_MS);
      const id = randomUUID();
      this.db.insert(documentPatches).values({
        id,
        roomId: input.roomId,
        documentId: input.documentId,
        agentSessionId: input.agentSessionId,
        runId: input.runId,
        kind: input.kind,
        summary: input.summary.trim().slice(0, 500),
        baseVersion: input.baseVersion,
        baseContentJson: document.contentJson,
        proposedContentJson: document.contentJson,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      }).run();
      const patch = this.getPatch(id)!;
      this.publish(document.roomId, document.id, null, "document.patch-building", {
        patch: this.patchEventSummary(patch),
      });
      return { patch, expiresAt: expiresAt.toISOString() };
    });
  }

  appendPatchHunk(input: AppendDocumentPatchHunkInput & {
    sessionId: string;
  }): Promise<{ duplicate: boolean; patch: DocumentPatch; nextSequence: number }> {
    return this.queue.enqueue(() => {
      const row = this.requireBuildingPatch(input.patchId, input.sessionId);
      const markdown = input.markdown ?? "";
      const hash = sha256(JSON.stringify({
        operation: input.operation,
        target: input.target,
        markdown,
      }));
      const existing = this.db.select().from(documentPatchHunks).where(and(
        eq(documentPatchHunks.patchId, input.patchId),
        eq(documentPatchHunks.sequence, input.sequence),
      )).get();
      if (existing) {
        if (existing.sha256 !== hash) {
          throw new DocumentServiceError("SEQUENCE_CONFLICT", "Patch sequence contains different content", 409);
        }
        return { duplicate: true, patch: this.getPatch(input.patchId)!, nextSequence: row.nextSequence };
      }
      if (!Number.isSafeInteger(input.sequence) || input.sequence !== row.nextSequence) {
        throw new DocumentServiceError("SEQUENCE_GAP", "Patch hunks must be strictly consecutive", 409);
      }
      if (Buffer.byteLength(markdown, "utf8") > CHUNK_MAX_BYTES) {
        throw new DocumentServiceError("SIZE_LIMIT", "Patch hunk exceeds 64 KiB");
      }
      if (input.operation === "delete" && markdown.trim()) {
        throw new DocumentServiceError("INVALID_PATCH", "Delete hunks cannot contain replacement Markdown");
      }
      if (input.operation !== "delete" && !markdown.trim()) {
        throw new DocumentServiceError("INVALID_PATCH", "Insert and replace hunks require Markdown");
      }
      for (const blockId of patchTargetBlockIds(input.target)) {
        if (!findBlockPath(row.baseContentJson, blockId)) {
          throw new DocumentServiceError("BLOCK_NOT_FOUND", "Patch target is not present in the base version", 409);
        }
      }
      const existingHunks = this.db.select().from(documentPatchHunks)
        .where(eq(documentPatchHunks.patchId, input.patchId)).all();
      if (row.kind === "continue") {
        if (input.operation !== "insert") {
          throw new DocumentServiceError("INVALID_CONTINUATION", "Continuation patches only support insert hunks");
        }
        if (existingHunks.length > 0) {
          throw new DocumentServiceError(
            "INVALID_CONTINUATION",
            "Continuation content must be sent as one rich Markdown hunk",
          );
        }
      }
      const patchBytes = existingHunks.reduce(
        (total, hunk) => total + Buffer.byteLength(hunk.markdown, "utf8"),
        Buffer.byteLength(markdown, "utf8"),
      );
      if (patchBytes > TRANSACTION_MAX_BYTES) {
        throw new DocumentServiceError("SIZE_LIMIT", "Document patch exceeds 2 MiB");
      }
      if (existingHunks.some((hunk) => targetsOverlap(row.baseContentJson, hunk.target, input.target))) {
        throw new DocumentServiceError("PATCH_HUNK_OVERLAP", "Patch hunks must be independently applicable", 409);
      }
      const parsed = input.operation === "delete"
        ? { type: "doc", content: [] } satisfies TiptapJsonContent
        : this.parseMarkdown(markdown, input.patchId);
      const afterNormalized = this.normalizeContent(
        row.documentId,
        row.roomId,
        parsed,
      );
      const after = afterNormalized.content.content ?? [];
      const applied = applyDocumentPatchHunk(
        row.proposedContentJson,
        input.operation,
        input.target,
        after,
      );
      const normalizedProposal = this.normalizeContent(
        row.documentId,
        row.roomId,
        applied.content,
        row.proposedContentJson,
      );
      const addedCharacters = tiptapText({ type: "doc", content: after }).length;
      const deletedCharacters = tiptapText({ type: "doc", content: applied.before }).length;
      const now = new Date();
      const nextSequence = input.sequence + 1;
      const expiresAt = new Date(now.getTime() + PATCH_TTL_MS);
      this.db.transaction((tx) => {
        tx.insert(documentPatchHunks).values({
          id: randomUUID(),
          patchId: row.id,
          sequence: input.sequence,
          operation: input.operation,
          target: input.target,
          markdown,
          sha256: hash,
          beforeJson: applied.before,
          afterJson: after,
          addedCharacters,
          deletedCharacters,
          createdAt: now,
        }).run();
        tx.update(documentPatches).set({
          proposedContentJson: normalizedProposal.content,
          nextSequence,
          expiresAt,
          updatedAt: now,
        }).where(eq(documentPatches.id, row.id)).run();
      });
      return { duplicate: false, patch: this.getPatch(row.id)!, nextSequence };
    });
  }

  commitPatch(input: {
    patchId: string;
    sessionId: string;
    finalSequence: number;
  }): Promise<DocumentPatch> {
    return this.queue.enqueue(() => {
      const row = this.requireBuildingPatch(input.patchId, input.sessionId);
      if (input.finalSequence !== row.nextSequence - 1) {
        throw new DocumentServiceError("SEQUENCE_GAP", "Final patch sequence does not match received hunks", 409);
      }
      if (input.finalSequence < 1) throw new DocumentServiceError("EMPTY_PATCH", "Patch has no hunks");
      if (row.kind === "continue" && continuationBlocks(
        this.db.select().from(documentPatchHunks)
          .where(eq(documentPatchHunks.patchId, row.id))
          .orderBy(asc(documentPatchHunks.sequence)).all().map(toPatchHunk),
      ).length === 0) {
        throw new DocumentServiceError("EMPTY_CONTINUATION", "Continuation patch has no content blocks");
      }
      const now = new Date();
      this.db.update(documentPatches).set({
        status: "pending",
        expiresAt: null,
        updatedAt: now,
      }).where(eq(documentPatches.id, row.id)).run();
      const patch = this.getPatch(row.id)!;
      this.publish(row.roomId, row.documentId, null, "document.patch-prepared", {
        patch: this.patchEventSummary(patch),
      });
      return patch;
    });
  }

  abortPatch(patchId: string, sessionId: string, reason = "agent-aborted"): Promise<void> {
    return this.queue.enqueue(() => {
      const row = this.requireBuildingPatch(patchId, sessionId);
      this.finishPatch(row, "aborted", "document.patch-aborted", { reason });
    });
  }

  abortSessionPatches(sessionId: string, reason: string): Promise<void> {
    return this.queue.enqueue(() => {
      const rows = this.db.select().from(documentPatches).where(and(
        eq(documentPatches.agentSessionId, sessionId),
        eq(documentPatches.status, "building"),
      )).all();
      for (const row of rows) this.finishPatch(row, "aborted", "document.patch-aborted", { reason });
    });
  }

  acceptContinuationBlock(
    patchId: string,
    input: AcceptDocumentContinuationBlockInput,
  ): Promise<AcceptDocumentContinuationBlockResult> {
    return this.queue.enqueue(() => {
      const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
      if (!row) throw new DocumentServiceError("PATCH_NOT_FOUND", "Document patch not found", 404);
      if (row.kind !== "continue") {
        throw new DocumentServiceError("INVALID_CONTINUATION", "Only continuation patches support block acceptance");
      }
      let patch = this.getPatch(row.id)!;
      const document = this.get(row.documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (patch.acceptedBlockIds.includes(input.blockId)) {
        return { patch, document, nextPendingBlock: patch.nextPendingBlock };
      }
      if (row.status !== "pending") {
        throw new DocumentServiceError(
          row.status === "conflicted" ? "PATCH_CONFLICT" : "PATCH_FINALIZED",
          `Continuation cannot advance from ${row.status}`,
          409,
        );
      }
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      const expectedVersion = row.appliedVersion ?? row.baseVersion;
      if (input.baseVersion !== expectedVersion || document.version !== expectedVersion) {
        this.conflictPatch(row, document.version);
        throw new DocumentServiceError("PATCH_CONFLICT", "Document version has changed", 409, {
          currentVersion: document.version,
          currentDocument: document,
        });
      }
      const candidate = patch.nextPendingBlock;
      if (!candidate || candidate.blockId !== input.blockId) {
        throw new DocumentServiceError(
          "CONTINUATION_OUT_OF_ORDER",
          "Accept the currently pending continuation block first",
          409,
        );
      }
      const applied = applyDocumentPatchHunk(
        document.contentJson,
        "insert",
        candidate.target,
        [candidate.contentJson],
      );
      const normalized = this.normalizeContent(row.documentId, row.roomId, applied.content, document.contentJson);
      const acceptedBlockIds = [...patch.acceptedBlockIds, candidate.blockId];
      const rejectedBlockIds = patch.rejectedBlockIds;
      const decidedBlockIds = new Set([...acceptedBlockIds, ...rejectedBlockIds]);
      const remaining = patch.continuationBlocks.filter((block) => !decidedBlockIds.has(block.blockId));
      const completed = remaining.length === 0;
      const nextVersion = document.version + 1;
      const now = new Date();
      this.db.transaction((tx) => {
        tx.update(documents).set({
          contentJson: normalized.content,
          version: nextVersion,
          updatedAt: now,
        }).where(eq(documents.id, row.documentId)).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId: row.documentId,
          version: nextVersion,
          contentJson: normalized.content,
          sourcePatchId: row.id,
          createdAt: now,
        }).run();
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, row.documentId)).run();
        if (normalized.blocks.length > 0) {
          tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
        tx.update(documentPatches).set({
          status: completed ? "applied" : "pending",
          acceptedBlockIds,
          rejectedBlockIds,
          appliedVersion: nextVersion,
          ...(completed ? { completedAt: now } : {}),
          updatedAt: now,
        }).where(eq(documentPatches.id, row.id)).run();
      });
      const updatedDocument = this.get(row.documentId)!;
      patch = this.getPatch(row.id)!;
      this.markPendingPatchesConflicted(row.documentId, nextVersion, row.id);
      this.publish(row.roomId, row.documentId, null, "document.patch-continuation-advanced", {
        patch: this.patchEventSummary(patch),
        document: updatedDocument,
        acceptedBlockId: candidate.blockId,
        nextPendingBlock: patch.nextPendingBlock,
      });
      if (completed) {
        this.publish(row.roomId, row.documentId, null, "document.patch-applied", {
          patch: this.patchEventSummary(patch),
          acceptedBlockIds,
          rejectedBlockIds,
          document: updatedDocument,
        });
      }
      this.onDocumentPatchApplied?.({
        sessionId: row.agentSessionId,
        roomId: row.roomId,
        runId: row.runId,
        patchId: row.id,
        documentId: row.documentId,
        title: updatedDocument.title,
        instruction: row.summary,
        originalText: "",
        replacementText: tiptapText(candidate.contentJson),
      });
      return { patch, document: updatedDocument, nextPendingBlock: patch.nextPendingBlock };
    });
  }

  rejectContinuationBlock(
    patchId: string,
    input: RejectDocumentContinuationBlockInput,
  ): Promise<RejectDocumentContinuationBlockResult> {
    return this.queue.enqueue(() => {
      const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
      if (!row) throw new DocumentServiceError("PATCH_NOT_FOUND", "Document patch not found", 404);
      if (row.kind !== "continue") {
        throw new DocumentServiceError("INVALID_CONTINUATION", "Only continuation patches support block rejection");
      }
      let patch = this.getPatch(row.id)!;
      if (patch.rejectedBlockIds.includes(input.blockId)) {
        return { patch, nextPendingBlock: patch.nextPendingBlock };
      }
      if (row.status !== "pending") {
        throw new DocumentServiceError(
          row.status === "conflicted" ? "PATCH_CONFLICT" : "PATCH_FINALIZED",
          `Continuation cannot advance from ${row.status}`,
          409,
        );
      }
      const document = this.get(row.documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      const expectedVersion = row.appliedVersion ?? row.baseVersion;
      if (input.baseVersion !== expectedVersion || document.version !== expectedVersion) {
        this.conflictPatch(row, document.version);
        throw new DocumentServiceError("PATCH_CONFLICT", "Document version has changed", 409, {
          currentVersion: document.version,
          currentDocument: document,
        });
      }
      const candidate = patch.nextPendingBlock;
      if (!candidate || candidate.blockId !== input.blockId) {
        throw new DocumentServiceError(
          "CONTINUATION_OUT_OF_ORDER",
          "Reject the currently pending continuation block first",
          409,
        );
      }
      const rejectedBlockIds = [...patch.rejectedBlockIds, candidate.blockId];
      const decidedBlockIds = new Set([...patch.acceptedBlockIds, ...rejectedBlockIds]);
      const completed = patch.continuationBlocks.every((block) => decidedBlockIds.has(block.blockId));
      const status = completed
        ? (patch.acceptedBlockIds.length > 0 ? "applied" : "rejected")
        : "pending";
      const now = new Date();
      this.db.update(documentPatches).set({
        status,
        rejectedBlockIds,
        ...(completed ? { completedAt: now, expiresAt: null } : {}),
        updatedAt: now,
      }).where(eq(documentPatches.id, row.id)).run();
      patch = this.getPatch(row.id)!;
      this.publish(row.roomId, row.documentId, null, "document.patch-continuation-advanced", {
        patch: this.patchEventSummary(patch),
        rejectedBlockId: candidate.blockId,
        nextPendingBlock: patch.nextPendingBlock,
      });
      if (completed && status === "applied") {
        this.publish(row.roomId, row.documentId, null, "document.patch-applied", {
          patch: this.patchEventSummary(patch),
          acceptedBlockIds: patch.acceptedBlockIds,
          rejectedBlockIds,
          document,
        });
      } else if (completed) {
        this.publish(row.roomId, row.documentId, null, "document.patch-rejected", {
          patch: this.patchEventSummary(patch),
        });
      }
      return { patch, nextPendingBlock: patch.nextPendingBlock };
    });
  }

  closeContinuation(patchId: string): Promise<DocumentPatch> {
    return this.queue.enqueue(() => {
      const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
      if (!row) throw new DocumentServiceError("PATCH_NOT_FOUND", "Document patch not found", 404);
      if (row.kind !== "continue") {
        throw new DocumentServiceError("INVALID_CONTINUATION", "Only continuation patches can be closed");
      }
      if (row.status === "applied" || row.status === "rejected") return this.getPatch(row.id)!;
      if (row.status !== "pending" && row.status !== "conflicted") {
        throw new DocumentServiceError("PATCH_FINALIZED", `Continuation cannot be closed from ${row.status}`, 409);
      }
      const current = this.getPatch(row.id)!;
      const acceptedBlockIds = current.acceptedBlockIds;
      const rejectedBlockIds = current.continuationBlocks
        .map((block) => block.blockId)
        .filter((blockId) => !acceptedBlockIds.includes(blockId));
      const status = acceptedBlockIds.length > 0 ? "applied" : "rejected";
      const now = new Date();
      this.db.update(documentPatches).set({
        status,
        rejectedBlockIds,
        completedAt: now,
        updatedAt: now,
        expiresAt: null,
      }).where(eq(documentPatches.id, row.id)).run();
      const patch = this.getPatch(row.id)!;
      const document = this.get(row.documentId);
      if (status === "applied" && document) {
        this.publish(row.roomId, row.documentId, null, "document.patch-applied", {
          patch: this.patchEventSummary(patch),
          acceptedBlockIds,
          rejectedBlockIds,
          document,
        });
      } else {
        this.publish(row.roomId, row.documentId, null, "document.patch-rejected", {
          patch: this.patchEventSummary(patch),
        });
      }
      return patch;
    });
  }

  applyPatch(patchId: string, input: ApplyDocumentPatchInput): Promise<ApplyDocumentPatchResult> {
    return this.queue.enqueue(() => {
      const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
      if (!row) throw new DocumentServiceError("PATCH_NOT_FOUND", "Document patch not found", 404);
      if (row.kind === "continue") {
        throw new DocumentServiceError(
          "CONTINUATION_REQUIRES_BLOCK_ACCEPT",
          "Continuation patches must be accepted one block at a time",
          409,
        );
      }
      const requestedIds = [...new Set(input.acceptedHunkIds)].sort();
      if (row.status === "applied") {
        const accepted = [...(row.acceptedHunkIds ?? [])].sort();
        if (input.baseVersion === row.baseVersion && JSON.stringify(accepted) === JSON.stringify(requestedIds)) {
          const document = this.get(row.documentId);
          if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
          return { patch: this.getPatch(row.id)!, document };
        }
        throw new DocumentServiceError("PATCH_FINALIZED", "Patch has already been finalized", 409);
      }
      if (row.status !== "pending") {
        throw new DocumentServiceError(
          row.status === "conflicted" ? "PATCH_CONFLICT" : "PATCH_FINALIZED",
          `Patch cannot be applied from ${row.status}`,
          409,
          row.conflictVersion ? { currentVersion: row.conflictVersion } : undefined,
        );
      }
      if (requestedIds.length === 0) {
        throw new DocumentServiceError("EMPTY_PATCH_SELECTION", "Apply requires at least one accepted hunk");
      }
      const document = this.get(row.documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      if (input.baseVersion !== row.baseVersion || document.version !== row.baseVersion) {
        this.conflictPatch(row, document.version);
        throw new DocumentServiceError("PATCH_CONFLICT", "Document version has changed", 409, {
          currentVersion: document.version,
          currentDocument: document,
        });
      }
      const hunkRows = this.db.select().from(documentPatchHunks)
        .where(eq(documentPatchHunks.patchId, patchId))
        .orderBy(asc(documentPatchHunks.sequence)).all();
      const allIds = new Set(hunkRows.map((hunk) => hunk.id));
      if (requestedIds.some((id) => !allIds.has(id))) {
        throw new DocumentServiceError("INVALID_HUNK_SELECTION", "Accepted hunk does not belong to this patch");
      }
      let content = row.baseContentJson;
      for (const hunk of hunkRows) {
        if (!requestedIds.includes(hunk.id)) continue;
        content = applyDocumentPatchHunk(content, hunk.operation, hunk.target, hunk.afterJson).content;
      }
      const normalized = this.normalizeContent(row.documentId, row.roomId, content, row.baseContentJson);
      const rejectedIds = hunkRows.map((hunk) => hunk.id).filter((id) => !requestedIds.includes(id));
      const nextVersion = document.version + 1;
      const now = new Date();
      this.db.transaction((tx) => {
        tx.update(documents).set({
          contentJson: normalized.content,
          version: nextVersion,
          updatedAt: now,
        }).where(eq(documents.id, row.documentId)).run();
        tx.insert(documentVersions).values({
          id: randomUUID(),
          documentId: row.documentId,
          version: nextVersion,
          contentJson: normalized.content,
          sourcePatchId: row.id,
          createdAt: now,
        }).run();
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, row.documentId)).run();
        if (normalized.blocks.length > 0) {
          tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
        tx.update(documentPatches).set({
          status: "applied",
          acceptedHunkIds: requestedIds,
          rejectedHunkIds: rejectedIds,
          appliedVersion: nextVersion,
          completedAt: now,
          updatedAt: now,
        }).where(eq(documentPatches.id, row.id)).run();
      });
      const updatedDocument = this.get(row.documentId)!;
      const patch = this.getPatch(row.id)!;
      this.markPendingPatchesConflicted(row.documentId, nextVersion, row.id);
      this.publish(row.roomId, row.documentId, null, "document.patch-applied", {
        patch: this.patchEventSummary(patch),
        acceptedHunkIds: requestedIds,
        rejectedHunkIds: rejectedIds,
        document: updatedDocument,
      });
      this.onDocumentPatchApplied?.({
        sessionId: row.agentSessionId,
        roomId: row.roomId,
        runId: row.runId,
        patchId: row.id,
        documentId: row.documentId,
        title: updatedDocument.title,
        instruction: row.summary,
        originalText: tiptapText(row.baseContentJson),
        replacementText: tiptapText(normalized.content),
      });
      return { patch, document: updatedDocument };
    });
  }

  rejectPatch(patchId: string): Promise<DocumentPatch> {
    return this.queue.enqueue(() => {
      const row = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
      if (!row) throw new DocumentServiceError("PATCH_NOT_FOUND", "Document patch not found", 404);
      if (row.status === "rejected") return this.getPatch(row.id)!;
      if (row.status !== "pending" && row.status !== "conflicted") {
        throw new DocumentServiceError("PATCH_FINALIZED", `Patch cannot be rejected from ${row.status}`, 409);
      }
      const rejectedHunkIds = this.db.select({ id: documentPatchHunks.id }).from(documentPatchHunks)
        .where(eq(documentPatchHunks.patchId, patchId)).all().map(({ id }) => id);
      const now = new Date();
      this.db.update(documentPatches).set({
        status: "rejected",
        acceptedHunkIds: [],
        rejectedHunkIds,
        completedAt: now,
        updatedAt: now,
      }).where(eq(documentPatches.id, row.id)).run();
      const patch = this.getPatch(row.id)!;
      this.publish(row.roomId, row.documentId, null, "document.patch-rejected", {
        patch: this.patchEventSummary(patch),
      });
      return patch;
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
    const markdown = this.db.select({ markdown: documentOps.markdown })
      .from(documentOps)
      .where(eq(documentOps.transactionId, input.transactionId))
      .orderBy(asc(documentOps.sequence))
      .all()
      .map((operation) => operation.markdown)
      .join("") + input.text;
    const parsed = this.parseMarkdown(markdown, input.transactionId);
    const normalized = this.normalizeContent(
      transaction.documentId,
      transaction.roomId,
      parsed,
      transaction.workingContentJson as TiptapJsonContent,
    );
    const content = normalized.content;
    this.db.transaction((tx) => {
      tx.insert(documentOps).values({
        id: randomUUID(),
        transactionId: input.transactionId,
        sequence: input.sequence,
        markdown: input.text,
        sha256: hash,
        byteLength: bytes,
        appliedContentJson: content,
        createdAt: now,
      }).run();
      tx.update(documentTransactions).set({
        nextSequence,
        totalBytes,
        workingContentJson: content,
        expiresAt,
        updatedAt: now,
      })
        .where(eq(documentTransactions.id, input.transactionId)).run();
      tx.update(documents).set({ contentJson: content, updatedAt: now })
        .where(eq(documents.id, transaction.documentId)).run();
      tx.delete(documentBlocks).where(eq(documentBlocks.documentId, transaction.documentId)).run();
      if (normalized.blocks.length > 0) {
        tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
          id: block.id,
          documentId: block.documentId,
          parentBlockId: block.parentBlockId,
          type: block.type,
          ordinal: block.ordinal,
          path: block.path,
          textPreview: block.textPreview,
        }))).run();
      }
    });
    return {
      transaction: { ...transaction, nextSequence, totalBytes, expiresAt },
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

  private requireBuildingPatch(patchId: string, sessionId: string) {
    const patch = this.db.select().from(documentPatches).where(eq(documentPatches.id, patchId)).get();
    if (!patch || patch.status !== "building") {
      throw new DocumentServiceError("PATCH_NOT_FOUND", "Building patch not found", 404);
    }
    if (patch.agentSessionId !== sessionId) {
      throw new DocumentServiceError("PATCH_FORBIDDEN", "Patch belongs to another Agent session", 403);
    }
    if (!patch.expiresAt || patch.expiresAt.getTime() <= Date.now()) {
      this.finishPatch(patch, "expired", "document.patch-expired", { reason: "patch-expired" });
      throw new DocumentServiceError("PATCH_EXPIRED", "Document patch expired", 410);
    }
    return patch;
  }

  private patchEventSummary(patch: DocumentPatch): DocumentPatchSummary {
    const {
      baseContentJson: _base,
      proposedContentJson: _proposed,
      hunks: _hunks,
      continuationBlocks: _continuationBlocks,
      nextPendingBlock: _nextPendingBlock,
      ...summary
    } = patch;
    return summary;
  }

  private finishPatch(
    patch: typeof documentPatches.$inferSelect,
    status: "aborted" | "expired",
    event: "document.patch-aborted" | "document.patch-expired",
    payload: Record<string, unknown>,
  ): void {
    const now = new Date();
    this.db.update(documentPatches).set({
      status,
      completedAt: now,
      updatedAt: now,
      expiresAt: null,
    }).where(eq(documentPatches.id, patch.id)).run();
    this.publish(patch.roomId, patch.documentId, null, event, {
      patchId: patch.id,
      documentId: patch.documentId,
      ...payload,
    });
  }

  private conflictPatch(patch: typeof documentPatches.$inferSelect, currentVersion: number): void {
    const now = new Date();
    this.db.update(documentPatches).set({
      status: "conflicted",
      conflictVersion: currentVersion,
      updatedAt: now,
    }).where(eq(documentPatches.id, patch.id)).run();
    const current = this.getPatch(patch.id)!;
    this.publish(patch.roomId, patch.documentId, null, "document.patch-conflicted", {
      patch: this.patchEventSummary(current),
      currentVersion,
    });
  }

  private markPendingPatchesConflicted(
    documentId: string,
    currentVersion: number,
    exceptPatchId?: string,
  ): void {
    const pending = this.db.select().from(documentPatches).where(and(
      eq(documentPatches.documentId, documentId),
      eq(documentPatches.status, "pending"),
    )).all();
    for (const patch of pending) {
      if (patch.id !== exceptPatchId && patch.baseVersion !== currentVersion) {
        this.conflictPatch(patch, currentVersion);
      }
    }
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
    this.db.transaction((tx) => {
      tx.update(documentTransactions).set({ status, completedAt: now, updatedAt: now })
        .where(eq(documentTransactions.id, transaction.id)).run();
      tx.delete(documents).where(eq(documents.id, transaction.documentId)).run();
    });
  }

  private parseMarkdown(markdown: string, transactionId: string): TiptapJsonContent {
    void transactionId;
    return this.markdown.parse(markdown) as TiptapJsonContent;
  }

  private normalizeContent(
    documentId: string,
    roomId: string,
    content: TiptapJsonContent,
    previous?: TiptapJsonContent,
  ) {
    for (const reference of collectDocumentReferences(content)) {
      if (reference.roomId !== roomId) {
        throw new DocumentServiceError(
          "CROSS_ROOM_REFERENCE",
          "Document block references must stay in one Room",
          409,
        );
      }
      const target = this.get(reference.documentId);
      if (target && target.roomId !== roomId) {
        throw new DocumentServiceError(
          "CROSS_ROOM_REFERENCE",
          "Referenced document belongs to another Room",
          409,
        );
      }
    }
    const owners = new Map(this.db.select({ id: documentBlocks.id, documentId: documentBlocks.documentId })
      .from(documentBlocks).all().map((row) => [row.id, row.documentId] as const));
    return normalizeDocumentContent(content, documentId, roomId, {
      ...(previous ? { previous } : {}),
      owners,
    });
  }

  private normalizeStoredDocuments(): void {
    const rows = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .orderBy(asc(documents.createdAt)).all();
    const owners = new Map<string, string>();
    this.db.transaction((tx) => {
      for (const row of rows) {
        const normalized = normalizeDocumentContent(
          row.document.contentJson as TiptapJsonContent,
          row.document.id,
          row.roomId,
          { owners },
        );
        if (normalized.changed) {
          tx.update(documents).set({ contentJson: normalized.content })
            .where(eq(documents.id, row.document.id)).run();
          tx.update(documentVersions).set({ contentJson: normalized.content }).where(and(
            eq(documentVersions.documentId, row.document.id),
            eq(documentVersions.version, row.document.version),
          )).run();
        }
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, row.document.id)).run();
        if (normalized.blocks.length > 0) {
          tx.insert(documentBlocks).values(normalized.blocks.map((block) => ({
            id: block.id,
            documentId: block.documentId,
            parentBlockId: block.parentBlockId,
            type: block.type,
            ordinal: block.ordinal,
            path: block.path,
            textPreview: block.textPreview,
          }))).run();
        }
      }
    });
  }

  private recoverInterruptedTransactions(): void {
    const open = this.db.select().from(documentTransactions)
      .where(eq(documentTransactions.status, "open")).all();
    for (const transaction of open) this.abortRow(transaction, "gateway-restarted", "interrupted");
  }

  private recoverInterruptedPatches(): void {
    const building = this.db.select().from(documentPatches)
      .where(eq(documentPatches.status, "building")).all();
    for (const patch of building) {
      this.finishPatch(patch, "aborted", "document.patch-aborted", { reason: "gateway-restarted" });
    }
  }

  private expireTransactions(): Promise<void> {
    return this.queue.enqueue(() => {
      const expired = this.db.select().from(documentTransactions).where(and(
        eq(documentTransactions.status, "open"),
        lt(documentTransactions.expiresAt, new Date()),
      )).all();
      for (const transaction of expired) this.abortRow(transaction, "transaction-expired", "expired");
      const expiredPatches = this.db.select().from(documentPatches).where(and(
        eq(documentPatches.status, "building"),
        lt(documentPatches.expiresAt, new Date()),
      )).all();
      for (const patch of expiredPatches) {
        this.finishPatch(patch, "expired", "document.patch-expired", { reason: "patch-expired" });
      }
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
