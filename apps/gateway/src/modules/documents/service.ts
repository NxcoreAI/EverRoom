import { randomUUID } from "node:crypto";
import type {
  AgentActiveDocumentContext,
  DocumentBlockResolution,
  DocumentBlockBacklink,
  DocumentBlockSummary,
  DocumentEvent,
  DocumentVersionSummary,
  DocumentVersionSnapshot,
  DocumentDiffResult,
  ImportRoomDocumentInput,
  ResolveDocumentBlockReferencesInput,
  RoomDocument,
  SaveRoomDocumentInput,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { and, asc, eq } from "drizzle-orm";
import { freshenDocumentContent } from "@nxcore/document-model";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documentVersions,
  documents,
  jobs,
  roomDocumentLinks,
} from "../../infrastructure/database/schema.js";
import {
  documentBodyContent,
  findBlockPath,
  nodeAtPath,
  tiptapText,
} from "./content-model.js";
import { DocumentEventBroker } from "./event-broker.js";
import { DocumentServiceError } from "./errors.js";
import { DOCUMENT_HISTORY_BACKFILL_JOB_TYPE } from "./integration-outbox.js";
import {
  DocumentCommitService,
  DocumentContentEngine,
  DocumentLifecycleService,
  DocumentQueryService,
  DocumentRepository,
  YjsHistoryService,
  type AtomicDocumentCreateInput,
  type AtomicDocumentCommitInput,
} from "./core/index.js";
import { agentDocumentMarkdown, sanitizeAgentDocumentTables } from "./agent-markdown.js";
import type { SelectionRewriteContentResolver } from "./capabilities/selection-rewrite-content.js";

export { DocumentServiceError } from "./errors.js";

const TRANSACTION_MAX_BYTES = 2 * 1024 * 1024;

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
  documentId: string;
  title: string;
  markdown: string;
}

export interface PreparedAgentDocumentCommit {
  commit: AtomicDocumentCommitInput;
  afterCommit: (document?: RoomDocument) => void;
}

export type DocumentCommittedHandler = (document: CommittedAgentDocument) => void;

export interface AppliedAgentDocumentRewrite {
  sessionId: string;
  roomId: string;
  runId: string;
  operationId: string;
  documentId: string;
  title: string;
  instruction: string;
  originalText: string;
  replacementText: string;
}

export type DocumentRewriteAppliedHandler = (patch: AppliedAgentDocumentRewrite) => void;
export interface DocumentVersionAdvanceCoordination {
  mutate(tx: GatewayDatabase, now: Date): void;
  afterCommit?(): void;
}

export type DocumentVersionCommittedHandler = (
  documentId: string,
  currentVersion: number,
) => DocumentVersionAdvanceCoordination;

export type DocumentAfterCommitErrorHandler = (
  error: unknown,
  documentId: string,
  currentVersion: number,
) => void;

function assertContentJson(value: unknown): asserts value is TiptapJsonContent {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "doc") {
    throw new DocumentServiceError("INVALID_CONTENT", "Document content must be a Tiptap document");
  }
}

function comparableDocumentTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

function stripRedundantLeadingDocumentHeading(
  source: TiptapJsonContent,
  title: string,
): { content: TiptapJsonContent; changed: boolean; removedHeadingLevel: number | null } {
  const content = structuredClone(documentBodyContent(source));
  const children = [...(content.content ?? [])];
  let changed = JSON.stringify(content) !== JSON.stringify(source);
  let removedHeadingLevel: number | null = null;
  const firstVisibleIndex = children.findIndex((node) =>
    tiptapText(node).trim().length > 0 || node.type !== "paragraph");
  const firstVisible = firstVisibleIndex >= 0 ? children[firstVisibleIndex] : undefined;
  if (
    firstVisible?.type === "heading"
    && comparableDocumentTitle(tiptapText(firstVisible)) === comparableDocumentTitle(title)
  ) {
    removedHeadingLevel = typeof firstVisible.attrs?.level === "number"
      ? firstVisible.attrs.level
      : null;
    children.splice(firstVisibleIndex, 1);
    changed = true;
  }
  return { content: { ...content, content: children }, changed, removedHeadingLevel };
}

