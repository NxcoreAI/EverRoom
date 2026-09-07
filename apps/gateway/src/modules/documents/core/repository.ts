import type {
  DocumentBlockSummary,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentBlockReferences,
  documentBlocks,
  documentRoomImports,
  documentSectionPreviews,
  documentVersions,
  documentYjsVersions,
  documents,
  roomDocumentLinks,
} from "../../../infrastructure/database/schema.js";
import type { NormalizedGatewayDocument } from "./content-engine.js";

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;

export function toRoomDocument(row: DocumentRow, roomId: string): RoomDocument {
  return {
    id: row.id,
    roomId,
    title: row.title,
    contentJson: row.contentJson as TiptapJsonContent,
    contentSchemaVersion: row.contentSchemaVersion,
    version: row.version,
    status: row.status,
    activeTransactionId: row.activeTransactionId,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentRepository {
  constructor(readonly db: GatewayDatabase) {}

  list(roomId: string, trashed = false): RoomDocument[] {
    const rows = this.db.select({ document: documents })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(
        eq(roomDocumentLinks.roomId, roomId),
        trashed ? isNotNull(documents.deletedAt) : isNull(documents.deletedAt),
      ))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .all()
      .map(({ document }) => toRoomDocument(document, roomId));
    // 外部更新候选是版本面板导入历史的临时物化，不作为普通文档出现在 Room
    // 文档列表（应用/未应用均隐藏；diff 与内容查看走导入历史和文档直取）。
    const candidateIds = new Set(
      this.db.select({ id: documentRoomImports.candidateDocumentId })
        .from(documentRoomImports)
        .where(isNotNull(documentRoomImports.candidateDocumentId))
        .all()
        .map((row) => row.id),
    );
    return candidateIds.size > 0
      ? rows.filter((document) => !candidateIds.has(document.id))
      : rows;
  }

  get(documentId: string): RoomDocument | null {
    const result = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .get();
    return result ? toRoomDocument(result.document, result.roomId) : null;
  }

  updateVersionChangeSummary(
    documentId: string,
    version: number,
    summary: string,
    source: "ai" | "local",
  ): void {
    this.db.update(documentVersions)
      .set({ changeSummary: summary, changeSummarySource: source })
      .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, version)))
      .run();
  }

  /** 文档速览 3 列（overview_text 为 canonical 三段式文本）；无行返回 null。 */
  getOverview(documentId: string): {
    overviewText: string | null;
    overviewVersion: number | null;
    overviewGeneratedAt: Date | null;
  } | null {
    const row = this.db.select({
      overviewText: documents.overviewText,
      overviewVersion: documents.overviewVersion,
      overviewGeneratedAt: documents.overviewGeneratedAt,
    }).from(documents).where(eq(documents.id, documentId)).get();
    return row ?? null;
  }

  /** 只写速览 3 列；不触碰 content_json / version / updated_at。 */
  updateDocumentOverview(documentId: string, text: string, version: number): void {
    this.db.update(documents)
      .set({
        overviewText: text,
        overviewVersion: version,
        overviewGeneratedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .run();
  }

  getSectionPreview(documentId: string, blockId: string): {
    headingText: string;
    previewText: string;
    contentHash: string;
    generatedAt: Date;
  } | null {
    return this.db.select({
      headingText: documentSectionPreviews.headingText,
      previewText: documentSectionPreviews.previewText,
      contentHash: documentSectionPreviews.contentHash,
      generatedAt: documentSectionPreviews.generatedAt,
    }).from(documentSectionPreviews)
      .where(and(
        eq(documentSectionPreviews.documentId, documentId),
        eq(documentSectionPreviews.blockId, blockId),
      ))
      .get() ?? null;
  }

  /** 章节预览 upsert：同 (documentId, blockId) 覆盖；只写本表。 */
  upsertSectionPreview(documentId: string, input: {
    blockId: string;
    headingText: string;
    previewText: string;
    contentHash: string;
  }): void {
    this.db.insert(documentSectionPreviews)
      .values({
        documentId,
        blockId: input.blockId,
        headingText: input.headingText,
        previewText: input.previewText,
        contentHash: input.contentHash,
        generatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [documentSectionPreviews.documentId, documentSectionPreviews.blockId],
        set: {
          headingText: input.headingText,
          previewText: input.previewText,
          contentHash: input.contentHash,
          generatedAt: new Date(),
        },
      })
      .run();
  }

  getVersion(documentId: string, version: number): DocumentVersionRow | null {
    return this.db.select().from(documentVersions).where(and(
      eq(documentVersions.documentId, documentId),
      eq(documentVersions.version, version),
    )).get() ?? null;
  }

  listVersions(documentId: string, options: { limit: number; beforeVersion?: number }): DocumentVersionRow[] {
    const conditions = [eq(documentVersions.documentId, documentId)];
    if (options.beforeVersion !== undefined) {
      conditions.push(lt(documentVersions.version, options.beforeVersion));
    }
    return this.db.select().from(documentVersions)
      .where(and(...conditions))
      .orderBy(desc(documentVersions.version))
      .limit(options.limit)
      .all();
  }

  listYjsVersionNumbers(documentId: string, versions: number[]): Map<number, boolean> {
    if (versions.length === 0) return new Map();
    const rows = this.db.select({
      version: documentYjsVersions.version,
      backfilled: documentYjsVersions.backfilled,
    })
      .from(documentYjsVersions)
      .where(and(
        eq(documentYjsVersions.documentId, documentId),
        inArray(documentYjsVersions.version, versions),
      )).all();
    return new Map(rows.map((row) => [row.version, row.backfilled]));
  }

  listBlocks(document: RoomDocument): DocumentBlockSummary[] {
    return this.db.select().from(documentBlocks)
      .where(eq(documentBlocks.documentId, document.id))
      .orderBy(asc(documentBlocks.ordinal)).all()
      .map((row) => ({
        blockId: row.blockId,
        documentId: document.id,
        roomId: document.roomId,
        parentBlockId: row.parentBlockId,
        rootBlockId: row.rootBlockId,
        type: row.type,
        siblingIndex: row.siblingIndex,
        ordinal: row.ordinal,
        path: row.path,
        depth: row.depth,
        textPreview: row.textPreview,
        indexedVersion: row.indexedVersion,
      }));
  }

  replaceProjection(
    tx: GatewayDatabase,
    documentId: string,
    projection: NormalizedGatewayDocument,
  ): void {
    tx.delete(documentBlockReferences)
      .where(eq(documentBlockReferences.sourceDocumentId, documentId)).run();
    tx.delete(documentBlocks).where(eq(documentBlocks.documentId, documentId)).run();
    if (projection.blocks.length > 0) {
      tx.insert(documentBlocks).values(projection.blocks.map((block) => ({
        documentId: block.documentId,
        blockId: block.blockId,
        parentBlockId: block.parentBlockId,
        rootBlockId: block.rootBlockId,
        type: block.type,
        siblingIndex: block.siblingIndex,
        ordinal: block.ordinal,
        path: block.path,
        depth: block.depth,
        textPreview: block.textPreview,
        indexedVersion: block.indexedVersion,
      }))).run();
    }
    if (projection.references.length > 0) {
      const indexedVersion = projection.blocks[0]?.indexedVersion ?? 0;
      tx.insert(documentBlockReferences).values(projection.references.map((reference) => ({
        sourceDocumentId: documentId,
        sourceBlockId: reference.sourceBlockId,
        targetRoomId: reference.targetRoomId,
        targetDocumentId: reference.targetDocumentId,
        targetBlockId: reference.targetBlockId,
        ordinal: reference.ordinal,
        indexedVersion,
      }))).run();
    }
  }
}
