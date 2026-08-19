/**
 * 实体注册表访问层（entity-room-plan §3.1/§4.2/§4.3/§4.4/§4.5）：
 * entities + entity_doc_links 的全部 DB 操作与纯函数。
 *
 * 归属的单一事实源在这里（route_decisions 已降级为审计流水）；
 * 解析的编排（抽取 → 匹配 → 判定）在 router.ts，本层只提供机械。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { entities, entityDocLinks, rooms } from "../../infrastructure/database/schema.js";
import { blendCentroid, decodeCentroid, encodeCentroid } from "./embedding.js";
import { ENTITY_KINDS, type EntityKind } from "./llm.js";

export type EntityStatus = "weak" | "ready" | "promoting" | "room" | "archived";
export type LinkRole = "primary" | "mention" | "manual";
export type SourceKind = "everroom-doc" | "reality-event" | "mail" | "file" | "cloud-doc";

/** 链接角色 → 证据分权重（plan §4.3）。 */
export const EVIDENCE_WEIGHTS: Record<LinkRole, number> = {
  primary: 1.0,
  mention: 0.4,
  manual: 1.5,
};

export function evidenceWeightOf(role: LinkRole): number {
  return EVIDENCE_WEIGHTS[role];
}

/** kind 列是 enum 文本：外部输入（REST/rooms 行）先过这个收口，非法值落"主题"。 */
function normalizeKind(kind: string): EntityKind {
  const trimmed = kind.trim();
  return (ENTITY_KINDS as readonly string[]).includes(trimmed) ? (trimmed as EntityKind) : "主题";
}

