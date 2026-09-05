import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { documentComments } from "../../infrastructure/database/schema.js";
import { DocumentServiceError } from "./errors.js";

/** 文档本地评论（面板 CRUD）；导入的飞书评论只读，走 import-history。 */
export interface DocumentCommentView {
  id: string;
  parentId: string | null;
  blockId: string | null;
  quotedText: string | null;
  body: string;
  authorName: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export class DocumentCommentService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly documentExists: (documentId: string) => boolean,
  ) {}

  list(documentId: string): DocumentCommentView[] {
    this.assertDocument(documentId);
    return this.db.select().from(documentComments)
      .where(eq(documentComments.documentId, documentId))
      .orderBy(asc(documentComments.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        parentId: row.parentId,
        blockId: row.blockId,
        quotedText: row.quotedText,
        body: row.body,
        authorName: row.authorName,
        resolved: row.resolved,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
  }

  create(input: {
    documentId: string;
    body: string;
    parentId?: string | null;
    blockId?: string | null;
    quotedText?: string | null;
  }): DocumentCommentView {
    this.assertDocument(input.documentId);
    const body = input.body.trim().slice(0, 4000);
    if (!body) throw new DocumentServiceError("COMMENT_BODY_EMPTY", "评论内容不能为空", 422);
    if (input.parentId) {
      const parent = this.db.select().from(documentComments)
        .where(and(eq(documentComments.id, input.parentId), eq(documentComments.documentId, input.documentId)))
        .get();
      if (!parent) throw new DocumentServiceError("COMMENT_PARENT_NOT_FOUND", "回复的评论不存在", 404);
      if (parent.parentId) {
        throw new DocumentServiceError("COMMENT_NESTING", "评论只支持一级回复", 422);
      }
    }
    const now = new Date();
    const id = randomUUID();
    this.db.insert(documentComments).values({
      id,
      documentId: input.documentId,
      parentId: input.parentId ?? null,
      blockId: input.blockId ?? null,
      quotedText: input.quotedText?.slice(0, 500) ?? null,
      body,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(input.documentId, id);
  }

  resolve(documentId: string, commentId: string, resolved: boolean): DocumentCommentView {
    const row = this.getOptional(documentId, commentId);
    if (!row) throw new DocumentServiceError("NOT_FOUND", "评论不存在", 404);
    this.db.update(documentComments)
      .set({ resolved, updatedAt: new Date() })
      .where(eq(documentComments.id, commentId)).run();
    return this.get(documentId, commentId);
  }

  delete(documentId: string, commentId: string): void {
    const row = this.getOptional(documentId, commentId);
    if (!row) throw new DocumentServiceError("NOT_FOUND", "评论不存在", 404);
    this.db.delete(documentComments)
      .where(and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId))).run();
    // 一级评论删除时其回复一并删除（一级回复无子级）。
    if (!row.parentId) {
      this.db.delete(documentComments).where(eq(documentComments.parentId, commentId)).run();
    }
  }

  private get(documentId: string, commentId: string): DocumentCommentView {
    const row = this.getOptional(documentId, commentId);
    if (!row) throw new DocumentServiceError("NOT_FOUND", "评论不存在", 404);
    return {
      id: row.id,
      parentId: row.parentId,
      blockId: row.blockId,
      quotedText: row.quotedText,
      body: row.body,
      authorName: row.authorName,
      resolved: row.resolved,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private getOptional(documentId: string, commentId: string) {
    return this.db.select().from(documentComments)
      .where(and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId)))
      .get();
  }

  private assertDocument(documentId: string): void {
    if (!this.documentExists(documentId)) {
      throw new DocumentServiceError("NOT_FOUND", "文档不存在", 404);
    }
  }
}
