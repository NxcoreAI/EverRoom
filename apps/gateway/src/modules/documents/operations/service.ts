import { randomUUID } from "node:crypto";
import type {
  DocumentOperation,
  DocumentOperationCommandInput,
  DocumentOperationInteractionMode,
  DocumentOperationItem,
  DocumentOperationItemStatus,
  DocumentOperationStatus,
  DocumentOperationSummary,
  DocumentMutationTarget,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentOperationCommands,
  documentOperationEvents,
  documentOperationItems,
  documentOperations,
  documents,
} from "../../../infrastructure/database/schema.js";
import type { DocumentEventBroker } from "../event-broker.js";
import { DocumentServiceError } from "../errors.js";
import {
  DocumentCommitService,
  DocumentContentEngine,
  DocumentRepository,
  type AtomicDocumentCreateInput,
  type AtomicDocumentCommitInput,
  type PreparedDocumentCreate,
  type PreparedDocumentCommit,
} from "../core/index.js";
import {
  ACTIVE_DOCUMENT_OPERATION_STATUSES,
  assertDocumentOperationTransition,
  TERMINAL_DOCUMENT_OPERATION_STATUSES,
} from "./state-machine.js";
import type { DocumentVersionAdvanceCoordination } from "../service.js";

type OperationRow = typeof documentOperations.$inferSelect;
type OperationItemRow = typeof documentOperationItems.$inferSelect;

export interface CreateDocumentOperationInput {
  id?: string;
  capabilityId: string;
  capabilityVersion: number;
  interactionMode: DocumentOperationInteractionMode;
  presenterKey: string;
  roomId: string;
  documentId?: string | null;
  documentTitle: string;
  sessionId: string;
  runId: string;
  baseVersion?: number | null;
  status?: DocumentOperationStatus;
  summary: string;
  input?: Record<string, unknown>;
  expiresAt?: Date | null;
  acquireDocumentLease?: boolean;
}

export interface AddDocumentOperationItemInput {
  id?: string;
  sequence: number;
  operation: "insert" | "replace" | "delete" | "stream_chunk" | "replace_selection";
  target?: DocumentMutationTarget | null;
  before?: TiptapJsonContent[];
  after?: TiptapJsonContent[];
  markdown?: string;
  contentHash: string;
  status?: DocumentOperationItemStatus;
}

export interface DocumentOperationCommandMutation {
  status?: DocumentOperationStatus;
  input?: Record<string, unknown>;
  documentId?: string | null;
  documentTitle?: string;
  baseVersion?: number | null;
  conflictVersion?: number | null;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  expiresAt?: Date | null;
  complete?: boolean;
  addItems?: AddDocumentOperationItemInput[];
  updateItems?: Array<{
    id: string;
    status: DocumentOperationItemStatus;
    appliedVersion?: number | null;
    after?: TiptapJsonContent[];
    markdown?: string;
    contentHash?: string;
  }>;
  document?: RoomDocument;
  create?: AtomicDocumentCreateInput;
  commit?: AtomicDocumentCommitInput;
  draftCreate?: AtomicDocumentCreateInput;
  draftUpdate?: AtomicDocumentCreateInput;
  draftDeleteDocumentId?: string;
  afterCommit?: (document?: RoomDocument) => void;
}

export type DocumentOperationCommandHandler = (
  operation: DocumentOperation,
  command: DocumentOperationCommandInput,
) => Promise<DocumentOperationCommandMutation> | DocumentOperationCommandMutation;

class OperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function summary(row: OperationRow): DocumentOperationSummary {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    capabilityVersion: row.capabilityVersion,
    interactionMode: row.interactionMode,
    presenterKey: row.presenterKey,
    roomId: row.roomId,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    sessionId: row.agentSessionId,
    runId: row.runId,
    baseVersion: row.baseVersion,
    status: row.status,
    revision: row.revision,
    summary: row.summary,
    conflictVersion: row.conflictVersion,
    error: row.error,
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

function item(row: OperationItemRow): DocumentOperationItem {
  return {
    id: row.id,
    operationId: row.operationId,
    sequence: row.sequence,
    operation: row.operation as DocumentOperationItem["operation"],
    target: row.target,
    before: row.beforeJson,
    after: row.afterJson,
    markdown: row.markdown,
    contentHash: row.contentHash,
    status: row.status,
    appliedVersion: row.appliedVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentOperationService {
  private readonly queue = new OperationQueue();
  private readonly repository: DocumentRepository;
  private readonly commits: DocumentCommitService;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly broker: DocumentEventBroker,
  ) {
    this.repository = new DocumentRepository(db);
    const engine = new DocumentContentEngine({
      findDocumentRoom: (documentId) => this.repository.get(documentId)?.roomId ?? null,
    });
    this.commits = new DocumentCommitService(db, this.repository, engine);
  }

  create(input: CreateDocumentOperationInput): DocumentOperation {
    if (!input.capabilityId.trim() || !input.presenterKey.trim() || !input.roomId.trim()) {
      throw new DocumentServiceError("INVALID_OPERATION", "Document operation identity is incomplete");
    }
    const id = input.id ?? randomUUID();
    const now = new Date();
    const status = input.status ?? "created";
    const operationInput = input.acquireDocumentLease
      ? { ...(input.input ?? {}), documentLease: true }
      : input.input ?? {};
    this.db.transaction((tx) => {
      if (input.acquireDocumentLease) {
        if (!input.documentId || input.baseVersion === undefined || input.baseVersion === null) {
          throw new DocumentServiceError("INVALID_OPERATION", "A document lease requires a versioned document", 409);
        }
        const leased = tx.update(documents).set({ activeTransactionId: id }).where(and(
          eq(documents.id, input.documentId),
          eq(documents.version, input.baseVersion),
          isNull(documents.deletedAt),
          isNull(documents.activeTransactionId),
        )).run();
        if (leased.changes !== 1) {
          const current = tx.select().from(documents).where(eq(documents.id, input.documentId)).get();
          if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
          if (current.deletedAt) {
            throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409, {
              documentId: input.documentId,
              retryable: false,
            });
          }
          if (current.activeTransactionId) {
            throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409, {
              documentId: input.documentId,
              retryable: true,
              nextAction: "retry_after_active_operation",
            });
          }
          throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
            documentId: input.documentId,
            currentVersion: current.version,
            retryable: true,
            nextAction: "context_room_document_read",
          });
        }
      }
      tx.insert(documentOperations).values({
        id,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion,
        interactionMode: input.interactionMode,
        presenterKey: input.presenterKey,
        roomId: input.roomId,
        documentId: input.documentId ?? null,
        documentTitle: input.documentTitle.trim().slice(0, 120) || "无标题文档",
        agentSessionId: input.sessionId,
        runId: input.runId,
        baseVersion: input.baseVersion ?? null,
        status,
        revision: 1,
        summary: input.summary.trim().slice(0, 500),
        input: operationInput,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
      tx.insert(documentOperationEvents).values({
        id: randomUUID(), operationId: id, revision: 1, type: "operation.created",
        payload: { status }, createdAt: now,
      }).run();
    });
    const operation = this.get(id)!;
    this.publish(operation);
    return operation;
  }

  list(input: {
    roomId?: string;
    documentId?: string;
    sessionId?: string;
    runId?: string;
    statuses?: DocumentOperationStatus[];
    active?: boolean;
  } = {}): DocumentOperationSummary[] {
    const statuses = input.active ? [...ACTIVE_DOCUMENT_OPERATION_STATUSES] : input.statuses;
    const conditions = [
      ...(input.roomId ? [eq(documentOperations.roomId, input.roomId)] : []),
      ...(input.documentId ? [eq(documentOperations.documentId, input.documentId)] : []),
      ...(input.sessionId ? [eq(documentOperations.agentSessionId, input.sessionId)] : []),
      ...(input.runId ? [eq(documentOperations.runId, input.runId)] : []),
      ...(statuses?.length ? [inArray(documentOperations.status, statuses)] : []),
    ];
    return this.db.select().from(documentOperations)
      .where(conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(documentOperations.updatedAt)).all().map(summary);
  }

