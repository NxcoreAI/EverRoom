/**
 * slides 正文配图会话存取（slides_page_image_sessions 表）。会话跨用户轮次存续：
 * confirm（等用户决定是否生图）与 review（等用户过目/逐张重生成）期间网关重启不丢状态，
 * 主代理凭 draftDocumentId 找回会话续跑。同草稿重新发起 generate 会整行覆盖（重排后的新方案为准）。
 *
 * 单工作区语义：会话按 draftDocumentId 寻址，不按 Room 过滤。表上的 `room_id` 是
 * NOT NULL 历史列，本阶段不改 schema：写入统一填 `WORKSPACE_DOCUMENT_CHANNEL`，
 * 读路径不再带它——旧库里带真实 roomId 的行仍能被读到。
 */

import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { slidesPageImageSessions } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";

export type SlidesPageImageStage = "confirm" | "review" | "settling" | "resolved";

export interface SlidesPageImagePage {
  pageIndex: number;
  title: string;
  imagePrompt: string;
  contentHash: string | null;
  /** 过目打回：true = 落页时该页不用此图（退化图形版式）。 */
  rejected?: boolean;
  /** 后台生成失败标记：该页本轮不再重试，可手动重生成。 */
  failed?: boolean;
}

export interface SlidesPageImageSessionData {
  id: string;
  draftDocumentId: string;
  styleSessionId: string | null;
  stage: SlidesPageImageStage;
  generation: number;
  plan: Record<string, unknown>;
  pages: SlidesPageImagePage[];
  stylePalette: { primary?: string; accent?: string; background?: string } | null;
  /** 最后落库时刻（ms）：前端轮询据此判新旧，防旧响应覆盖新广播。 */
  updatedAt: number;
}

type PageImageSessionRow = typeof slidesPageImageSessions.$inferSelect;

function toData(row: PageImageSessionRow): SlidesPageImageSessionData {
  return {
    id: row.id,
    draftDocumentId: row.draftDocumentId,
    styleSessionId: row.styleSessionId,
    stage: row.stage as SlidesPageImageStage,
    generation: row.generation,
    plan: row.plan,
    pages: row.pages,
    stylePalette: row.stylePalette ?? null,
    updatedAt: row.updatedAt.getTime(),
  };
}

export class SlidesPageImageSessionStore {
  constructor(private readonly db: GatewayDatabase) {}

  /** 按草稿文档覆盖式建会话：旧会话（无论阶段）直接删除，新 arrange 方案为准。 */
  upsertForDraft(input: {
    draftDocumentId: string;
    styleSessionId: string | null;
    plan: Record<string, unknown>;
    pages: SlidesPageImagePage[];
    stylePalette: { primary?: string; accent?: string; background?: string } | null;
  }): SlidesPageImageSessionData {
    const now = new Date();
    const data: SlidesPageImageSessionData = {
      id: randomUUID(),
      draftDocumentId: input.draftDocumentId,
      styleSessionId: input.styleSessionId,
      stage: "confirm",
      generation: 1,
      plan: input.plan,
      pages: input.pages,
      stylePalette: input.stylePalette,
      updatedAt: now.getTime(),
    };
    this.db.delete(slidesPageImageSessions)
      .where(eq(slidesPageImageSessions.draftDocumentId, input.draftDocumentId))
      .run();
    this.db.insert(slidesPageImageSessions).values({
      ...data,
      // 历史 NOT NULL 列：单工作区语义统一填工作区频道。
      roomId: WORKSPACE_DOCUMENT_CHANNEL,
      createdAt: now,
      updatedAt: now,
    }).run();
    return data;
  }

  byDraftId(draftDocumentId: string): SlidesPageImageSessionData | null {
    const row = this.db.select().from(slidesPageImageSessions)
      .where(eq(slidesPageImageSessions.draftDocumentId, draftDocumentId))
      .orderBy(desc(slidesPageImageSessions.updatedAt))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  /** 最新等待用户动作（confirm/review）的会话：传入草稿 id 失效（占位/上下文压缩）时的回退寻址。 */
  latestWaiting(): SlidesPageImageSessionData | null {
    const row = this.db.select().from(slidesPageImageSessions)
      .where(inArray(slidesPageImageSessions.stage, ["confirm", "review"]))
      .orderBy(desc(slidesPageImageSessions.updatedAt))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  /** 按草稿文档查会话：轮询路由用，草稿文档 id 全局唯一。 */
  listByDocument(draftDocumentId: string): SlidesPageImageSessionData[] {
    return this.db.select().from(slidesPageImageSessions)
      .where(eq(slidesPageImageSessions.draftDocumentId, draftDocumentId))
      .orderBy(desc(slidesPageImageSessions.updatedAt))
      .all()
      .map((row) => toData(row));
  }

  patch(id: string, fields: Partial<{
    stage: SlidesPageImageStage;
    generation: number;
    plan: Record<string, unknown>;
    pages: SlidesPageImagePage[];
  }>): void {
    if (Object.keys(fields).length === 0) return;
    this.db.update(slidesPageImageSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(slidesPageImageSessions.id, id))
      .run();
  }
}
