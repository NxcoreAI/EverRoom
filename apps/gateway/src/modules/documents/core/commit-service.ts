import { randomUUID } from "node:crypto";
import type { RoomDocument, TiptapJsonContent } from "@nxcore/agent-contract";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentVersions,
  documents,
  roomDocumentLinks,
} from "../../../infrastructure/database/schema.js";
import type { NormalizedGatewayDocument } from "./content-engine.js";
import { DocumentServiceError } from "../errors.js";
import { DocumentContentEngine } from "./content-engine.js";
import { DocumentRepository } from "./repository.js";

export interface DocumentCommitHooks {
  afterCommit?: (
    document: RoomDocument,
    previousVersion: number | null,
    input: CommitDocumentInput,
  ) => void;
  afterCommitError?: (
    error: unknown,
    document: RoomDocument,
    previousVersion: number | null,
    input: CommitDocumentInput,
  ) => void;
}

export interface CommitDocumentInput {
  documentId: string;
  roomId: string;
  title: string;
  content: TiptapJsonContent;
  version: number;
  expectedVersion?: number;
  status?: "draft" | "active";
  activeTransactionId?: string | null;
  sourceTransactionId?: string;
  createdAt?: Date;
  writeVersion?: boolean;
  mutate?: (tx: GatewayDatabase, normalized: NormalizedGatewayDocument, now: Date) => void;
}

export type AtomicDocumentCommitInput = Pick<
  CommitDocumentInput,
  "documentId" | "roomId" | "title" | "content" | "expectedVersion" | "version"
> & Pick<CommitDocumentInput, "activeTransactionId" | "status" | "sourceTransactionId">;

export interface AtomicDocumentCreateInput {
  documentId: string;
  roomId: string;
  title: string;
  content: TiptapJsonContent;
}

export interface PreparedDocumentCommit {
  input: CommitDocumentInput;
  normalized: NormalizedGatewayDocument;
  previousVersion: number | null;
  document: RoomDocument;
  now: Date;
}

export interface PreparedDocumentCreate {
  input: CommitDocumentInput;
  normalized: NormalizedGatewayDocument;
  document: RoomDocument;
  now: Date;
}

