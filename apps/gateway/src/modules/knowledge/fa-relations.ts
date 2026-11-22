/**
 * FA 实体级语义关系（fa-industry-iteration 工作项一：语义关系自动抽取）。
 *
 * 数据流：entity-extraction 抽出五类业务关系候选（subject/object 引用本次
 * 抽取实体的规范名）→ router 在实体解析循环中把名字换成已注册实体 id →
 * 本模块 upsert 进 fa_relations（status=pending 的待确认队列，同三元组
 * 指纹跳过）→ 用户确认后：两端晋升的投影为房图谱类型化边（room_relations
 * 的 manualType=FA 类型），employed_by 另落 fa_positions 结构化任职档案。
 *
 * 设计对齐 FA 三表（fa_funds/fa_investments/fa_positions）：确认制、
 * 来源与证据链、"结构化字段直接读库参与计算，不经模型生成"。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { entities, faRelations, roomRelations } from "../../infrastructure/database/schema.js";
import type { FaRelationType } from "./llm.js";

/** 最小 logger 契约（与 KnowledgeServiceLogger 对齐，避免拉 pino 全接口）。 */
export interface FaRelationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export type FaRelationStatus = "pending" | "confirmed" | "dismissed";

/** router 抽取后送入的关系候选（实体名已解析为 id）。 */
export interface FaRelationCandidate {
  type: FaRelationType;
  subjectEntityId: string;
  objectEntityId: string;
  title?: string;
  fromYear?: number;
  toYear?: number;
  round?: string;
  role?: "lead" | "co_follow";
  sourceKind?: string;
  sourceId?: string;
  evidence?: string;
}