function promoteBodyHeadings(
  source: TiptapJsonContent,
): { content: TiptapJsonContent; changed: boolean } {
  const children = [...(source.content ?? [])];
  const levels = children.flatMap((node) =>
    node.type === "heading" && typeof node.attrs?.level === "number"
      ? [node.attrs.level]
      : []);
  const shallowest = levels.length ? Math.min(...levels) : 2;
  const offset = Math.max(0, shallowest - 2);
  if (!offset) return { content: source, changed: false };
  return {
    content: {
      ...source,
      content: children.map((node) => {
        const level = node.type === "heading" ? node.attrs?.level : undefined;
        return typeof level === "number"
          ? { ...node, attrs: { ...node.attrs, level: Math.max(2, level - offset) } }
          : node;
      }),
    },
    changed: true,
  };
}

function normalizePersistedDocumentBody(
  source: TiptapJsonContent,
  title: string,
): { content: TiptapJsonContent; changed: boolean } {
  const stripped = stripRedundantLeadingDocumentHeading(source, title);
  const promoted = promoteBodyHeadings(stripped.content);
  return {
    content: promoted.content,
    changed: stripped.changed || promoted.changed,
  };
}

function normalizeAgentDocumentBody(
  source: TiptapJsonContent,
  title: string,
): { content: TiptapJsonContent; changed: boolean } {
  const stripped = stripRedundantLeadingDocumentHeading(source, title);
  const promoted = stripped.removedHeadingLevel !== null
    ? promoteBodyHeadings(stripped.content)
    : { content: stripped.content, changed: false };
  const children = [...(promoted.content.content ?? [])];
  let changed = stripped.changed || promoted.changed;
  const shiftHeadingHierarchy = children.some((node) =>
    node.type === "heading" && node.attrs?.level === 1);
  const normalizedChildren = children.map((node) => {
    const level = node.type === "heading" ? node.attrs?.level : undefined;
    if (!shiftHeadingHierarchy || typeof level !== "number") return node;
    changed = true;
    return { ...node, attrs: { ...node.attrs, level: Math.min(level + 1, 6) } };
  });
  return { content: { ...promoted.content, content: normalizedChildren }, changed };
}

function normalizeCompleteAgentDocumentBody(
  source: TiptapJsonContent,
  title: string,
): { content: TiptapJsonContent; changed: boolean } {
  const agentNormalized = normalizeAgentDocumentBody(source, title);
  const persisted = normalizePersistedDocumentBody(agentNormalized.content, title);
  const tables = sanitizeAgentDocumentTables(persisted.content);
  return {
    content: tables.content,
    changed: agentNormalized.changed || persisted.changed || tables.changed,
  };
}

export class DocumentService {
  private readonly queue = new DocumentWriteQueue();
  private readonly repository: DocumentRepository;
  private readonly contentEngine: DocumentContentEngine;
  private readonly commitService: DocumentCommitService;
  private readonly queryService: DocumentQueryService;
  private readonly lifecycleService: DocumentLifecycleService;
  private readonly yjsHistory: YjsHistoryService;