  get(operationId: string): DocumentOperation | null {
    const row = this.db.select().from(documentOperations).where(eq(documentOperations.id, operationId)).get();
    if (!row) return null;
    const items = this.db.select().from(documentOperationItems)
      .where(eq(documentOperationItems.operationId, operationId))
      .orderBy(asc(documentOperationItems.sequence)).all().map(item);
    return { ...summary(row), input: row.input, result: row.result, items };
  }

  execute(
    operationId: string,
    command: DocumentOperationCommandInput,
    handler: DocumentOperationCommandHandler,
  ): Promise<{ operation: DocumentOperation; document?: RoomDocument; duplicate: boolean }> {
    const queuedOperation = this.get(operationId);
    const draftDocumentId = queuedOperation && typeof queuedOperation.input.draftDocumentId === "string"
      ? queuedOperation.input.draftDocumentId
      : null;
    const targetDocumentId = queuedOperation?.documentId ?? draftDocumentId;
    const queueKey = targetDocumentId
      ? `document:${queuedOperation?.roomId ?? "unknown"}:${targetDocumentId}`
      : `operation:${operationId}`;
    return this.queue.enqueue(queueKey, async () => {
      const existing = this.db.select().from(documentOperationCommands)
        .where(eq(documentOperationCommands.id, command.commandId)).get();
      if (existing) {
        if (existing.operationId !== operationId) {
          throw new DocumentServiceError("COMMAND_ID_CONFLICT", "Command id belongs to another operation", 409);
        }
        if (!existing.completedAt) {
          throw new DocumentServiceError("COMMAND_IN_PROGRESS", "Document operation command is still running", 409);
        }
        const operation = this.require(operationId);
        const storedDocument = existing.result && typeof existing.result === "object"
          && "document" in existing.result
          ? existing.result.document as RoomDocument
          : undefined;
        return {
          operation,
          ...(storedDocument ? { document: storedDocument } : {}),
          duplicate: true,
        };
      }

      const operation = this.require(operationId);
      if (operation.revision !== command.expectedRevision) {
        throw new DocumentServiceError("OPERATION_REVISION_CONFLICT", "Document operation has changed", 409, {
          currentOperation: operation,
        });
      }
      if (TERMINAL_DOCUMENT_OPERATION_STATUSES.has(operation.status)) {
        // conflicted 不是绝对终态：state-machine 允许 conflicted → cancelled 的
        // 清理迁移（SOP §3.3"conflicted 仅允许清理为 cancelled"）。终态闸必须为
        // 这一条命令放行，否则冲突提案永远无法关闭（桌面"关闭此次修改"即此路径）。
        const conflictedCleanup = operation.status === "conflicted" && command.type === "operation.cancel";
        if (!conflictedCleanup) {
          throw new DocumentServiceError("OPERATION_FINALIZED", `Document operation is ${operation.status}`, 409);
        }
      }

      const mutation = await handler(operation, command);
      const documentMutations = [
        mutation.create,
        mutation.commit,
        mutation.draftCreate,
        mutation.draftUpdate,
        mutation.draftDeleteDocumentId,
      ].filter(Boolean).length;
      if (documentMutations > 1) {
        throw new DocumentServiceError("INVALID_OPERATION_MUTATION", "A command can contain only one document mutation", 500);
      }
      const preparedCreate = mutation.create ? this.prepareAtomicCreate(operation, mutation.create) : null;
      const prepared = mutation.commit ? this.prepareAtomicCommit(operation, mutation.commit) : null;
      const preparedDraftCreate = mutation.draftCreate
        ? this.prepareDraftCreate(operation, mutation.draftCreate)
        : null;
      const preparedDraftUpdate = mutation.draftUpdate
        ? this.prepareDraftUpdate(operation, mutation.draftUpdate)
        : null;
      const draftDeleteDocumentId = mutation.draftDeleteDocumentId
        ? this.prepareDraftDelete(operation, mutation.draftDeleteDocumentId)
        : null;
      const document = preparedCreate?.document
        ?? prepared?.document
        ?? preparedDraftCreate?.document
        ?? preparedDraftUpdate?.document
        ?? mutation.document;
      const shouldApply = operation.status === "awaiting_review" && Boolean(document);
      const conflictedOperationIds: string[] = [];

      this.db.transaction((tx) => {
        tx.insert(documentOperationCommands).values({
          id: command.commandId,
          operationId,
          expectedRevision: command.expectedRevision,
          type: command.type,
          payload: command.payload ?? {},
        }).run();
        const applying = shouldApply
          ? this.applyMutationInTransaction(
              tx,
              operation,
              { ...command, type: `${command.type}.applying` },
              { status: "applying" },
              false,
            )
          : operation;
        if (preparedCreate) this.commits.applyPreparedCreate(tx, preparedCreate);
        if (prepared) this.commits.applyPrepared(tx, prepared);
        if (preparedDraftCreate) this.commits.applyPreparedCreate(tx, preparedDraftCreate);
        if (preparedDraftUpdate) this.commits.applyPrepared(tx, preparedDraftUpdate);
        if (draftDeleteDocumentId) {
          tx.delete(documents).where(eq(documents.id, draftDeleteDocumentId)).run();
        }
        this.applyMutationInTransaction(
          tx,
          applying,
          command,
          {
            ...mutation,
            ...(preparedCreate ? {
              documentId: preparedCreate.document.id,
              documentTitle: preparedCreate.document.title,
              baseVersion: preparedCreate.document.version,
            } : {}),
            ...(prepared && operation.capabilityId === "document.create" && operation.documentId === null ? {
              documentId: prepared.document.id,
              documentTitle: prepared.document.title,
              baseVersion: prepared.document.version,
            } : {}),
            ...(document ? { document } : {}),
          },
          true,
        );
        if (prepared) {
          conflictedOperationIds.push(...this.conflictOtherActiveInTransaction(
            tx,
            prepared.document.id,
            prepared.document.version,
            operation.id,
            prepared.now,
          ));
        }
      });

      const committedDocument = preparedCreate
        ? this.commits.completePreparedCreate(preparedCreate)
        : prepared
          ? this.commits.completePrepared(prepared)
          : preparedDraftCreate
            ? this.commits.completePreparedCreate(preparedDraftCreate)
            : preparedDraftUpdate
              ? this.commits.completePrepared(preparedDraftUpdate)
          : document;
      const updated = this.require(operation.id);
      if (committedDocument) this.publishDocumentChanged(committedDocument, operation.id);
      if (draftDeleteDocumentId) this.publishDocumentDeleted(updated, draftDeleteDocumentId);
      this.publish(updated, committedDocument);
      for (const conflictedId of conflictedOperationIds) {
        const conflicted = this.get(conflictedId);
        if (conflicted) this.publish(conflicted);
      }
      try {
        mutation.afterCommit?.(committedDocument);
      } catch {}
      return {
        operation: updated,
        ...(committedDocument ? { document: committedDocument } : {}),
        duplicate: false,
      };
    });
  }

