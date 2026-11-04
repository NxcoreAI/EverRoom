/**
 * slides 风格会话存取（slides_style_sessions 表）。会话跨用户轮次存续：
 * images_ready（等挑图）与 card_ready（等确认）期间网关重启不丢状态，
 * 主代理凭 roomId 找回活跃会话续跑。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { slidesStyleSessions } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type {
  SlidesStyleStage,
  SlidesStyleSessionData,
  StyleOverviewImage,
  StyleParams,
} from "./types.js";

type StyleSessionRow = typeof slidesStyleSessions.$inferSelect;

function toData(row: StyleSessionRow): SlidesStyleSessionData {
  return {
    id: row.id,
    roomId: row.roomId,
    draftDocumentId: row.draftDocumentId,
    instruction: row.instruction,
    feedback: row.feedback,
    overviewImages: row.overviewImages,
    selectedImageHash: row.selectedImageHash,
    styleParams: (row.styleParams as StyleParams | null) ?? null,
    demoImageHash: row.demoImageHash,
    stage: row.stage as SlidesStyleStage,
    generation: row.generation,
  };
}

export class SlidesStyleSessionStore {
  constructor(private readonly db: GatewayDatabase) {}

  create(input: { roomId: string; draftDocumentId: string | null; instruction: string }): SlidesStyleSessionData {
    const now = new Date();
    const data: SlidesStyleSessionData = {
      id: randomUUID(),
      roomId: input.roomId,
      draftDocumentId: input.draftDocumentId,
      instruction: input.instruction.slice(0, 4_000),
      feedback: [],
      overviewImages: [],
      selectedImageHash: null,
      styleParams: null,
      demoImageHash: null,
      stage: "extracting",
      generation: 1,
    };
    this.db.insert(slidesStyleSessions).values({ ...data, createdAt: now, updatedAt: now }).run();
    return data;
  }

  /** 活跃会话：尚在等用户动作（挑图/确认风格卡）的最新一条。 */
  findActive(roomId: string): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(and(
        eq(slidesStyleSessions.roomId, roomId),
        inArray(slidesStyleSessions.stage, ["images_ready", "card_ready"]),
      ))
      .orderBy(desc(slidesStyleSessions.updatedAt))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  byId(id: string): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(eq(slidesStyleSessions.id, id))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  /** Find the latest style session attached to a confirmed draft for continuation calls. */
  byDraftId(roomId: string, draftDocumentId: string): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(and(
        eq(slidesStyleSessions.roomId, roomId),
        eq(slidesStyleSessions.draftDocumentId, draftDocumentId),
      ))
      .orderBy(desc(slidesStyleSessions.updatedAt))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  patch(id: string, fields: Partial<{
    instruction: string;
    feedback: string[];
    overviewImages: StyleOverviewImage[];
    selectedImageHash: string | null;
    styleParams: StyleParams | null;
    demoImageHash: string | null;
    stage: SlidesStyleStage;
    generation: number;
  }>): void {
    if (Object.keys(fields).length === 0) return;
    this.db.update(slidesStyleSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(slidesStyleSessions.id, id))
      .run();
  }
}
