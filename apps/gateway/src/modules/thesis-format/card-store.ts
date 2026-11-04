/**
 * 论文格式卡存取（thesis_format_cards 表）。一工作区多卡：
 * (workspace_id, source_name) 唯一，重传同名模版即覆盖；排版按卡 id 取用。
 */

import { and, desc, eq } from "drizzle-orm";
import { thesisFormatCards } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { ThesisFormatCard } from "./types.js";

/** 默认工作区 id（与 files/agent 的 default 工作区同名）；归属缺失时按它归一。 */
export const DEFAULT_THESIS_WORKSPACE_ID = "default";

export interface ThesisFormatCardRow {
  id: string;
  workspaceId: string;
  card: ThesisFormatCard;
  sourceName: string;
  sourceFileEntryId: string | null;
  updatedAt: Date;
}

function toRow(row: typeof thesisFormatCards.$inferSelect): ThesisFormatCardRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    card: row.formatCard as unknown as ThesisFormatCard,
    sourceName: row.sourceName,
    sourceFileEntryId: row.sourceFileEntryId,
    updatedAt: row.updatedAt,
  };
}

export class ThesisFormatCardStore {
  constructor(private readonly db: GatewayDatabase) {}

  list(workspaceId: string): ThesisFormatCardRow[] {
    return this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.workspaceId, workspaceId))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .all()
      .map(toRow);
  }

  byId(workspaceId: string, cardId: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.workspaceId, workspaceId)))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  /** 最新一张卡（reformat 未指明 cardId 时的缺省）。 */
  latest(workspaceId: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.workspaceId, workspaceId))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  remove(workspaceId: string, cardId: string): boolean {
    const result = this.db.delete(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.workspaceId, workspaceId)))
      .run();
    return result.changes > 0;
  }

  upsert(input: {
    workspaceId: string;
    card: ThesisFormatCard;
    sourceFileEntryId: string | null;
    sourceName: string;
  }): ThesisFormatCardRow {
    const now = new Date();
    this.db.insert(thesisFormatCards)
      .values({
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        formatCard: input.card as unknown as Record<string, unknown>,
        sourceFileEntryId: input.sourceFileEntryId,
        sourceName: input.sourceName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [thesisFormatCards.workspaceId, thesisFormatCards.sourceName],
        set: {
          formatCard: input.card as unknown as Record<string, unknown>,
          sourceFileEntryId: input.sourceFileEntryId,
          updatedAt: now,
        },
      })
      .run();
    const row = this.db.select().from(thesisFormatCards)
      .where(and(
        eq(thesisFormatCards.workspaceId, input.workspaceId),
        eq(thesisFormatCards.sourceName, input.sourceName),
      ))
      .limit(1)
      .get();
    if (!row) throw new Error("thesis_format_card_upsert_failed");
    return toRow(row);
  }
}