  conflictOtherActive(documentId: string, currentVersion: number, exceptOperationId?: string): void {
    const candidates = this.db.select().from(documentOperations).where(and(
      eq(documentOperations.documentId, documentId),
      inArray(documentOperations.status, ["created", "running", "awaiting_input", "awaiting_review", "applying"]),
    )).all().filter((row) => row.id !== exceptOperationId && row.baseVersion !== null && row.baseVersion !== currentVersion);
    for (const row of candidates) {
      const operation = this.get(row.id)!;
      this.applyMutation(operation, {
        commandId: randomUUID(), expectedRevision: operation.revision, type: "system.conflict",
      }, { status: "conflicted", conflictVersion: currentVersion });
    }
  }

  prepareExternalVersionAdvance(
    documentId: string,
    currentVersion: number,
  ): DocumentVersionAdvanceCoordination {
    const conflictedOperationIds: string[] = [];
    return {
      mutate: (tx, now) => {
        conflictedOperationIds.push(...this.conflictOtherActiveInTransaction(
          tx,
          documentId,
          currentVersion,
          undefined,
          now,
        ));
      },
      afterCommit: () => {
        for (const operationId of conflictedOperationIds) {
          const operation = this.get(operationId);
          if (operation) this.publish(operation);
        }
      },
    };
  }

