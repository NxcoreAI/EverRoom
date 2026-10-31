/**
 * slides 风格会话存取（slides_style_sessions 表）。会话跨用户轮次存续：
 * images_ready（等挑图）与 card_ready（等确认）期间网关重启不丢状态，
 * 主代理凭 draftDocumentId / 会话 id 找回活跃会话续跑。
 *
 * 单工作区语义：读路径不按 Room 过滤。表上的 `room_id` 是 NOT NULL 历史列，
 * 本阶段不改 schema：写入统一填 `WORKSPACE_DOCUMENT_CHANNEL`——旧库里带真实
 * roomId 的行仍能被读到（续跑不丢）。
 */

import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
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

  create(input: { draftDocumentId: string | null; instruction: string }): SlidesStyleSessionData {
    const now = new Date();
    const data: SlidesStyleSessionData = {
      id: randomUUID(),
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
    this.db.insert(slidesStyleSessions).values({
      ...data,
      // 历史 NOT NULL 列：单工作区语义统一填工作区频道。
      roomId: WORKSPACE_DOCUMENT_CHANNEL,
      createdAt: now,
      updatedAt: now,
    }).run();
    return data;
  }

  /** 活跃会话：尚在等用户动作（挑图/确认风格卡）的最新一条。 */
  findActive(): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(inArray(slidesStyleSessions.stage, ["images_ready", "card_ready"]))
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

  /** 最新一条已产出风格卡（card_ready/confirmed）的会话：generate 无有效 id 时的自动恢复入口。 */
  latestWithStyleCard(): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(inArray(slidesStyleSessions.stage, ["card_ready", "confirmed"]))
      .orderBy(desc(slidesStyleSessions.updatedAt))
      .limit(1)
      .get();
    return row ? toData(row) : null;
  }

  /** Find the latest style session attached to a confirmed draft for continuation calls. */
  byDraftId(draftDocumentId: string): SlidesStyleSessionData | null {
    const row = this.db.select().from(slidesStyleSessions)
      .where(eq(slidesStyleSessions.draftDocumentId, draftDocumentId))
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