export class DocumentCommitService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly repository: DocumentRepository,
    private readonly engine: DocumentContentEngine,
    private readonly hooks: DocumentCommitHooks = {},
  ) {}

  create(input: CommitDocumentInput): RoomDocument {
    const prepared = this.prepareCreate(input);
    this.db.transaction((tx) => this.applyPreparedCreate(tx, prepared));
    return this.completePreparedCreate(prepared);
  }

  prepareCreate(input: CommitDocumentInput): PreparedDocumentCreate {
    const normalized = this.engine.normalizeDocument(
      input.content,
      input.documentId,
      input.roomId,
      input.version,
    );
    const now = input.createdAt ?? new Date();
    return {
      input,
      normalized,
      now,
      document: {
        id: input.documentId,
        roomId: input.roomId,
        title: input.title,
        contentJson: normalized.content,
        contentSchemaVersion: normalized.schemaVersion,
        version: input.version,
        status: input.status ?? "active",
        activeTransactionId: input.activeTransactionId ?? null,
        deletedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    };
  }

  applyPreparedCreate(tx: GatewayDatabase, prepared: PreparedDocumentCreate): void {
    const { input, normalized, now } = prepared;
    tx.insert(documents).values({
        id: input.documentId,
        title: input.title,
        contentJson: normalized.content,
        contentSchemaVersion: normalized.schemaVersion,
        version: input.version,
        status: input.status ?? "active",
        activeTransactionId: input.activeTransactionId ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
    tx.insert(roomDocumentLinks).values({
      roomId: input.roomId,
      documentId: input.documentId,
      linkedAt: now,
    }).run();
    if (input.writeVersion !== false && input.version > 0) {
      this.insertVersion(tx, input, normalized, now);
    }
    this.repository.replaceProjection(tx, input.documentId, normalized);
    input.mutate?.(tx, normalized, now);
  }

  completePreparedCreate(prepared: PreparedDocumentCreate): RoomDocument {
    const { input } = prepared;
    const document = this.repository.get(input.documentId)!;
    this.invokeAfterCommit(document, null, input);
    return document;
  }

  commit(input: CommitDocumentInput): RoomDocument {
    const prepared = this.prepareCommit(input);
    this.db.transaction((tx) => this.applyPrepared(tx, prepared));
    return this.completePrepared(prepared);
  }

  prepareCommit(input: CommitDocumentInput): PreparedDocumentCommit {
    const normalized = this.engine.normalizeDocument(
      input.content,
      input.documentId,
      input.roomId,
      input.version,
    );
    const previous = this.repository.get(input.documentId);
    if (!previous) throw new Error(`Document ${input.documentId} was not found`);
    const now = input.createdAt ?? new Date();
    return {
      input,
      normalized,
      previousVersion: previous.version,
      now,
      document: {
        ...previous,
        title: input.title,
        contentJson: normalized.content,
        contentSchemaVersion: normalized.schemaVersion,
        version: input.version,
        status: input.status ?? previous.status,
        activeTransactionId: input.activeTransactionId === undefined
          ? previous.activeTransactionId
          : input.activeTransactionId,
        updatedAt: now.toISOString(),
      },
    };
  }

  applyPrepared(tx: GatewayDatabase, prepared: PreparedDocumentCommit): void {
    const { input, normalized, now } = prepared;
    const updated = tx.update(documents).set({
        title: input.title,
        contentJson: normalized.content,
        contentSchemaVersion: normalized.schemaVersion,
        version: input.version,
        ...(input.status ? { status: input.status } : {}),
        ...(input.activeTransactionId !== undefined ? { activeTransactionId: input.activeTransactionId } : {}),
        updatedAt: now,
      }).where(input.expectedVersion === undefined
        ? eq(documents.id, input.documentId)
        : and(eq(documents.id, input.documentId), eq(documents.version, input.expectedVersion)))
      .run();
    if (updated.changes !== 1) {
      throw new DocumentServiceError(
        "DOCUMENT_CONFLICT",
        `Document ${input.documentId} version has changed`,
        409,
      );
    }
    if (input.writeVersion !== false) this.insertVersion(tx, input, normalized, now);
    this.repository.replaceProjection(tx, input.documentId, normalized);
    input.mutate?.(tx, normalized, now);
  }

  completePrepared(prepared: PreparedDocumentCommit): RoomDocument {
    const { input } = prepared;
    const document = this.repository.get(input.documentId)!;
    this.invokeAfterCommit(document, prepared.previousVersion, input);
    return document;
  }

  private invokeAfterCommit(
    document: RoomDocument,
    previousVersion: number | null,
    input: CommitDocumentInput,
  ): void {
    try {
      this.hooks.afterCommit?.(document, previousVersion, input);
    } catch (error) {
      try {
        this.hooks.afterCommitError?.(error, document, previousVersion, input);
      } catch {}
    }
  }

  updateDraft(input: Omit<CommitDocumentInput, "version"> & { version?: number }): RoomDocument {
    const current = this.repository.get(input.documentId);
    if (!current) throw new Error(`Document ${input.documentId} was not found`);
    return this.commit({
      ...input,
      version: input.version ?? current.version,
      writeVersion: false,
    });
  }

  private insertVersion(
    tx: GatewayDatabase,
    input: CommitDocumentInput,
    normalized: NormalizedGatewayDocument,
    now: Date,
  ): void {
    tx.insert(documentVersions).values({
      id: randomUUID(),
      documentId: input.documentId,
      version: input.version,
      title: input.title,
      contentJson: normalized.content,
      contentSchemaVersion: normalized.schemaVersion,
      ...(input.sourceTransactionId ? { sourceTransactionId: input.sourceTransactionId } : {}),
      createdAt: now,
    }).run();
  }
}