  recoverInterrupted(): number {
    const rows = this.db.select().from(documentOperations)
      .where(inArray(documentOperations.status, ["running", "applying"])).all();
    for (const row of rows) {
      const operation = this.get(row.id)!;
      const recoverable = operation.interactionMode === "streaming_commit" ? "failed" : "awaiting_review";
      const draftDocumentId = this.draftDocumentId(operation);
      this.applyMutation(operation, {
        commandId: randomUUID(), expectedRevision: operation.revision, type: "system.recover",
      }, recoverable === "failed"
        ? {
            status: "failed",
            error: { code: "gateway_restarted" },
            complete: true,
            ...(draftDocumentId ? { draftDeleteDocumentId: draftDocumentId } : {}),
          }
        : { status: "awaiting_review" });
    }
    return rows.length;
  }

  expire(now = new Date()): number {
    const rows = this.db.select().from(documentOperations).where(and(
      inArray(documentOperations.status, ["created", "running", "awaiting_input"]),
      lt(documentOperations.expiresAt, now),
    )).all();
    for (const row of rows) {
      const operation = this.get(row.id)!;
      const draftDocumentId = this.draftDocumentId(operation);
      this.applyMutation(operation, {
        commandId: randomUUID(), expectedRevision: operation.revision, type: "system.expire",
      }, {
        status: "expired",
        complete: true,
        ...(draftDocumentId ? { draftDeleteDocumentId: draftDocumentId } : {}),
      });
    }
    return rows.length;
  }

  /** Cancel in-flight operations owned by an Agent run during runtime cleanup. */
  cancelActiveForSession(sessionId: string, reason: string, runId?: string): number {
    return this.cancelForSession(
      sessionId,
      reason,
      [...ACTIVE_DOCUMENT_OPERATION_STATUSES],
      runId,
    );
  }

  /**
   * Finish an Agent run without discarding proposals already handed to the user.
   * Once an operation reaches review/apply, its lifecycle is owned by the review UI.
   */
  cancelIncompleteForSession(sessionId: string, reason: string, runId?: string): number {
    return this.cancelForSession(
      sessionId,
      reason,
      ["created", "running", "awaiting_input"],
      runId,
    );
  }

  private cancelForSession(
    sessionId: string,
    reason: string,
    statuses: DocumentOperationStatus[],
    runId?: string,
  ): number {
    const rows = this.db.select().from(documentOperations).where(and(
      eq(documentOperations.agentSessionId, sessionId),
      inArray(documentOperations.status, statuses),
      ...(runId ? [eq(documentOperations.runId, runId)] : []),
    )).all();
    for (const row of rows) {
      const operation = this.get(row.id);
      if (!operation || TERMINAL_DOCUMENT_OPERATION_STATUSES.has(operation.status)) continue;
      const draftDocumentId = this.draftDocumentId(operation);
      this.applyMutation(operation, {
        commandId: randomUUID(),
        expectedRevision: operation.revision,
        type: "operation.cancel",
        payload: { reason, source: "agent-runtime-cleanup" },
      }, {
        status: "cancelled",
        result: { reason },
        complete: true,
        ...(draftDocumentId ? { draftDeleteDocumentId: draftDocumentId } : {}),
      });
    }
    return rows.length;
  }

  private require(operationId: string): DocumentOperation {
    const operation = this.get(operationId);
    if (!operation) throw new DocumentServiceError("OPERATION_NOT_FOUND", "Document operation not found", 404);
    return operation;
  }