export interface FaRelationRow {
  id: string;
  type: FaRelationType;
  subjectEntityId: string;
  objectEntityId: string;
  subjectRoomId: string | null;
  objectRoomId: string | null;
  title: string | null;
  fromYear: number | null;
  toYear: number | null;
  round: string | null;
  role: "lead" | "co_follow" | null;
  sourceKind: string | null;
  sourceId: string | null;
  evidence: string | null;
  status: FaRelationStatus;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  roomRelationId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FaRelationDto extends FaRelationRow {
  /** subject/object 的展示名（join entities；实体可能已被归档，null 容错）。 */
  subjectName: string | null;
  objectName: string | null;
  subjectKind: string | null;
  objectKind: string | null;
}

function toRow(record: typeof faRelations.$inferSelect): FaRelationRow {
  return {
    id: record.id,
    type: record.type as FaRelationType,
    subjectEntityId: record.subjectEntityId,
    objectEntityId: record.objectEntityId,
    subjectRoomId: record.subjectRoomId,
    objectRoomId: record.objectRoomId,
    title: record.title,
    fromYear: record.fromYear,
    toYear: record.toYear,
    round: record.round,
    role: record.role as "lead" | "co_follow" | null,
    sourceKind: record.sourceKind,
    sourceId: record.sourceId,
    evidence: record.evidence,
    status: record.status as FaRelationStatus,
    confirmedBy: record.confirmedBy,
    confirmedAt: record.confirmedAt ?? null,
    roomRelationId: record.roomRelationId,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class FaRelationStore {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: FaRelationLogger,
  ) {}

  /**
   * 抽取候选批量入库：同三元组（type+subject+object）已存在则跳过
   * （首轮插入确定；重复出现是同关系在不同资料中的重述，不是新事实）。
   * 端点实体已晋升的（entities.roomId 非空）插入时直接带上 roomId，
   * 让确认时可投影房边——backfillRoomIds 只覆盖晋升之后到达的旧行。
   * 返回新增条数供路由日志。
   */
  ingestCandidates(candidates: FaRelationCandidate[]): number {
    if (candidates.length === 0) return 0;
    const existing = this.db.select({
      type: faRelations.type,
      subjectEntityId: faRelations.subjectEntityId,
      objectEntityId: faRelations.objectEntityId,
    }).from(faRelations)
      .where(inArray(faRelations.type, candidates.map((item) => item.type)))
      .all();
    const seen = new Set(existing.map((row) => `${row.type}\u0000${row.subjectEntityId}\u0000${row.objectEntityId}`));
    // 端点实体的当前 roomId（已晋升则投影条件即刻可满足）
    const entityIds = [...new Set(candidates.flatMap((item) => [item.subjectEntityId, item.objectEntityId]))];
    const promotedRooms = new Map(this.db.select({
      id: entities.id,
      roomId: entities.roomId,
    }).from(entities).where(inArray(entities.id, entityIds)).all()
      .flatMap((row) => (row.roomId ? [[row.id, row.roomId] as const] : [])));
    const now = new Date();
    let inserted = 0;
    for (const candidate of candidates) {
      const fingerprint = `${candidate.type}\u0000${candidate.subjectEntityId}\u0000${candidate.objectEntityId}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      this.db.insert(faRelations).values({
        id: `farel-${randomUUID().slice(0, 12)}`,
        type: candidate.type,
        subjectEntityId: candidate.subjectEntityId,
        objectEntityId: candidate.objectEntityId,
        subjectRoomId: promotedRooms.get(candidate.subjectEntityId) ?? null,
        objectRoomId: promotedRooms.get(candidate.objectEntityId) ?? null,
        ...(candidate.title ? { title: candidate.title } : {}),
        ...(candidate.fromYear != null ? { fromYear: candidate.fromYear } : {}),
        ...(candidate.toYear != null ? { toYear: candidate.toYear } : {}),
        ...(candidate.round ? { round: candidate.round } : {}),
        ...(candidate.role ? { role: candidate.role } : {}),
        ...(candidate.sourceKind ? { sourceKind: candidate.sourceKind } : {}),
        ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
        ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }).run();
      inserted += 1;
    }
    if (inserted > 0) {
      this.logger.info(
        { event: "knowledge.fa.relation_candidates", inserted, total: candidates.length },
        `FA 关系候选新增 ${inserted} 条（共 ${candidates.length} 条）`,
      );
    }
    return inserted;
  }

  list(status: FaRelationStatus | "all", limit = 50): FaRelationDto[] {
    const rows = (status === "all"
      ? this.db.select().from(faRelations).orderBy(desc(faRelations.updatedAt))
      : this.db.select().from(faRelations).where(eq(faRelations.status, status)).orderBy(desc(faRelations.updatedAt))
    ).all().slice(0, limit);
    return this.attachNames(rows.map(toRow));
  }

  /** 按 id 批量取（confirm/dismiss 端点回包用）。 */
  listByIds(ids: string[]): FaRelationDto[] {
    if (ids.length === 0) return [];
    const rows = this.db.select().from(faRelations).where(inArray(faRelations.id, ids)).all();
    return this.attachNames(rows.map(toRow));
  }

  /** 实体晋升后回填 Room id（promotion 流程调用；两端齐了才可能投影房边）。 */
  backfillRoomIds(entityId: string, roomId: string): void {
    this.db.update(faRelations)
      .set({ subjectRoomId: roomId, updatedAt: new Date() })
      .where(and(eq(faRelations.subjectEntityId, entityId), isNull(faRelations.subjectRoomId)))
      .run();
    this.db.update(faRelations)
      .set({ objectRoomId: roomId, updatedAt: new Date() })
      .where(and(eq(faRelations.objectEntityId, entityId), isNull(faRelations.objectRoomId)))
      .run();
  }

  /**
   * 实体合并迁移（对齐 RoomRelationRegistry.rewriteEntity）：from 实体的关系行
   * 改指 target。subject/object 两端合并成同一条（自环）或撞 triple 唯一索引的行删除；
   * 自环（subject==object）无业务含义，一并删除。
   */
  rewriteEntity(fromEntityId: string, toEntityId: string): void {
    if (fromEntityId === toEntityId) return;
    const now = new Date();
    const rows = this.db.select().from(faRelations)
      .where(or(eq(faRelations.subjectEntityId, fromEntityId), eq(faRelations.objectEntityId, fromEntityId)))
      .all();
    if (rows.length === 0) return;
    const existing = new Set(this.db.select({
      type: faRelations.type,
      subjectEntityId: faRelations.subjectEntityId,
      objectEntityId: faRelations.objectEntityId,
    }).from(faRelations).all()
      .map((row) => `${row.type}\u0000${row.subjectEntityId}\u0000${row.objectEntityId}`));
    for (const row of rows) {
      const subjectEntityId = row.subjectEntityId === fromEntityId ? toEntityId : row.subjectEntityId;
      const objectEntityId = row.objectEntityId === fromEntityId ? toEntityId : row.objectEntityId;
      if (subjectEntityId === objectEntityId) {
        this.db.delete(faRelations).where(eq(faRelations.id, row.id)).run();
        continue;
      }
      const fingerprint = `${row.type}\u0000${subjectEntityId}\u0000${objectEntityId}`;
      if (existing.has(fingerprint)) {
        this.db.delete(faRelations).where(eq(faRelations.id, row.id)).run();
        continue;
      }
      existing.add(fingerprint);
      this.db.update(faRelations).set({
        subjectEntityId,
        objectEntityId,
        // 实体换了，旧的 Room 投影引用作废（下次确认/重建时重投影）
        subjectRoomId: null,
        objectRoomId: null,
        roomRelationId: null,
        updatedAt: now,
      }).where(eq(faRelations.id, row.id)).run();
    }
  }

  /**
   * 确认：pending → confirmed。两端均已晋升（subject/object 都有 roomId）时，
   * 同步投影一条房图谱类型化边（manualType=FA 类型；manualFrom/To 定方向）。
   * employed_by 另落 fa_positions（结构化任职档案，供决策链/匹配读库）——
   * 由 service 层的 confirmFaRelation 编排（需校验 kind），本 store 只管关系表自身。
   */
  confirm(id: string, confirmedBy: string): FaRelationRow | null {
    const record = this.db.select().from(faRelations).where(eq(faRelations.id, id)).get();
    if (!record || record.deletedAt) return null;
    if (record.status !== "pending") return toRow(record); // 幂等：已确认直接返回
    const now = new Date();
    let roomRelationId: string | null = record.roomRelationId;
    if (record.subjectRoomId && record.objectRoomId && !roomRelationId) {
      roomRelationId = this.projectToRoomRelation(record, now);
    }
    this.db.update(faRelations).set({
      status: "confirmed",
      confirmedBy,
      confirmedAt: now,
      ...(roomRelationId ? { roomRelationId } : {}),
      updatedAt: now,
    }).where(eq(faRelations.id, id)).run();
    const updated = this.db.select().from(faRelations).where(eq(faRelations.id, id)).get();
    this.logger.info(
      { event: "knowledge.fa.relation_confirmed", id, type: record.type },
      `FA 关系已确认：${record.type}`,
    );
    return updated ? toRow(updated) : null;
  }

  dismiss(id: string): FaRelationRow | null {
    const record = this.db.select().from(faRelations).where(eq(faRelations.id, id)).get();
    if (!record || record.deletedAt || record.status !== "pending") return record ? toRow(record) : null;
    const now = new Date();
    this.db.update(faRelations)
      .set({ status: "dismissed", updatedAt: now })
      .where(eq(faRelations.id, id))
      .run();
    return toRow({ ...record, status: "dismissed", updatedAt: now });
  }

  /** 确认时投影房图谱边：复用 room_relations 的行（manual 槽位），方向 manualFrom → manualTo。 */
  private projectToRoomRelation(record: typeof faRelations.$inferSelect, now: Date): string | null {
    const subjectRoomId = record.subjectRoomId!;
    const objectRoomId = record.objectRoomId!;
    if (subjectRoomId === objectRoomId) return null;
    // 排序对（room_relations 的 roomA/roomB 无方向语义，唯一索引要求稳定序）
    const [roomAId, roomBId] = subjectRoomId < objectRoomId
      ? [subjectRoomId, objectRoomId]
      : [objectRoomId, subjectRoomId];
    // room_relations.manualType 无 partner_of：投影为语义最接近的 related + label
    const projectedType = record.type === "partner_of" ? "related" : record.type;
    const manualFromRoomId = record.type === "partner_of" ? null : subjectRoomId;
    const manualToRoomId = record.type === "partner_of" ? null : objectRoomId;
    const existing = this.db.select().from(roomRelations)
      .where(and(eq(roomRelations.roomAId, roomAId), eq(roomRelations.roomBId, roomBId)))
      .get();
    if (existing) {
      // 已有行（auto 共现边常见）：manual 槽位空则补，占用了则只刷 note
      this.db.update(roomRelations).set({
        ...(existing.manualType ? {} : {
          manualType: projectedType,
          manualFromRoomId,
          manualToRoomId,
        }),
        ...(record.evidence && !existing.manualNote ? { manualNote: record.evidence.slice(0, 300) } : {}),
        updatedAt: now,
      }).where(eq(roomRelations.id, existing.id)).run();
      return existing.id;
    }
    const id = `rel-${randomUUID().slice(0, 12)}`;
    this.db.insert(roomRelations).values({
      id,
      roomAId,
      roomBId,
      autoScore: 0,
      autoType: "shared_entity",
      strength: "weak",
      manualType: projectedType,
      ...(manualFromRoomId ? { manualFromRoomId } : {}),
      ...(manualToRoomId ? { manualToRoomId } : {}),
      ...(record.evidence ? { manualNote: record.evidence.slice(0, 300) } : {}),
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  private attachNames(rows: FaRelationRow[]): FaRelationDto[] {
    if (rows.length === 0) return [];
    const entityIds = [...new Set(rows.flatMap((row) => [row.subjectEntityId, row.objectEntityId]))];
    const entityRows = this.db.select({
      id: entities.id,
      name: entities.name,
      kind: entities.kind,
    }).from(entities).where(inArray(entities.id, entityIds)).all();
    const byId = new Map(entityRows.map((row) => [row.id, row]));
    return rows.map((row) => ({
      ...row,
      subjectName: byId.get(row.subjectEntityId)?.name ?? null,
      objectName: byId.get(row.objectEntityId)?.name ?? null,
      subjectKind: byId.get(row.subjectEntityId)?.kind ?? null,
      objectKind: byId.get(row.objectEntityId)?.kind ?? null,
    }));
  }
}
