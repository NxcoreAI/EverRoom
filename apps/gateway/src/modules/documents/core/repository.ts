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
    return this.db.select({ document: documents })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(
        eq(roomDocumentLinks.roomId, roomId),
        trashed ? isNotNull(documents.deletedAt) : isNull(documents.deletedAt),
      ))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .all()
      .map(({ document }) => toRoomDocument(document, roomId));
  }

  get(documentId: string): RoomDocument | null {
    const result = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(eq(documents.id, documentId))
      .get();
    return result ? toRoomDocument(result.document, result.roomId) : null;
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