  private applyMutation(
    operation: DocumentOperation,
    command: DocumentOperationCommandInput,
    mutation: DocumentOperationCommandMutation,
    completeCommand = true,
  ): DocumentOperation {
    const draftDeleteDocumentId = mutation.draftDeleteDocumentId
      ? this.prepareDraftDelete(operation, mutation.draftDeleteDocumentId)
      : null;
    this.db.transaction((tx) => {
      if (draftDeleteDocumentId) {
        tx.delete(documents).where(eq(documents.id, draftDeleteDocumentId)).run();
      }
      this.applyMutationInTransaction(tx, operation, command, mutation, completeCommand);
    });
    const updated = this.require(operation.id);
    if (draftDeleteDocumentId) this.publishDocumentDeleted(updated, draftDeleteDocumentId);
    this.publish(updated, mutation.document);
    return updated;
  }

  private applyMutationInTransaction(
    tx: GatewayDatabase,
    operation: DocumentOperation,
    command: DocumentOperationCommandInput,
    mutation: DocumentOperationCommandMutation,
    completeCommand = true,
  ): DocumentOperation {
    const nextStatus = mutation.status ?? operation.status;
    assertDocumentOperationTransition(operation.status, nextStatus);
    const nextRevision = operation.revision + 1;
    const now = new Date();
    for (const next of mutation.addItems ?? []) {
      tx.insert(documentOperationItems).values({
        id: next.id ?? randomUUID(), operationId: operation.id, sequence: next.sequence,
        operation: next.operation, target: next.target ?? null, beforeJson: next.before ?? [],
        afterJson: next.after ?? [], markdown: next.markdown ?? "", contentHash: next.contentHash,
        status: next.status ?? "pending", createdAt: now, updatedAt: now,
      }).run();
    }
    for (const update of mutation.updateItems ?? []) {
      tx.update(documentOperationItems).set({
        status: update.status,
        appliedVersion: update.appliedVersion ?? null,
        ...(update.after === undefined ? {} : { afterJson: update.after }),
        ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
        ...(update.contentHash === undefined ? {} : { contentHash: update.contentHash }),
        updatedAt: now,
      }).where(and(
        eq(documentOperationItems.id, update.id),
        eq(documentOperationItems.operationId, operation.id),
      )).run();
    }
    const changed = tx.update(documentOperations).set({
      status: nextStatus,
      revision: nextRevision,
      input: mutation.input ?? operation.input,
      documentId: mutation.documentId === undefined ? operation.documentId : mutation.documentId,
      documentTitle: mutation.documentTitle ?? operation.documentTitle,
      baseVersion: mutation.baseVersion === undefined ? operation.baseVersion : mutation.baseVersion,
      conflictVersion: mutation.conflictVersion === undefined ? operation.conflictVersion : mutation.conflictVersion,
      result: mutation.result === undefined ? operation.result : mutation.result,
      error: mutation.error === undefined ? operation.error : mutation.error,
      expiresAt: mutation.expiresAt === undefined ? (operation.expiresAt ? new Date(operation.expiresAt) : null) : mutation.expiresAt,
      updatedAt: now,
      completedAt: mutation.complete || TERMINAL_DOCUMENT_OPERATION_STATUSES.has(nextStatus) ? now : null,
    }).where(and(
      eq(documentOperations.id, operation.id),
      eq(documentOperations.revision, operation.revision),
    )).run();
    if (changed.changes !== 1) {
      throw new DocumentServiceError("OPERATION_REVISION_CONFLICT", "Document operation has changed", 409);
    }
    const releasesDocumentLease = operation.input.documentLease === true
      && !["created", "running", "awaiting_input"].includes(nextStatus);
    if (releasesDocumentLease && operation.documentId) {
      tx.update(documents).set({ activeTransactionId: null }).where(and(
        eq(documents.id, operation.documentId),
        eq(documents.activeTransactionId, operation.id),
      )).run();
    }
    tx.insert(documentOperationEvents).values({
      id: randomUUID(), operationId: operation.id, revision: nextRevision,
      type: command.type, payload: command.payload ?? {}, createdAt: now,
    }).run();
    const commandRow = tx.select().from(documentOperationCommands)
      .where(eq(documentOperationCommands.id, command.commandId)).get();
    if (commandRow && completeCommand) {
      tx.update(documentOperationCommands).set({
        result: {
          revision: nextRevision,
          status: nextStatus,
          ...(mutation.document ? { document: mutation.document } : {}),
        },
        completedAt: now,
      }).where(eq(documentOperationCommands.id, command.commandId)).run();
    }
    return {
      ...operation,
      status: nextStatus,
      revision: nextRevision,
      input: mutation.input ?? operation.input,
      documentId: mutation.documentId === undefined ? operation.documentId : mutation.documentId,
      documentTitle: mutation.documentTitle ?? operation.documentTitle,
      baseVersion: mutation.baseVersion === undefined ? operation.baseVersion : mutation.baseVersion,
      conflictVersion: mutation.conflictVersion === undefined ? operation.conflictVersion : mutation.conflictVersion,
      result: mutation.result === undefined ? operation.result : mutation.result,
      error: mutation.error === undefined ? operation.error : mutation.error,
      expiresAt: mutation.expiresAt === undefined ? operation.expiresAt : iso(mutation.expiresAt),
      updatedAt: now.toISOString(),
      completedAt: mutation.complete || TERMINAL_DOCUMENT_OPERATION_STATUSES.has(nextStatus)
        ? now.toISOString()
        : null,
    };
  }

