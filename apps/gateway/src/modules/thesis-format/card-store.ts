/**
 * 论文格式卡存取（thesis_format_cards 表）。一 Room 多卡：
 * (room_id, source_name) 唯一，重传同名模版即覆盖；排版按卡 id 取用。
 */

import { and, desc, eq } from "drizzle-orm";
import { thesisFormatCards } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { ThesisFormatCard } from "./types.js";

export interface ThesisFormatCardRow {
  id: string;
  card: ThesisFormatCard;
  sourceName: string;
  sourceFileEntryId: string | null;
  updatedAt: Date;
}

function toRow(row: typeof thesisFormatCards.$inferSelect): ThesisFormatCardRow {
  return {
    id: row.id,
    card: row.formatCard as unknown as ThesisFormatCard,
    sourceName: row.sourceName,
    sourceFileEntryId: row.sourceFileEntryId,
    updatedAt: row.updatedAt,
  };
}

export class ThesisFormatCardStore {
  constructor(private readonly db: GatewayDatabase) {}

  list(roomId: string): ThesisFormatCardRow[] {
    return this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, roomId))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .all()
      .map(toRow);
  }

  byId(roomId: string, cardId: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.roomId, roomId)))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  /** 最新一张卡（reformat 未指明 cardId 时的缺省）。 */
  latest(roomId: string): ThesisFormatCardRow | null {
    const row = this.db.select().from(thesisFormatCards)
      .where(eq(thesisFormatCards.roomId, roomId))
      .orderBy(desc(thesisFormatCards.updatedAt))
      .limit(1)
      .get();
    return row ? toRow(row) : null;
  }

  remove(roomId: string, cardId: string): boolean {
    const result = this.db.delete(thesisFormatCards)
      .where(and(eq(thesisFormatCards.id, cardId), eq(thesisFormatCards.roomId, roomId)))
      .run();
    return result.changes > 0;
  }

  upsert(input: { roomId: string; card: ThesisFormatCard; sourceFileEntryId: string | null; sourceName: string }): ThesisFormatCardRow {
    const now = new Date();
    this.db.insert(thesisFormatCards)
      .values({
        id: crypto.randomUUID(),
        roomId: input.roomId,
        formatCard: input.card as unknown as Record<string, unknown>,
        sourceFileEntryId: input.sourceFileEntryId,
        sourceName: input.sourceName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [thesisFormatCards.roomId, thesisFormatCards.sourceName],
        set: {
          formatCard: input.card as unknown as Record<string, unknown>,
          sourceFileEntryId: input.sourceFileEntryId,
          updatedAt: now,
        },
      })
      .run();
    const row = this.db.select().from(thesisFormatCards)
      .where(and(eq(thesisFormatCards.roomId, input.roomId), eq(thesisFormatCards.sourceName, input.sourceName)))
      .limit(1)
      .get();
    if (!row) throw new Error("thesis_format_card_upsert_failed");
    return toRow(row);
  }
}
