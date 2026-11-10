import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import type {
  DocumentBlockBacklink,
  DocumentBlockResolution,
  DocumentBlockSummary,
  DocumentVersionSummary,
  DocumentVersionSnapshot,
  DocumentDiffResult,
  ResolveDocumentBlockReferencesInput,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { and, asc, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentBlockReferences,
  documentBlocks,
  documents,
} from "../../../infrastructure/database/schema.js";
import { DocumentServiceError } from "../errors.js";
import { DocumentContentEngine } from "./content-engine.js";
import { DocumentRepository } from "./repository.js";
import { YjsHistoryService } from "./yjs-history-service.js";

export class DocumentQueryService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly repository: DocumentRepository,
    private readonly engine: DocumentContentEngine,
    readonly yjsHistory: YjsHistoryService = new YjsHistoryService(),
  ) {}

  list(trashed = false, origin?: "native" | "import"): RoomDocument[] {
    return this.repository.list(trashed, origin);
  }

  get(documentId: string): RoomDocument | null {
    return this.repository.get(documentId);
  }

  listVersions(documentId: string, options: { limit?: number; beforeVersion?: number } = {}): DocumentVersionSummary[] {
    if (!this.repository.get(documentId)) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const versions = this.repository.listVersions(documentId, {
      limit,
      ...(options.beforeVersion === undefined ? {} : { beforeVersion: options.beforeVersion }),
    });
    const yjsVersions = this.repository.listYjsVersionNumbers(
      documentId,
      versions.map((version) => version.version),
    );
    return versions.map((version) => ({
      documentId,
      version: version.version,
      contentSchemaVersion: version.contentSchemaVersion,
      sourceTransactionId: version.sourceTransactionId,
      createdAt: version.createdAt.toISOString(),
      title: version.title,
      yjsBackfilled: yjsVersions.get(version.version) ?? false,
      changeSummary: version.changeSummary ?? null,
      changeSummarySource: (version.changeSummarySource as DocumentVersionSummary["changeSummarySource"]) ?? null,
    }));
  }

  getVersionSnapshot(documentId: string, version: number): DocumentVersionSnapshot | null {
    const row = this.repository.getVersion(documentId, version);
    if (!row) return null;
    const materialized = this.yjsHistory.materialize(this.db, documentId, version);
    if (!materialized && row.contentJson === null) return null;
    return {
      documentId,
      version,
      title: materialized?.title ?? row.title,
      contentJson: materialized?.content ?? row.contentJson as TiptapJsonContent,
      contentSchemaVersion: materialized?.schemaVersion ?? row.contentSchemaVersion,
      sourceTransactionId: row.sourceTransactionId,
      createdAt: row.createdAt.toISOString(),
      yjsBackfilled: materialized?.yjsBackfilled ?? false,
    };
  }

  diff(documentId: string, fromVersion: number | null, toVersion: number): DocumentDiffResult | null {
    if (!this.repository.getVersion(documentId, toVersion)) {
      throw new DocumentServiceError("VERSION_NOT_FOUND", "Document version not found", 404);
    }
    if (fromVersion !== null && !this.repository.getVersion(documentId, fromVersion)) {
      throw new DocumentServiceError("VERSION_NOT_FOUND", "Document version not found", 404);
    }
    if (fromVersion !== null && fromVersion >= toVersion) {
      throw new DocumentServiceError("INVALID_VERSION_RANGE", "fromVersion must be lower than toVersion", 400);
    }
    return this.yjsHistory.diff(this.db, documentId, fromVersion, toVersion);
  }

  listBlocks(documentId: string): DocumentBlockSummary[] {
    const document = this.repository.get(documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    this.ensureProjection(document);
    return this.repository.listBlocks(document);
  }

  listBlockBacklinks(documentId: string, blockId?: string): DocumentBlockBacklink[] {
    const document = this.repository.get(documentId);
    if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    this.ensureProjection(document);
    const conditions = [eq(documentBlockReferences.targetDocumentId, documentId)];
    if (blockId) conditions.push(eq(documentBlockReferences.targetBlockId, blockId));
    return this.db.select({
      reference: documentBlockReferences,
      sourceDocument: documents,
      sourceBlock: documentBlocks,
    }).from(documentBlockReferences)
      .innerJoin(documents, eq(documents.id, documentBlockReferences.sourceDocumentId))
      .innerJoin(documentBlocks, and(
        eq(documentBlocks.documentId, documentBlockReferences.sourceDocumentId),
        eq(documentBlocks.blockId, documentBlockReferences.sourceBlockId),
      ))
      .where(and(...conditions))
      .orderBy(asc(documentBlockReferences.ordinal)).all()
      .map(({ reference, sourceDocument, sourceBlock }) => ({
        // 工作区级文稿没有 Room 归属：契约要求的 sourceRoomId 用工作区频道占位。
        sourceRoomId: WORKSPACE_DOCUMENT_CHANNEL,
        sourceDocumentId: sourceDocument.id,
        sourceDocumentTitle: sourceDocument.title,
        sourceBlockId: reference.sourceBlockId,
        sourceTextPreview: sourceBlock.textPreview,
        targetDocumentId: reference.targetDocumentId,
        targetBlockId: reference.targetBlockId,
      }));
  }

  resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): DocumentBlockResolution[] {
    // Phase 2i：文档库只剩工作区，跨 Room 引用校验与 Room 存在性检查一并删除；
    // 契约里的 sourceRoomId / roomId 仍由调用方携带，只作为引用元数据不再校验。
    return input.references.map((reference) => {
      const document = this.repository.get(reference.documentId);
      if (!document) {
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
      this.ensureProjection(document);
      const block = this.db.select().from(documentBlocks).where(and(
        eq(documentBlocks.documentId, reference.documentId),
        eq(documentBlocks.blockId, reference.blockId),
        eq(documentBlocks.indexedVersion, document.version),
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

  ensureProjection(document: RoomDocument): void {
    const indexed = this.db.select({ indexedVersion: documentBlocks.indexedVersion })
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, document.id))
      .limit(1).get();
    const normalized = this.engine.normalizeDocument(
      document.contentJson,
      document.id,
      document.version,
    );
    const hasAddressableContent = normalized.blocks.length > 0;
    if (indexed?.indexedVersion === document.version || (!indexed && !hasAddressableContent)) return;
    this.db.transaction((tx) => this.repository.replaceProjection(tx, document.id, normalized));
  }
}