  private prepareAtomicCommit(
    operation: DocumentOperation,
    input: AtomicDocumentCommitInput,
  ): PreparedDocumentCommit {
    const operationDocumentId = operation.documentId ?? this.draftDocumentId(operation);
    if (!operationDocumentId || input.documentId !== operationDocumentId || input.roomId !== operation.roomId) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Commit target does not match the operation", 409);
    }
    const current = this.repository.get(input.documentId);
    if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    if (current.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
    if (current.activeTransactionId && current.activeTransactionId !== operation.id) {
      throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
    }
    const expectedVersion = input.expectedVersion ?? operation.baseVersion;
    if (expectedVersion === null || current.version !== expectedVersion || input.version !== expectedVersion + 1) {
      throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
        currentVersion: current.version,
        currentDocument: current,
      });
    }
    return this.commits.prepareCommit({
      ...input,
      expectedVersion,
      sourceTransactionId: input.sourceTransactionId ?? operation.id,
    });
  }

  private prepareAtomicCreate(
    operation: DocumentOperation,
    input: AtomicDocumentCreateInput,
  ): PreparedDocumentCreate {
    const draftDocumentId = typeof operation.input.draftDocumentId === "string"
      ? operation.input.draftDocumentId
      : null;
    if (
      operation.capabilityId !== "document.create"
      || operation.documentId !== null
      || !draftDocumentId
      || input.documentId !== draftDocumentId
      || input.roomId !== operation.roomId
    ) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Create target does not match the operation", 409);
    }
    if (this.repository.get(input.documentId)) {
      throw new DocumentServiceError("DOCUMENT_ID_CONFLICT", "Document id is already in use", 409);
    }
    const title = input.title.trim();
    if (!title) throw new DocumentServiceError("INVALID_TITLE", "Document title cannot be empty");
    if (title.length > 120) {
      throw new DocumentServiceError("INVALID_TITLE", "Document title cannot exceed 120 characters");
    }
    return this.commits.prepareCreate({
      ...input,
      title,
      version: 1,
      status: "active",
      sourceTransactionId: operation.id,
    });
  }

  private prepareDraftCreate(
    operation: DocumentOperation,
    input: AtomicDocumentCreateInput,
  ): PreparedDocumentCreate {
    const draftDocumentId = this.draftDocumentId(operation);
    if (
      operation.capabilityId !== "document.create"
      || operation.documentId !== null
      || !draftDocumentId
      || input.documentId !== draftDocumentId
      || input.roomId !== operation.roomId
      || this.repository.get(input.documentId)
    ) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Draft target does not match the operation", 409);
    }
    return this.commits.prepareCreate({
      ...input,
      version: 0,
      status: "draft",
      activeTransactionId: operation.id,
      sourceTransactionId: operation.id,
      writeVersion: false,
    });
  }

  private prepareDraftUpdate(
    operation: DocumentOperation,
    input: AtomicDocumentCreateInput,
  ): PreparedDocumentCommit {
    const draftDocumentId = this.draftDocumentId(operation);
    const current = draftDocumentId ? this.repository.get(draftDocumentId) : null;
    if (
      operation.capabilityId !== "document.create"
      || operation.documentId !== null
      || !current
      || input.documentId !== draftDocumentId
      || input.roomId !== operation.roomId
      || current.status !== "draft"
      || current.version !== 0
      || current.activeTransactionId !== operation.id
    ) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Draft target does not match the operation", 409);
    }
    return this.commits.prepareCommit({
      ...input,
      version: 0,
      expectedVersion: 0,
      status: "draft",
      activeTransactionId: operation.id,
      sourceTransactionId: operation.id,
      writeVersion: false,
    });
  }

  private prepareDraftDelete(operation: DocumentOperation, documentId: string): string {
    const draftDocumentId = this.draftDocumentId(operation);
    if (
      operation.capabilityId !== "document.create"
      || operation.documentId !== null
      || !draftDocumentId
      || documentId !== draftDocumentId
    ) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Draft target does not match the operation", 409);
    }
    const current = draftDocumentId ? this.repository.get(draftDocumentId) : null;
    if (!current) return draftDocumentId;
    if (
      current.status !== "draft"
      || current.version !== 0
      || current.activeTransactionId !== operation.id
    ) {
      throw new DocumentServiceError("OPERATION_DOCUMENT_MISMATCH", "Draft target does not match the operation", 409);
    }
    return draftDocumentId;
  }

  private draftDocumentId(operation: DocumentOperation): string | null {
    return operation.capabilityId === "document.create"
      && typeof operation.input.draftDocumentId === "string"
      ? operation.input.draftDocumentId
      : null;
  }

  private conflictOtherActiveInTransaction(
    tx: GatewayDatabase,
    documentId: string,
    currentVersion: number,
    exceptOperationId: string | undefined,
    now: Date,
  ): string[] {
    const candidates = tx.select().from(documentOperations).where(and(
      eq(documentOperations.documentId, documentId),
      inArray(documentOperations.status, ["created", "running", "awaiting_input", "awaiting_review", "applying"]),
    )).all().filter((row) => row.id !== exceptOperationId
      && row.baseVersion !== null
      && row.baseVersion !== currentVersion);
    for (const row of candidates) {
      const revision = row.revision + 1;
      tx.update(documentOperations).set({
        status: "conflicted", revision, conflictVersion: currentVersion,
        completedAt: now, updatedAt: now,
      }).where(and(eq(documentOperations.id, row.id), eq(documentOperations.revision, row.revision))).run();
      tx.insert(documentOperationEvents).values({
        id: randomUUID(), operationId: row.id, revision, type: "system.conflict",
        payload: { currentVersion }, createdAt: now,
      }).run();
      tx.update(documents).set({ activeTransactionId: null }).where(and(
        eq(documents.id, documentId),
        eq(documents.activeTransactionId, row.id),
      )).run();
    }
    return candidates.map((row) => row.id);
  }

  private publishDocumentChanged(document: RoomDocument, operationId: string): void {
    this.broker.publish({
      id: randomUUID(), roomId: document.roomId, documentId: document.id,
      operationId, type: "document.changed", occurredAt: new Date().toISOString(),
      payload: { document },
    });
  }

  private publishDocumentDeleted(operation: DocumentOperation, documentId: string): void {
    this.broker.publish({
      id: randomUUID(), roomId: operation.roomId, documentId,
      operationId: operation.id, type: "document.deleted", occurredAt: new Date().toISOString(),
      payload: { documentId },
    });
  }

  private publish(operation: DocumentOperation, document?: RoomDocument): void {
    this.broker.publish({
      id: randomUUID(),
      roomId: operation.roomId,
      documentId: operation.documentId ?? operation.id,
      operationId: operation.id,
      type: "document.operation.changed",
      occurredAt: new Date().toISOString(),
      payload: { operation: summaryFromOperation(operation), ...(document ? { document } : {}) },
    });
  }
}

function summaryFromOperation(operation: DocumentOperation): DocumentOperationSummary {
  const { input: _input, result: _result, items: _items, ...value } = operation;
  return value;
}
