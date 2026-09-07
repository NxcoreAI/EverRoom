/**
 * M4 存量身份改写（宿主侧）。
 *
 * 原为 submodule gateway-module/domain-projection.ts 的一部分；submodule
 * 自包含化时迁出——六张身份表是宿主 room/ingest 域的表，归宿主所有，
 * 域行 id 解析所需的 connector 域表对象来自 connector submodule。
 *
 * 幂等：ref 全部消失后再跑为 no-op。解析失败/域行缺失的 ref 不动
 * （读侧 ref 兜底通道保留一个周期），只计数不静默丢弃。
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  connectorCalendarEvents,
  connectorEmails,
} from "@nxcore/connectors-module/domain-schema.js";
import { parseConnectorSourceRef } from "@nxcore/connectors-module/domain-projection.js";
import {
  entityDocLinks,
  ingestEvents,
  roomEntityMentions,
  roomMemoryAttributions,
  roomSourceMemberships,
  routeDecisions,
} from "../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../infrastructure/database/client.js";

type ProjectionDatabase = Pick<GatewayDatabase, "select" | "insert" | "update" | "delete">;

export interface IdentityRewriteSummary {
  /** 扫描到的 connector ref 引用数（跨全部身份表去重前）。 */
  refs: number;
  rewritten: number;
  unresolved: number;
  deduped: { memberships: number; entityLinks: number };
}

/** 六张身份表：connector ref 出现的全部位置（sourceKind + sourceId 成对）。 */
const IDENTITY_TABLES = [roomSourceMemberships, roomEntityMentions, routeDecisions, entityDocLinks, roomMemoryAttributions, ingestEvents] as const;

export function rewriteConnectorRefIdentities(db: ProjectionDatabase): IdentityRewriteSummary {
  const kindOfRef = (kind: string): "mail" | "calendar-event" | null =>
    kind === "mail" ? "mail" : kind === "calendar" ? "calendar-event" : null;
  // 收集全部 ref（跨表 DISTINCT）。
  const refs = new Set<string>();
  for (const table of IDENTITY_TABLES) {
    const rows = db.select({ sourceId: table.sourceId }).from(table)
      .where(sql`${table.sourceId} LIKE 'connector:%'`)
      .all();
    for (const row of rows)
      if (typeof row.sourceId === "string" && row.sourceId.startsWith("connector:")) refs.add(row.sourceId);
  }
  const summary: IdentityRewriteSummary = { refs: refs.size, rewritten: 0, unresolved: 0, deduped: { memberships: 0, entityLinks: 0 } };
  // ref → 域行 id。
  const refToId = new Map<string, string>();
  for (const ref of refs) {
    const parsed = parseConnectorSourceRef(ref);
    const kind = parsed ? kindOfRef(parsed.kind) : null;
    if (!parsed || !kind) { summary.unresolved += 1; continue; }
    const table = kind === "mail" ? connectorEmails : connectorCalendarEvents;
    const row = db.select({ id: table.id }).from(table).where(and(
      eq(table.service, parsed.provider),
      eq(table.connectionName, parsed.connectionId),
      eq(table.sourceRecordId, parsed.recordId),
    )).get();
    if (!row) { summary.unresolved += 1; continue; }
    refToId.set(ref, row.id);
  }
  // 原地改写六张表。memberships / entity_doc_links 带业务唯一键
  // （(room,kind,sourceId) / (entity,kind,sourceId)）：CLI 行已用目标 id 时，
  // ref 行改写会撞唯一键——预删冲突 ref 行（保留既有行，信息不丢）。
  for (const [ref, id] of refToId) {
    const parsed = parseConnectorSourceRef(ref)!;
    const kind = kindOfRef(parsed.kind)!;
    // memberships 冲突预删：同 room 已存在目标 sourceId 的行 → 删 ref 行。
    const conflictRooms = db.select({ roomId: roomSourceMemberships.roomId }).from(roomSourceMemberships)
      .where(and(eq(roomSourceMemberships.sourceKind, kind), eq(roomSourceMemberships.sourceId, id))).all();
    if (conflictRooms.length > 0) {
      const removed = db.delete(roomSourceMemberships).where(and(
        eq(roomSourceMemberships.sourceKind, kind),
        eq(roomSourceMemberships.sourceId, ref),
        inArray(roomSourceMemberships.roomId, conflictRooms.map((row) => row.roomId)),
      )).run().changes;
      summary.deduped.memberships += removed;
    }
    // entity_doc_links 冲突预删：同 entity 已存在目标 sourceId 的行。
    const conflictEntities = db.select({ entityId: entityDocLinks.entityId }).from(entityDocLinks)
      .where(and(eq(entityDocLinks.sourceKind, kind), eq(entityDocLinks.sourceId, id))).all();
    if (conflictEntities.length > 0) {
      const removed = db.delete(entityDocLinks).where(and(
        eq(entityDocLinks.sourceKind, kind),
        eq(entityDocLinks.sourceId, ref),
        inArray(entityDocLinks.entityId, conflictEntities.map((row) => row.entityId)),
      )).run().changes;
      summary.deduped.entityLinks += removed;
    }
    for (const table of IDENTITY_TABLES) {
      db.update(table).set({ sourceId: id }).where(and(
        eq(table.sourceKind, kind),
        eq(table.sourceId, ref),
      )).run();
    }
    summary.rewritten += 1;
  }
  return summary;
}