export interface EntityRow {
  id: string;
  name: string;
  aliases: string[];
  kind: EntityKind;
  summary: string | null;
  status: EntityStatus;
  roomId: string | null;
  evidenceScore: number;
  sourceCount: number;
  centroid: string | null;
  centroidDocs: number;
  centroidModel: string | null;
  mergedFrom: string[];
  lastLinkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntityLinkRow {
  id: string;
  entityId: string;
  sourceKind: SourceKind;
  sourceId: string;
  sourceVersion: number;
  role: LinkRole;
  salience: number;
  evidence: string | null;
  decidedBy: "resolution" | "user";
  createdAt: Date;
  updatedAt: Date;
}

function toEntityRow(row: typeof entities.$inferSelect): EntityRow {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    roomId: row.roomId,
    evidenceScore: row.evidenceScore,
    sourceCount: row.sourceCount,
    centroid: row.centroid,
    centroidDocs: row.centroidDocs,
    centroidModel: row.centroidModel,
    mergedFrom: row.mergedFrom ?? [],
    lastLinkedAt: row.lastLinkedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLinkRow(row: typeof entityDocLinks.$inferSelect): EntityLinkRow {
  return {
    id: row.id,
    entityId: row.entityId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    role: row.role,
    salience: row.salience,
    evidence: row.evidence,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * ED3：primary 由网关侧从 salience 推导——每份资料恰一个 primary，
 * 绝对并列允许 2 个；其余 mention。不信任 LLM 的角色标注纪律。
 */
export function derivePrimaryRoles<T extends { name: string; salience: number }>(
  extracted: T[],
): Map<string, LinkRole> {
  const roles = new Map<string, LinkRole>();
  if (extracted.length === 0) return roles;
  let max = -Infinity;
  for (const item of extracted) max = Math.max(max, item.salience);
  let primarySlots = 0;
  for (const item of extracted) {
    // 浮点容差：与最高分差 <1e-9 视为并列
    const isTop = Math.abs(item.salience - max) < 1e-9;
    if (isTop && primarySlots < 2) {
      roles.set(item.name, "primary");
      primarySlots += 1;
    } else {
      roles.set(item.name, "mention");
    }
  }
  return roles;
}

/** 晋升阈值判定（plan §4.3）：证据分与资料数双条件，且仅 weak 态可晋升。 */
export function meetsPromotionThreshold(
  entity: Pick<EntityRow, "status" | "evidenceScore" | "sourceCount">,
  thresholds: { promoteScore: number; promoteSources: number },
): boolean {
  return entity.status === "weak"
    && entity.evidenceScore >= thresholds.promoteScore
    && entity.sourceCount >= thresholds.promoteSources;
}

export class EntityRegistry {
  constructor(private readonly db: GatewayDatabase) {}

  // ───────────────────────── 查询 ─────────────────────────

  getEntity(id: string): EntityRow | null {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return row ? toEntityRow(row) : null;
  }

  listEntities(status?: EntityStatus): EntityRow[] {
    const query = this.db.select().from(entities);
    const rows = status ? query.where(eq(entities.status, status)) : query;
    return rows.orderBy(desc(entities.updatedAt)).all().map(toEntityRow);
  }

  /**
   * 解析池（③″ 的比对目标）：weak + ready + room 全量参与；
   * archived（老化/被合并）与 promoting（正在晋升）不参与。
   */
  loadResolutionPool(): EntityRow[] {
    return this.db.select().from(entities)
      .where(inArray(entities.status, ["weak", "ready", "room"]))
      .all()
      .map(toEntityRow);
  }

  linksOfEntity(entityId: string, roles?: LinkRole[]): EntityLinkRow[] {
    const conditions = [eq(entityDocLinks.entityId, entityId)];
    if (roles && roles.length > 0) conditions.push(inArray(entityDocLinks.role, roles));
    return this.db.select().from(entityDocLinks)
      .where(and(...conditions))
      .orderBy(desc(entityDocLinks.updatedAt))
      .all()
      .map(toLinkRow);
  }

  /** 同一资料对哪些实体建立了链接（闸 3 改查这里：版本回原处 → 查实体）。 */
  linksOfSource(sourceKind: SourceKind, sourceId: string): EntityLinkRow[] {
    return this.db.select().from(entityDocLinks)
      .where(and(eq(entityDocLinks.sourceKind, sourceKind), eq(entityDocLinks.sourceId, sourceId)))
      .all()
      .map(toLinkRow);
  }

  // ───────────────────────── 实体生命周期 ─────────────────────────

  /** 新建弱实体（plan §4.2 步骤 3）：不写合成式 summary（ED7），证据从 0 累积。 */
  createEntity(input: { name: string; kind: string; aliases?: string[] }): EntityRow {
    const now = new Date();
    const id = `ent-${randomUUID().slice(0, 12)}`;
    const name = input.name.trim().slice(0, 120);
    this.db.insert(entities).values({
      id,
      name,
      aliases: input.aliases && input.aliases.length > 0 ? input.aliases : null,
      kind: normalizeKind(input.kind),
      status: "weak",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    return this.getEntity(id)!;
  }

  /** ED4：Room 上报/创建时同步种子化户口实体（幂等：已有 entity_id 即跳过）。 */
  seedRoomEntity(room: { id: string; title: string; kind: string; aliases?: string[] }): EntityRow | null {
    const existing = this.db.select({ entityId: rooms.entityId }).from(rooms)
      .where(eq(rooms.id, room.id)).get();
    if (existing?.entityId) return this.getEntity(existing.entityId);
    const now = new Date();
    const id = `ent-room-${room.id}`;
    this.db.insert(entities).values({
      id,
      name: room.title.trim().slice(0, 120),
      aliases: room.aliases && room.aliases.length > 0 ? room.aliases : null,
      kind: normalizeKind(room.kind),
      status: "room",
      roomId: room.id,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    this.db.update(rooms).set({ entityId: id, updatedAt: now })
      .where(eq(rooms.id, room.id)).run();
    return this.getEntity(id);
  }

  /**
   * 链接落库（plan §4.3）：upsert（同 entity+source 唯一），新版本覆盖
   * role/salience/evidence；证据分按差额调整（版本更新不重复累加），
   * sourceCount 只在链接首次出现时 +1。
   */
  upsertLink(input: {
    entityId: string;
    sourceKind: SourceKind;
    sourceId: string;
    sourceVersion: number;
    role: LinkRole;
    salience?: number;
    evidence?: string | null;
    decidedBy: "resolution" | "user";
  }): EntityRow {
    const now = new Date();
    const existing = this.db.select().from(entityDocLinks)
      .where(and(
        eq(entityDocLinks.entityId, input.entityId),
        eq(entityDocLinks.sourceKind, input.sourceKind),
        eq(entityDocLinks.sourceId, input.sourceId),
      ))
      .get();

    const delta = evidenceWeightOf(input.role) - (existing ? evidenceWeightOf(existing.role) : 0);
    if (existing) {
      this.db.update(entityDocLinks).set({
        sourceVersion: input.sourceVersion,
        role: input.role,
        salience: input.salience ?? 0,
        evidence: input.evidence ?? null,
        decidedBy: input.decidedBy,
        updatedAt: now,
      }).where(eq(entityDocLinks.id, existing.id)).run();
    } else {
      this.db.insert(entityDocLinks).values({
        id: randomUUID(),
        entityId: input.entityId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        role: input.role,
        salience: input.salience ?? 0,
        evidence: input.evidence ?? null,
        decidedBy: input.decidedBy,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    // 老化归档的实体被新链接复活回 weak（plan §4.6）
    this.db.update(entities).set({
      evidenceScore: sql`MAX(0, ${entities.evidenceScore} + ${delta})`,
      sourceCount: existing ? sql`${entities.sourceCount}` : sql`${entities.sourceCount} + 1`,
      lastLinkedAt: now,
      status: sql`CASE WHEN ${entities.status} = 'archived' THEN 'weak' ELSE ${entities.status} END`,
      updatedAt: now,
    }).where(eq(entities.id, input.entityId)).run();
    return this.getEntity(input.entityId)!;
  }

  /** 手动挂载/转正后回填实体身份材料（登记产出或用户改名）。 */
  updateEntityIdentity(entityId: string, input: {
    name?: string;
    summary?: string | null;
    aliases?: string[];
    addAliases?: string[];
  }): EntityRow | null {
    const current = this.getEntity(entityId);
    if (!current) return null;
    const aliases = new Set(input.aliases ?? current.aliases);
    const name = input.name?.trim().slice(0, 120);
    if (name && name !== current.name) {
      aliases.add(current.name); // 旧名进 aliases（曾用名）
    }
    for (const alias of input.addAliases ?? []) {
      const trimmed = alias.trim().slice(0, 120);
      if (trimmed && trimmed !== name) aliases.add(trimmed);
    }
    aliases.delete(name ?? current.name);
    this.db.update(entities).set({
      ...(name ? { name } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      aliases: aliases.size > 0 ? [...aliases].slice(0, 20) : null,
      updatedAt: new Date(),
    }).where(eq(entities.id, entityId)).run();
    return this.getEntity(entityId);
  }

  /**
   * 合并（plan §4.5 全场景）：from 并入 into——链接迁移并集（同源撞行保
   * 证据权重高者）、aliases 并集、证据分相加、质心按文档数加权融合；
   * from 行转 archived（审计经 mergedFrom 可查）。
   * 返回双方 roomId（Room 级 wiki 级联由 service 层处理，本层不动 KS）。
   */
  mergeEntities(input: { intoId: string; fromId: string; reason?: string }): {
    into: EntityRow | null;
    from: EntityRow | null;
  } {
    const into = this.getEntity(input.intoId);
    const from = this.getEntity(input.fromId);
    if (!into || !from || into.id === from.id) return { into, from };

    // 1. 链接迁移：同源已有目标链接时保留证据权重高的角色
    const moving = this.linksOfEntity(from.id);
    const existingBySource = new Map(
      this.linksOfEntity(into.id).map((link) => [`${link.sourceKind}:${link.sourceId}`, link]),
    );
    const now = new Date();
    for (const link of moving) {
      const key = `${link.sourceKind}:${link.sourceId}`;
      const clash = existingBySource.get(key);
      if (!clash) {
        this.db.update(entityDocLinks).set({ entityId: into.id, updatedAt: now })
          .where(eq(entityDocLinks.id, link.id)).run();
      } else if (evidenceWeightOf(link.role) > evidenceWeightOf(clash.role)) {
        this.db.update(entityDocLinks).set({
          role: link.role,
          salience: Math.max(clash.salience, link.salience),
          evidence: clash.evidence ?? link.evidence,
          sourceVersion: Math.max(clash.sourceVersion, link.sourceVersion),
          updatedAt: now,
        }).where(eq(entityDocLinks.id, clash.id)).run();
        // 并集语义：败方行删除（权重已被胜方行吸收，留着只会变成
        // archived 实体名下的悬垂链接）
        this.db.delete(entityDocLinks).where(eq(entityDocLinks.id, link.id)).run();
      } else {
        this.db.delete(entityDocLinks).where(eq(entityDocLinks.id, link.id)).run();
      }
    }

    // 2. 身份并集：aliases 并入（from.name 也进），mergedFrom 记审计
    const aliases = new Set(into.aliases);
    for (const alias of from.aliases) aliases.add(alias);
    if (from.name !== into.name) aliases.add(from.name);

    // 3. 质心加权融合（模型不一致则丢弃旧侧）
    let centroid = into.centroid;
    let centroidDocs = into.centroidDocs;
    let centroidModel = into.centroidModel;
    if (from.centroid && from.centroidModel === into.centroidModel && into.centroid) {
      const intoVector = decodeCentroid(into.centroid);
      const fromVector = decodeCentroid(from.centroid);
      const total = into.centroidDocs + from.centroidDocs;
      const weighted = intoVector.map((value, index) => (
        total > 0 ? (value * into.centroidDocs + fromVector[index]! * from.centroidDocs) / total : value
      ));
      centroid = encodeCentroid(blendCentroid(null, weighted));
      centroidDocs = total;
    } else if (!into.centroid && from.centroid) {
      centroid = from.centroid;
      centroidDocs = from.centroidDocs;
      centroidModel = from.centroidModel;
    }

    // 4. 证据分与 sourceCount 都按迁移后的最终链接重算（撞源丢掉的
    //    from 链接权重不带入——分数恒等于 Σ 每源角色权重，与 upsert 的
    //    增量口径一致）
    const aggregates = this.db.select({
      count: sql<number>`count(*)`,
      weightSum: sql<number>`coalesce(sum(case ${entityDocLinks.role}
        when 'primary' then ${EVIDENCE_WEIGHTS.primary}
        when 'manual' then ${EVIDENCE_WEIGHTS.manual}
        else ${EVIDENCE_WEIGHTS.mention} end), 0)`,
    }).from(entityDocLinks)
      .where(eq(entityDocLinks.entityId, into.id)).get();

    this.db.update(entities).set({
      evidenceScore: aggregates?.weightSum ?? into.evidenceScore + from.evidenceScore,
      sourceCount: aggregates?.count ?? into.sourceCount + from.sourceCount,
      aliases: aliases.size > 0 ? [...aliases].slice(0, 20) : null,
      mergedFrom: [...into.mergedFrom, from.id].slice(0, 50),
      centroid,
      centroidDocs,
      centroidModel: centroidModel ?? null,
      updatedAt: now,
    }).where(eq(entities.id, into.id)).run();

    this.db.update(entities).set({ status: "archived", roomId: null, updatedAt: now })
      .where(eq(entities.id, from.id)).run();

    return { into: this.getEntity(into.id), from: this.getEntity(from.id) };
  }

  // ───────────────────────── 晋升（plan §4.4） ─────────────────────────

  /**
   * 推荐态翻转（推荐确认制）：weak → ready。达阈值实体先停在推荐池，
   * 由用户在首页确认后才真正晋升建 Room。幂等：非 weak 态返回 false。
   */
  markReady(entityId: string): boolean {
    const result = this.db.update(entities)
      .set({ status: "ready", updatedAt: new Date() })
      .where(and(eq(entities.id, entityId), eq(entities.status, "weak")))
      .run() as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  /**
   * 原子抢占（步骤 1）：weak/ready → promoting。接受 promoting 重入——失败的
   * 尝试会滞留在 promoting，重试必须能续跑（重复 job 由 worker 的
   * `entity:` 锁 + roomId 预检查挡住，跨重启由 start() 清扫复位）。
   * 用户确认晋升（ready）与提前手动转正（weak）共用此闸。
   */
  claimForPromotion(entityId: string): boolean {
    const result = this.db.update(entities)
      .set({ status: "promoting", updatedAt: new Date() })
      .where(and(
        eq(entities.id, entityId),
        inArray(entities.status, ["weak", "ready", "promoting"]),
      ))
      .run() as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  /** 晋升落定（步骤 4 尾半）：status=room + roomId 回填，先行于批量链接查询（竞态防护）。 */
  promoteToRoom(entityId: string, roomId: string): EntityRow | null {
    this.db.update(entities).set({ status: "room", roomId, updatedAt: new Date() })
      .where(eq(entities.id, entityId)).run();
    return this.getEntity(entityId);
  }

  /** 崩溃恢复清扫（start() 调用）：promoting 滞留 → 回 weak，等下一轮再试。 */
  releaseStuckPromotions(): number {
    const result = this.db.update(entities)
      .set({ status: "weak", updatedAt: new Date() })
      .where(eq(entities.status, "promoting"))
      .run() as { changes: number | bigint };
    return Number(result.changes);
  }

  /** 晋升失败回滚：promoting → weak（rooms 行未插时的唯一善后）。 */
  releasePromotion(entityId: string): void {
    this.db.update(entities).set({ status: "weak", updatedAt: new Date() })
      .where(and(eq(entities.id, entityId), eq(entities.status, "promoting")))
      .run();
  }

  /** 质心推进（③″ 消歧用）：best-effort，失败由调用方吞掉。 */
  advanceEntityCentroid(
    entityId: string,
    vector: number[],
    model: string,
  ): void {
    const current = this.getEntity(entityId);
    if (!current) return;
    const base = current.centroidModel === model && current.centroid
      ? decodeCentroid(current.centroid)
      : null;
    const blended = blendCentroid(base, vector);
    this.db.update(entities).set({
      centroid: encodeCentroid(blended),
      centroidDocs: (current.centroidModel === model ? current.centroidDocs : 0) + 1,
      centroidModel: model,
      updatedAt: new Date(),
    }).where(eq(entities.id, entityId)).run();
  }
}
