import type { RoomFolderProjection, RoomTaskFolder } from "@nxcore/agent-contract";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  roomDocumentLinks,
  roomFolders,
  roomSourceMemberships,
} from "../../infrastructure/database/schema.js";

export type RoomFolderRow = typeof roomFolders.$inferSelect;

function toTaskFolder(row: RoomFolderRow): RoomTaskFolder {
  return {
    id: row.id,
    roomId: row.roomId,
    kind: "task",
    title: row.title,
    data: row.data as Record<string, unknown>,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Room 任务夹：一次 Agent 生产任务（写作 / PPT）的产物容器。
 * workplan.md、素材草稿、PPT 产物都归夹展示；夹本身只存轻量任务元数据。
 */
export class TaskFolderService {
  constructor(readonly db: GatewayDatabase) {}

  list(roomId: string): RoomFolderProjection {
    const folders = this.db.select().from(roomFolders)
      .where(and(eq(roomFolders.roomId, roomId), isNull(roomFolders.deletedAt)))
      .orderBy(desc(roomFolders.position), desc(roomFolders.createdAt))
      .all().map(toTaskFolder);
    const folderIds = folders.map((folder) => folder.id);
    const documentFolders: Record<string, string> = {};
    const fileFolders: Record<string, string> = {};
    if (folderIds.length > 0) {
      for (const row of this.db.select({
        documentId: roomDocumentLinks.documentId,
        folderId: roomDocumentLinks.folderId,
      }).from(roomDocumentLinks).where(inArray(roomDocumentLinks.folderId, folderIds)).all()) {
        if (row.folderId) documentFolders[row.documentId] = row.folderId;
      }
      for (const row of this.db.select({
        sourceId: roomSourceMemberships.sourceId,
        folderId: roomSourceMemberships.folderId,
      }).from(roomSourceMemberships).where(and(
        inArray(roomSourceMemberships.folderId, folderIds),
        eq(roomSourceMemberships.sourceKind, "file"),
      )).all()) {
        if (row.folderId) fileFolders[row.sourceId] = row.folderId;
      }
    }
    return { folders, documentFolders, fileFolders };
  }

  get(folderId: string): RoomTaskFolder | null {
    const row = this.db.select().from(roomFolders)
      .where(and(eq(roomFolders.id, folderId), isNull(roomFolders.deletedAt)))
      .get();
    return row ? toTaskFolder(row) : null;
  }

  create(roomId: string, input: { title: string; data?: Record<string, unknown> }): RoomTaskFolder {
    const id = randomUUID();
    const position = (this.db.select({ position: roomFolders.position }).from(roomFolders)
      .where(and(eq(roomFolders.roomId, roomId), isNull(roomFolders.deletedAt)))
      .orderBy(desc(roomFolders.position)).get()?.position ?? 0) + 1;
    this.db.insert(roomFolders).values({
      id,
      roomId,
      kind: "task",
      title: input.title,
      data: input.data ?? {},
      position,
    }).run();
    const created = this.get(id);
    if (!created) throw new Error(`task folder ${id} missing after insert`);
    return created;
  }

  /** 浅合并更新任务元数据（stage / workplanDocId 等）；title 可选同步改名。 */
  update(folderId: string, input: {
    title?: string;
    data?: Record<string, unknown>;
  }): RoomTaskFolder | null {
    const current = this.get(folderId);
    if (!current) return null;
    this.db.update(roomFolders).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.data ? { data: { ...current.data, ...input.data } } : {}),
      updatedAt: new Date(),
    }).where(eq(roomFolders.id, folderId)).run();
    return this.get(folderId);
  }

  /** 文档归夹：写 room_doc_links.folder_id；返回是否实际变更。 */
  attachDocument(folderId: string, documentId: string): boolean {
    const folder = this.get(folderId);
    if (!folder) return false;
    const result = this.db.update(roomDocumentLinks).set({ folderId })
      .where(and(eq(roomDocumentLinks.documentId, documentId), eq(roomDocumentLinks.roomId, folder.roomId)))
      .run();
    return result.changes > 0;
  }

  /** 文件条目归夹（sourceKind=file 的 Office 产物等）。 */
  attachFile(folderId: string, fileEntryId: string): boolean {
    const folder = this.get(folderId);
    if (!folder) return false;
    const result = this.db.update(roomSourceMemberships).set({ folderId })
      .where(and(
        eq(roomSourceMemberships.sourceId, fileEntryId),
        eq(roomSourceMemberships.sourceKind, "file"),
        eq(roomSourceMemberships.roomId, folder.roomId),
      ))
      .run();
    return result.changes > 0;
  }
}
