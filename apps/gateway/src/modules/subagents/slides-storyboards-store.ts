/**
 * slides 编辑层 storyboard 存取（slides_storyboards 表）。
 * M1 影子模式：每次 generate 按「草稿 + 内容 hash」覆盖保存 editor 输出与验收报告；
 * M3 接线后 layouter 从这里取 storyboard，网关重启不丢。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { slidesStoryboards } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { EditorShadowReport, EditorStoryboard } from "./slides-editor.js";
import type { SemanticReport, SemanticStoryboard } from "./slides-semantic-contract.js";

export interface SlidesStoryboardRecord {
  id: string;
  roomId: string;
  draftDocumentId: string;
  draftHash: string;
  storyboard: EditorStoryboard | SemanticStoryboard;
  report: EditorShadowReport | SemanticReport;
  updatedAt: number;
}

type Row = typeof slidesStoryboards.$inferSelect;

function toRecord(row: Row): SlidesStoryboardRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    draftDocumentId: row.draftDocumentId,
    draftHash: row.draftHash,
    storyboard: row.storyboard as unknown as SlidesStoryboardRecord["storyboard"],
    report: row.report as unknown as SlidesStoryboardRecord["report"],
    updatedAt: row.updatedAt.getTime(),
  };
}

export class SlidesStoryboardStore {
  constructor(private readonly db: GatewayDatabase) {}

  /** 同草稿同 hash 覆盖；草稿内容变化（hash 不同）保留旧版本便于对比回滚。 */
  save(input: {
    roomId: string;
    draftDocumentId: string;
    draftHash: string;
    storyboard: EditorStoryboard | SemanticStoryboard;
    report: EditorShadowReport | SemanticReport;
  }): SlidesStoryboardRecord {
    if (input.storyboard.schemaVersion === "storyboard/v3" && !input.draftHash.startsWith("semantic-v3:")) {
      throw new Error("semantic_storyboard_key_required: include contract, source, style and asset configuration in the hash");
    }
    const now = new Date();
    const existing = this.db.select({ id: slidesStoryboards.id })
      .from(slidesStoryboards)
      .where(and(
        eq(slidesStoryboards.roomId, input.roomId),
        eq(slidesStoryboards.draftDocumentId, input.draftDocumentId),
        eq(slidesStoryboards.draftHash, input.draftHash),
      ))
      .get();
    if (existing) {
      this.db.update(slidesStoryboards)
        .set({
          storyboard: input.storyboard as unknown as Record<string, unknown>,
          report: input.report as unknown as Record<string, unknown>,
          updatedAt: now,
        })
        .where(eq(slidesStoryboards.id, existing.id))
        .run();
      return {
        id: existing.id,
        roomId: input.roomId,
        draftDocumentId: input.draftDocumentId,
        draftHash: input.draftHash,
        storyboard: input.storyboard,
        report: input.report,
        updatedAt: now.getTime(),
      };
    }
    const record: SlidesStoryboardRecord = {
      id: randomUUID(),
      roomId: input.roomId,
      draftDocumentId: input.draftDocumentId,
      draftHash: input.draftHash,
      storyboard: input.storyboard,
      report: input.report,
      updatedAt: now.getTime(),
    };
    this.db.insert(slidesStoryboards).values({
      id: record.id,
      roomId: record.roomId,
      draftDocumentId: record.draftDocumentId,
      draftHash: record.draftHash,
      storyboard: record.storyboard as unknown as Record<string, unknown>,
      report: record.report as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }).run();
    return record;
  }

  byDraft(roomId: string, draftDocumentId: string): SlidesStoryboardRecord | null {
    const row = this.db.select()
      .from(slidesStoryboards)
      .where(and(
        eq(slidesStoryboards.roomId, roomId),
        eq(slidesStoryboards.draftDocumentId, draftDocumentId),
      ))
      .orderBy(desc(slidesStoryboards.updatedAt))
      .limit(1)
      .get();
    return row ? toRecord(row) : null;
  }

  byDraftHash(roomId: string, draftDocumentId: string, draftHash: string): SlidesStoryboardRecord | null {
    const row = this.db.select()
      .from(slidesStoryboards)
      .where(and(
        eq(slidesStoryboards.roomId, roomId),
        eq(slidesStoryboards.draftDocumentId, draftDocumentId),
        eq(slidesStoryboards.draftHash, draftHash),
      ))
      .get();
    return row ? toRecord(row) : null;
  }
}