  /**
   * 改写信任收口（agent-architecture-optimization-plan §3）：
   * document.selection-rewrite 携带 invocationId 时的内容解析器。
   * 由 create-server 装配注入（orchestrator 取数 + 授权判定），
   * documents 模块不直接依赖 subagents / context-rooms。
   */
  resolveSelectionRewriteContent: SelectionRewriteContentResolver | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    readonly broker: DocumentEventBroker,
    private readonly onDocumentCommitted?: DocumentCommittedHandler,
    private readonly onDocumentRewriteApplied?: DocumentRewriteAppliedHandler,
    private readonly onDocumentVersionCommitted?: DocumentVersionCommittedHandler,
    private readonly onAfterCommitError?: DocumentAfterCommitErrorHandler,
  ) {
    this.repository = new DocumentRepository(db);
    this.contentEngine = new DocumentContentEngine({
      findDocumentRoom: (documentId) => this.repository.get(documentId)?.roomId ?? null,
    });
    this.yjsHistory = new YjsHistoryService();
    this.commitService = new DocumentCommitService(db, this.repository, this.contentEngine, {}, this.yjsHistory);
    this.queryService = new DocumentQueryService(db, this.repository, this.contentEngine);
    this.lifecycleService = new DocumentLifecycleService(db, this.repository, {
      trashed: (document) => this.publish(
        document.roomId,
        document.id,
        null,
        "document.changed",
        { document },
      ),
      restored: (document) => this.publish(
        document.roomId,
        document.id,
        null,
        "document.changed",
        { document },
      ),
      deleted: (document) => this.publish(
        document.roomId,
        document.id,
        null,
        "document.deleted",
        { documentId: document.id },
      ),
    });
    this.normalizeStoredDocuments();
  }

  list(roomId: string, trashed = false): RoomDocument[] {
    return this.queryService.list(roomId, trashed);
  }

  get(documentId: string): RoomDocument | null {
    return this.queryService.get(documentId);
  }

  listBlocks(documentId: string): DocumentBlockSummary[] {
    return this.queryService.listBlocks(documentId);
  }

  listBlockBacklinks(documentId: string, blockId?: string): DocumentBlockBacklink[] {
    return this.queryService.listBlockBacklinks(documentId, blockId);
  }

  listVersions(documentId: string, options: { limit?: number; beforeVersion?: number } = {}): DocumentVersionSummary[] {
    return this.queryService.listVersions(documentId, options);
  }

  getVersionSnapshot(documentId: string, version: number): DocumentVersionSnapshot | null {
    if (!this.get(documentId)) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    return this.queryService.getVersionSnapshot(documentId, version);
  }

  diff(documentId: string, fromVersion: number | null, toVersion: number): DocumentDiffResult | null {
    if (!this.get(documentId)) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    return this.queryService.diff(documentId, fromVersion, toVersion);
  }

  backfillYjsHistory(documentId: string, maxVersions = 50): number {
    if (!this.get(documentId)) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    return this.yjsHistory.backfillDocument(this.db, documentId, maxVersions);
  }

  isYjsHistoryComplete(documentId: string): boolean {
    if (!this.get(documentId)) return false;
    return this.yjsHistory.isHistoryComplete(this.db, documentId);
  }

  retryYjsHistoryBackfill(documentId: string): void {
    if (!this.get(documentId)) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    this.db.transaction((tx) => {
      const id = `document-history-backfill:${documentId}`;
      const existing = tx.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.id, id),
        eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE),
      )).get();
      const now = new Date();
      if (!existing) {
        tx.insert(jobs).values({
          id,
          type: DOCUMENT_HISTORY_BACKFILL_JOB_TYPE,
          status: "pending",
          payload: { documentId, attempts: 0 },
          createdAt: now,
          updatedAt: now,
        }).run();
        return;
      }
      tx.update(jobs).set({
        status: "pending",
        payload: { documentId, attempts: 0 },
        result: null,
        error: null,
        updatedAt: now,
      }).where(eq(jobs.id, id)).run();
    });
  }

  restoreVersion(documentId: string, version: number, baseVersion: number): Promise<RoomDocument> {
    return this.queue.enqueue(() => {
      const document = this.get(documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      if (document.version !== baseVersion) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409);
      }
      const historical = this.db.select().from(documentVersions).where(and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.version, version),
      )).get();
      if (!historical) throw new DocumentServiceError("VERSION_NOT_FOUND", "Document version not found", 404);
      const historicalContent = this.yjsHistory.materialize(this.db, documentId, version)?.content
        ?? historical.contentJson as TiptapJsonContent | null;
      if (!historicalContent) throw new DocumentServiceError("VERSION_CONTENT_UNAVAILABLE", "Document version content is unavailable", 409);
      const nextVersion = document.version + 1;
      const coordination = this.onDocumentVersionCommitted?.(documentId, nextVersion);
      const content = normalizePersistedDocumentBody(
        historicalContent,
        historical.title,
      ).content;
      const restored = this.commitService.commit({
        documentId,
        roomId: document.roomId,
        title: historical.title,
        content,
        expectedVersion: baseVersion,
        version: nextVersion,
        ...(coordination ? { mutate: (tx, _normalized, now) => coordination.mutate(tx, now) } : {}),
      });
      this.completeVersionAdvance(coordination, documentId, restored.version);
      this.publish(restored.roomId, documentId, null, "document.changed", { document: restored });
      return restored;
    });
  }

  resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): DocumentBlockResolution[] {
    return this.queryService.resolveBlockReferences(input);
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
      markdown = agentDocumentMarkdown.serialize(documentBodyContent(document.contentJson));
    } catch {
      markdown = blocks.map((block) => `<!-- block:${block.blockId} type:${block.type} -->\n${block.textPreview}`).join("\n\n");
    }
    return { document, blocks, markdown };
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
      const title = input.title.trim().slice(0, 120);
      const content = normalizePersistedDocumentBody(input.contentJson, title).content;
      const imported = this.commitService.create({
        documentId: input.id,
        roomId: input.roomId,
        title,
        content: freshenDocumentContent(content, input.id),
        version: 1,
      });
      this.publish(input.roomId, input.id, null, "document.changed", { document: imported });
      return imported;
    });
  }

  syncExternalMarkdown(input: {
    documentId: string;
    roomId: string;
    title: string;
    markdown: string;
  }): Promise<RoomDocument> {
    const title = input.title.trim().slice(0, 120);
    if (!title) throw new DocumentServiceError("INVALID_TITLE", "Document title cannot be empty");
    const contentJson = normalizePersistedDocumentBody(this.parseMarkdown(input.markdown), title).content;
    const existing = this.get(input.documentId);
    if (!existing) {
      return this.import({
        id: input.documentId,
        roomId: input.roomId,
        title,
        contentJson,
      });
    }
    if (existing.roomId !== input.roomId) {
      throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
    }
    return this.save(input.documentId, {
      baseVersion: existing.version,
      title,
      contentJson,
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
      const nextVersion = current.version + 1;
      const content = normalizePersistedDocumentBody(input.contentJson, title).content;
      const normalized = this.contentEngine.normalizeDocument(content, documentId, current.roomId, nextVersion);
      const contentChanged = JSON.stringify(current.contentJson) !== JSON.stringify(normalized.content);
      const titleChanged = current.title !== title;
      if (!contentChanged && !titleChanged) return current;
      if (current.version !== input.baseVersion) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
          documentId,
          currentVersion: current.version,
          currentDocument: current,
          retryable: true,
          nextAction: "refresh_document_before_save",
        });
      }
      const coordination = this.onDocumentVersionCommitted?.(documentId, nextVersion);
      const updated = this.commitService.commit({
        documentId,
        roomId: current.roomId,
        title,
        content: normalized.content,
        expectedVersion: input.baseVersion,
        version: nextVersion,
        ...(coordination ? { mutate: (tx, _normalized, now) => coordination.mutate(tx, now) } : {}),
      });
      this.completeVersionAdvance(coordination, documentId, updated.version);
      this.publish(updated.roomId, documentId, null, "document.changed", { document: updated });
      return updated;
    });
  }

  prepareOperationCommit(documentId: string, input: SaveRoomDocumentInput): AtomicDocumentCommitInput {
    assertContentJson(input.contentJson);
    const current = this.get(documentId);
    if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    if (current.deletedAt) {
      throw new DocumentServiceError("DOCUMENT_TRASHED", "Restore the document before editing it", 409);
    }
    if (current.activeTransactionId) {
      throw new DocumentServiceError("DOCUMENT_BUSY", "Agent is writing this document", 409);
    }
    if (current.version !== input.baseVersion) {
      throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
        currentVersion: current.version,
        currentDocument: current,
      });
    }
    const title = input.title === undefined ? current.title : input.title.trim();
    if (!title) throw new DocumentServiceError("INVALID_TITLE", "Document title cannot be empty");
    if (title.length > 120) {
      throw new DocumentServiceError("INVALID_TITLE", "Document title cannot exceed 120 characters");
    }
    const content = normalizePersistedDocumentBody(input.contentJson, title).content;
    return {
      documentId,
      roomId: current.roomId,
      title,
      content,
      expectedVersion: current.version,
      version: current.version + 1,
    };
  }

  prepareAgentDocumentDraft(input: {
    documentId: string;
    roomId: string;
    title: string;
    markdown: string;
  }): AtomicDocumentCreateInput {
    const title = input.title.trim();
    if (!title) throw new DocumentServiceError("INVALID_TITLE", "Document title cannot be empty");
    if (title.length > 120) {
      throw new DocumentServiceError("INVALID_TITLE", "Document title cannot exceed 120 characters");
    }
    if (Buffer.byteLength(input.markdown, "utf8") > TRANSACTION_MAX_BYTES) {
      throw new DocumentServiceError("SIZE_LIMIT", "Document operation exceeds 2 MiB");
    }
    const content = normalizeCompleteAgentDocumentBody(this.parseMarkdown(input.markdown), title).content;
    return {
      documentId: input.documentId,
      roomId: input.roomId,
      title,
      content,
    };
  }

  normalizeAgentDocumentChunk(title: string, markdown: string): string {
    if (!markdown) return markdown;
    const normalized = normalizeAgentDocumentBody(this.parseMarkdown(markdown), title);
    const tables = sanitizeAgentDocumentTables(normalized.content);
    return normalized.changed || tables.changed
      ? agentDocumentMarkdown.serialize(tables.content)
      : markdown;
  }

  prepareAgentDocumentFinalize(input: {
    operationId: string;
    documentId: string;
    roomId: string;
    title: string;
    markdown: string;
    sessionId: string;
    runId: string;
  }): PreparedAgentDocumentCommit {
    const draft = this.get(input.documentId);
    if (!draft
      || draft.roomId !== input.roomId
      || draft.status !== "draft"
      || draft.version !== 0
      || draft.activeTransactionId !== input.operationId) {
      throw new DocumentServiceError("DOCUMENT_BUSY", "Document draft is not owned by this operation", 409);
    }
    const normalizedBody = normalizeCompleteAgentDocumentBody(
      this.parseMarkdown(input.markdown),
      input.title,
    ).content;
    const markdown = agentDocumentMarkdown.serialize(normalizedBody);
    const prepared = this.prepareAgentDocumentDraft({ ...input, markdown });
    return {
      commit: {
        ...prepared,
        expectedVersion: 0,
        version: 1,
        status: "active",
        activeTransactionId: null,
        sourceTransactionId: input.operationId,
      },
      afterCommit: (document) => {
        if (!document) return;
        this.onDocumentCommitted?.({
          sessionId: input.sessionId,
          roomId: input.roomId,
          runId: input.runId,
          documentId: input.documentId,
          title: document.title,
          markdown,
        });
      },
    };
  }

  notifyDocumentRewriteApplied(input: AppliedAgentDocumentRewrite): void {
    this.onDocumentRewriteApplied?.(input);
  }

  delete(documentId: string): Promise<void> {
    return this.queue.enqueue(() => {
      this.lifecycleService.trash(documentId);
    });
  }

  restore(documentId: string): Promise<RoomDocument> {
    return this.queue.enqueue(() => {
      return this.lifecycleService.restore(documentId);
    });
  }

  deletePermanently(documentId: string): Promise<void> {
    return this.queue.enqueue(() => {
      this.lifecycleService.deletePermanently(documentId);
    });
  }

  emptyTrash(roomId: string): Promise<void> {
    return this.queue.enqueue(() => {
      this.lifecycleService.emptyTrash(roomId);
    });
  }


  private parseMarkdown(markdown: string): TiptapJsonContent {
    return agentDocumentMarkdown.parse(markdown) as TiptapJsonContent;
  }

  private normalizeStoredDocuments(): void {
    const rows = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .orderBy(asc(documents.createdAt)).all();
    for (const row of rows) {
      try {
        this.db.transaction((tx) => {
          const body = normalizePersistedDocumentBody(
            row.document.contentJson as TiptapJsonContent,
            row.document.title,
          );
          const normalized = this.contentEngine.normalizeStoredDocument(
            body.content,
            row.document.id,
            row.roomId,
            row.document.contentSchemaVersion,
            row.document.version,
          );
          // Each document is repaired atomically so one unavailable history
          // cannot leave partial writes or prevent healthy documents loading.
          if (body.changed || normalized.changed || row.document.contentSchemaVersion !== normalized.schemaVersion) {
            tx.update(documents).set({
              contentJson: normalized.content,
              contentSchemaVersion: normalized.schemaVersion,
            }).where(eq(documents.id, row.document.id)).run();
            tx.update(documentVersions).set({
              title: row.document.title,
              contentJson: normalized.content,
              contentSchemaVersion: normalized.schemaVersion,
            }).where(and(
              eq(documentVersions.documentId, row.document.id),
              eq(documentVersions.version, row.document.version),
            )).run();
            this.yjsHistory.rebuildDocument(tx, row.document.id);
          }
          this.repository.replaceProjection(tx, row.document.id, normalized);
        });
      } catch (error) {
        try {
          this.onAfterCommitError?.(error, row.document.id, row.document.version);
        } catch {}
      }
    }
  }

  private publish(
    roomId: string,
    documentId: string,
    operationId: string | null,
    type: DocumentEvent["type"],
    payload: unknown,
  ): void {
    this.broker.publish(this.createEvent(roomId, documentId, operationId, type, payload));
  }

  private completeVersionAdvance(
    coordination: DocumentVersionAdvanceCoordination | undefined,
    documentId: string,
    currentVersion: number,
  ): void {
    try {
      coordination?.afterCommit?.();
    } catch (error) {
      try {
        this.onAfterCommitError?.(error, documentId, currentVersion);
      } catch {}
    }
  }

  private createEvent(
    roomId: string,
    documentId: string,
    operationId: string | null,
    type: DocumentEvent["type"],
    payload: unknown,
  ): DocumentEvent {
    return {
      id: randomUUID(),
      roomId,
      documentId,
      operationId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
  }
}
