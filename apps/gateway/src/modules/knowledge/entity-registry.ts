/**
 * 实体注册表访问层（entity-room-plan §3.1/§4.2/§4.3/§4.4/§4.5）：
 * entities + entity_doc_links 的全部 DB 操作与纯函数。
 *
 * 归属的单一事实源在这里（route_decisions 已降级为审计流水）；
 * 解析的编排（抽取 → 匹配 → 判定）在 router.ts，本层只提供机械。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorEmails,
  entities,
  entityDocLinks,
  ingestEvents,
  rooms,
} from "../../infrastructure/database/schema.js";
import { blendCentroid, decodeCentroid, encodeCentroid } from "./embedding.js";
import { normalizeEntityName } from "./entity-index.js";
import { ENTITY_KINDS, type EntityKind } from "./llm.js";

export type EntityStatus = "weak" | "ready" | "promoting" | "room" | "archived" | "suppressed";
export type LinkRole = "primary" | "mention" | "manual";
export type SourceKind = "everroom-doc" | "reality-event" | "visual-event" | "mail" | "file" | "cloud-doc" | "calendar-event" | "todo" | "connector-record";
export type EvidenceQualityLevel = "excluded" | "uncertain" | "low" | "normal" | "high";
export type ReadinessPath = "standard" | "strong";

export interface PromotionThresholds {
  promoteScore: number;
  promoteSources: number;
}

export const SCORING_VERSION = 2;
export const STRONG_PROMOTE_SCORE = 2.0;
export const STRONG_PROMOTE_SOURCES = 2;
export const PRIMARY_SALIENCE_MIN = 0.65;
export const ELIGIBLE_SALIENCE_MIN = 0.35;

/** 链接角色 → 证据分权重（plan §4.3）。 */
export const EVIDENCE_WEIGHTS: Record<LinkRole, number> = {
  primary: 1.0,
  mention: 0.25,
  manual: 1.5,
};

export const SOURCE_WEIGHTS: Record<SourceKind, number> = {
  "everroom-doc": 1.2,
  file: 1.1,
  "cloud-doc": 1.0,
  "reality-event": 1.0,
  mail: 0.6,
  "calendar-event": 0.5,
  todo: 0.5,
  "visual-event": 0.4,
  "connector-record": 0.4,
};

export function evidenceWeightOf(role: LinkRole): number {
  return EVIDENCE_WEIGHTS[role];
}

export interface EvidenceScoreInput {
  sourceKind: SourceKind;
  sourceId: string;
  role: LinkRole;
  salience: number;
  decidedBy: "resolution" | "user";
  filterStatus?: "pending" | "passed" | "filtered" | "bypassed" | null;
  filterVerdict?: {
    informative: boolean;
    category: string;
    confidence: number;
  } | null;
  mail?: {
    threadId: string | null;
    senderAddress: string | null;
    labels: string[];
    extensionPayload: Record<string, unknown> | null;
  } | null;
}

export interface EvidenceScoreBreakdown {
  evidenceGroupKey: string;
  roleWeight: number;
  sourceWeight: number;
  qualityFactor: number;
  relevanceFactor: number;
  effectiveWeight: number;
  qualityLevel: EvidenceQualityLevel;
  trusted: boolean;
  strong: boolean;
  scoreReasons: string[];
  scoringVersion: number;
}

export interface EntityLinkInput {
  entityId: string;
  sourceKind: SourceKind;
  sourceId: string;
  sourceVersion: number;
  role: LinkRole;
  salience?: number;
  evidence?: string | null;
  decidedBy: "resolution" | "user";
}

const HARD_FILTER_CATEGORIES = new Set(["bot-noise", "trivial", "template", "empty"]);
const AUTOMATED_SENDER = /(?:^|[._+-])(no-?reply|mailer-daemon)(?:@|[._+-])/i;

function mailFlag(payload: Record<string, unknown> | null | undefined, key: string): boolean {
  return payload?.[key] === true;
}

/** V2 单条链接评分。来源元数据在写链接时快照，避免展示与判定漂移。 */
export function scoreEvidence(input: EvidenceScoreInput): EvidenceScoreBreakdown {
  const roleWeight = EVIDENCE_WEIGHTS[input.role];
  const sourceWeight = SOURCE_WEIGHTS[input.sourceKind];
  const relevanceFactor = input.decidedBy === "user" || input.role === "manual"
    ? 1
    : input.salience >= PRIMARY_SALIENCE_MIN
      ? 1
      : input.salience >= ELIGIBLE_SALIENCE_MIN ? 0.5 : 0;
  const scoreReasons: string[] = [];
  let qualityFactor = 1;
  let qualityLevel: EvidenceQualityLevel = "normal";

  if (input.decidedBy === "user" || input.role === "manual") {
    scoreReasons.push("manual-user-intent");
  } else {
    const verdict = input.filterVerdict;
    const highConfidenceNoise = verdict
      && !verdict.informative
      && verdict.confidence >= 0.7
      && HARD_FILTER_CATEGORIES.has(verdict.category);
    if (input.filterStatus === "filtered" || highConfidenceNoise) {
      qualityFactor = 0;
      qualityLevel = "excluded";
      scoreReasons.push(`filter:${verdict?.category ?? "filtered"}`);
    } else if (input.filterStatus === "bypassed" || (verdict && !verdict.informative)) {
      qualityFactor = 0.5;
      qualityLevel = "uncertain";
      scoreReasons.push("filter:uncertain");
    }

    if (input.sourceKind === "mail" && qualityFactor > 0) {
      const mail = input.mail;
      const labels = new Set((mail?.labels ?? []).map((label) => label.toUpperCase()));
      const payload = mail?.extensionPayload;
      if (mailFlag(payload, "isSpam") || mailFlag(payload, "isTrash") || mailFlag(payload, "isDraft")
        || labels.has("SPAM") || labels.has("TRASH") || labels.has("DRAFT")) {
        qualityFactor = 0;
        qualityLevel = "excluded";
        scoreReasons.push("mail:spam-trash-draft");
      } else if (labels.has("CATEGORY_PROMOTIONS") || labels.has("CATEGORY_SOCIAL")
        || AUTOMATED_SENDER.test(mail?.senderAddress ?? "")) {
        qualityFactor = Math.min(qualityFactor, 0.25);
        qualityLevel = "low";
        scoreReasons.push("mail:bulk-or-automated");
      } else if (mailFlag(payload, "isStarred") || labels.has("STARRED") || labels.has("IMPORTANT")) {
        qualityFactor *= 1.25;
        qualityLevel = "high";
        scoreReasons.push("mail:starred-or-important");
      }
    }
  }

  if (relevanceFactor === 0) scoreReasons.push("salience:below-minimum");
  else if (relevanceFactor === 0.5) scoreReasons.push("salience:secondary");
  const effectiveWeight = Math.round(roleWeight * sourceWeight * qualityFactor * relevanceFactor * 10_000) / 10_000;
  const trusted = effectiveWeight > 0
    && relevanceFactor === 1
    && sourceWeight >= SOURCE_WEIGHTS.mail
    && (qualityLevel === "normal" || qualityLevel === "high");
  const strong = trusted
    && (input.role === "primary" || input.role === "manual")
    && effectiveWeight >= 1
    && input.sourceKind !== "mail";
  const evidenceGroupKey = input.sourceKind === "mail" && input.mail?.threadId
    ? `mail-thread:${input.mail.threadId}`
    : `${input.sourceKind}:${input.sourceId}`;

  return {
    evidenceGroupKey,
    roleWeight,
    sourceWeight,
    qualityFactor,
    relevanceFactor,
    effectiveWeight,
    qualityLevel,
    trusted,
    strong,
    scoreReasons,
    scoringVersion: SCORING_VERSION,
  };
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
  eligibleSourceCount: number;
  trustedSourceCount: number;
  strongSourceCount: number;
  readinessPath: ReadinessPath | null;
  scoringVersion: number;
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
  evidenceGroupKey: string;
  roleWeight: number;
  sourceWeight: number;
  qualityFactor: number;
  relevanceFactor: number;
  effectiveWeight: number;
  qualityLevel: EvidenceQualityLevel;
  trusted: boolean;
  strong: boolean;
  scoreReasons: string[];
  scoringVersion: number;
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
    eligibleSourceCount: row.eligibleSourceCount,
    trustedSourceCount: row.trustedSourceCount,
    strongSourceCount: row.strongSourceCount,
    readinessPath: row.readinessPath,
    scoringVersion: row.scoringVersion,
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
    evidenceGroupKey: row.evidenceGroupKey,
    roleWeight: row.roleWeight,
    sourceWeight: row.sourceWeight,
    qualityFactor: row.qualityFactor,
    relevanceFactor: row.relevanceFactor,
    effectiveWeight: row.effectiveWeight,
    qualityLevel: row.qualityLevel,
    trusted: row.trusted,
    strong: row.strong,
    scoreReasons: row.scoreReasons ?? [],
    scoringVersion: row.scoringVersion,
    evidence: row.evidence,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * primary 由网关侧从 salience 推导。最高分至少 0.65 才能成为 primary，
 * 绝对并列允许 2 个；其余 mention。不信任 LLM 的角色标注纪律。
 */
export function derivePrimaryRoles<T extends { name: string; salience: number }>(
  extracted: T[],
): Map<string, LinkRole> {
  const roles = new Map<string, LinkRole>();
  if (extracted.length === 0) return roles;
  let max = -Infinity;
  for (const item of extracted) max = Math.max(max, item.salience);
  for (const item of extracted) roles.set(item.name, "mention");
  if (max < PRIMARY_SALIENCE_MIN) return roles;
  let primarySlots = 0;
  for (const item of extracted) {
    // 浮点容差：与最高分差 <1e-9 视为并列
    const isTop = Math.abs(item.salience - max) < 1e-9;
    if (isTop && primarySlots < 2) {
      roles.set(item.name, "primary");
      primarySlots += 1;
    }
  }
  return roles;
}

export function recommendationPathOf(
  entity: Pick<EntityRow, "evidenceScore" | "sourceCount">
    & Partial<Pick<EntityRow, "eligibleSourceCount" | "trustedSourceCount" | "strongSourceCount">>,
  thresholds: PromotionThresholds,
): ReadinessPath | null {
  const eligible = entity.eligibleSourceCount ?? entity.sourceCount;
  const trusted = entity.trustedSourceCount ?? eligible;
  const strong = entity.strongSourceCount ?? 0;
  if (strong >= STRONG_PROMOTE_SOURCES && entity.evidenceScore >= STRONG_PROMOTE_SCORE) return "strong";
  if (entity.evidenceScore >= thresholds.promoteScore
    && eligible >= thresholds.promoteSources
    && trusted >= 2) return "standard";
  return null;
}

/** V2 晋升阈值判定：标准路径或两份独立强证据路径，且仅 weak 态可晋升。 */
export function meetsPromotionThreshold(
  entity: Pick<EntityRow, "status" | "evidenceScore" | "sourceCount">
    & Partial<Pick<EntityRow, "eligibleSourceCount" | "trustedSourceCount" | "strongSourceCount">>,
  thresholds: PromotionThresholds,
): boolean {
  return entity.status === "weak" && recommendationPathOf(entity, thresholds) !== null;
}

export class EntityRegistry {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly thresholds: PromotionThresholds = { promoteScore: 2.4, promoteSources: 3 },
  ) {}

  // ───────────────────────── 查询 ─────────────────────────

  getEntity(id: string): EntityRow | null {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get();
    return row ? toEntityRow(row) : null;
  }

  listEntities(status?: EntityStatus): EntityRow[] {
    const query = this.db.select().from(entities);
    const rows = status ? query.where(eq(entities.status, status)) : query;
    return (status === "ready"
      ? rows.orderBy(desc(entities.evidenceScore), desc(entities.updatedAt))
      : rows.orderBy(desc(entities.updatedAt)))
      .all()
      .map(toEntityRow);
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
   * 手动建 Room 的实体认领（ED4 户口扩展，enrich 实体回写时调用）：
   * 按归一化名精确匹配现有实体（name/aliases，同 router 精确档；
   * 不要求 kind 一致——身份以名为准），未命中则以给定 kind 新建。
   * 仅认领未绑定的（weak/ready/新建）：已绑定其他 Room 的不抢、
   * 用户搁置（suppressed/archived）与在途晋升（promoting）不动。
   * 认领后实体 status=room + roomId 回填，本 Room 即成为路由目标。
   */
  claimEntitiesForRoom(roomId: string, inputs: Array<{ name: string; kind: string }>): number {
    let claimed = 0;
    const seen = new Set<string>();
    const rows = this.db.select().from(entities).all();
    for (const input of inputs) {
      const normalized = normalizeEntityName(input.name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const existing = rows.find((entity) =>
        [entity.name, ...(entity.aliases ?? [])].some((value) => normalizeEntityName(value) === normalized));
      const target = existing ?? this.createEntity({ name: input.name, kind: input.kind });
      if (!target) continue;
      if (target.roomId) continue; // 已绑定（含本 Room 户口实体）：幂等跳过 / 不抢
      if (target.status !== "weak" && target.status !== "ready") continue;
      if (this.promoteToRoom(target.id, roomId)) claimed += 1;
    }
    return claimed;
  }

  private scoringOf(input: EntityLinkInput): EvidenceScoreBreakdown {
    const latestIngest = this.db.select({
      filterStatus: ingestEvents.filterStatus,
      filterVerdict: ingestEvents.filterVerdict,
    }).from(ingestEvents)
      .where(and(eq(ingestEvents.sourceKind, input.sourceKind), eq(ingestEvents.sourceId, input.sourceId)))
      .orderBy(desc(ingestEvents.createdAt))
      .get();
    const mail = input.sourceKind === "mail"
      ? this.db.select({
          threadId: connectorEmails.threadId,
          senderAddress: connectorEmails.senderAddress,
          labels: connectorEmails.labels,
          extensionPayload: connectorEmails.extensionPayload,
        }).from(connectorEmails).where(eq(connectorEmails.id, input.sourceId)).get() ?? null
      : null;
    return scoreEvidence({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      role: input.role,
      salience: input.salience ?? 0,
      decidedBy: input.decidedBy,
      filterStatus: latestIngest?.filterStatus ?? null,
      filterVerdict: latestIngest?.filterVerdict ?? null,
      mail,
    });
  }

  private linkScoreValues(score: EvidenceScoreBreakdown) {
    return {
      evidenceGroupKey: score.evidenceGroupKey,
      roleWeight: score.roleWeight,
      sourceWeight: score.sourceWeight,
      qualityFactor: score.qualityFactor,
      relevanceFactor: score.relevanceFactor,
      effectiveWeight: score.effectiveWeight,
      qualityLevel: score.qualityLevel,
      trusted: score.trusted,
      strong: score.strong,
      scoreReasons: score.scoreReasons.length > 0 ? score.scoreReasons : null,
      scoringVersion: score.scoringVersion,
    };
  }

  /** 单条手动链接 upsert；自动抽取应使用 replaceResolutionLinks。 */
  upsertLink(input: EntityLinkInput): EntityRow {
    const now = new Date();
    const score = this.scoringOf(input);
    const existing = this.db.select().from(entityDocLinks)
      .where(and(
        eq(entityDocLinks.entityId, input.entityId),
        eq(entityDocLinks.sourceKind, input.sourceKind),
        eq(entityDocLinks.sourceId, input.sourceId),
      ))
      .get();

    if (existing) {
      this.db.update(entityDocLinks).set({
        sourceVersion: input.sourceVersion,
        role: input.role,
        salience: input.salience ?? 0,
        evidence: input.evidence ?? null,
        decidedBy: input.decidedBy,
        ...this.linkScoreValues(score),
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
        ...this.linkScoreValues(score),
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    return this.recomputeEntity(input.entityId, true)!;
  }

  /**
   * 一次抽取结果按来源整体替换。旧版本不再包含的 resolution 链接会删除，
   * user 链接保持不动；链接集合在一个事务里切换，随后统一回算受影响实体。
   */
  replaceResolutionLinks(
    sourceKind: SourceKind,
    sourceId: string,
    inputs: Array<Omit<EntityLinkInput, "sourceKind" | "sourceId" | "decidedBy">>,
  ): EntityRow[] {
    const scored = inputs.map((input) => {
      const full: EntityLinkInput = { ...input, sourceKind, sourceId, decidedBy: "resolution" };
      return { input: full, score: this.scoringOf(full) };
    });
    const existing = this.linksOfSource(sourceKind, sourceId);
    const affected = new Set(existing.map((link) => link.entityId));
    for (const { input } of scored) affected.add(input.entityId);
    const incomingIds = new Set(scored.map(({ input }) => input.entityId));
    const now = new Date();

    this.db.transaction((tx) => {
      for (const { input, score } of scored) {
        const row = tx.select().from(entityDocLinks).where(and(
          eq(entityDocLinks.entityId, input.entityId),
          eq(entityDocLinks.sourceKind, sourceKind),
          eq(entityDocLinks.sourceId, sourceId),
        )).get();
        const values = {
          sourceVersion: input.sourceVersion,
          role: input.role,
          salience: input.salience ?? 0,
          evidence: input.evidence ?? null,
          decidedBy: "resolution" as const,
          ...this.linkScoreValues(score),
          updatedAt: now,
        };
        if (row) tx.update(entityDocLinks).set(values).where(eq(entityDocLinks.id, row.id)).run();
        else tx.insert(entityDocLinks).values({
          id: randomUUID(),
          entityId: input.entityId,
          sourceKind,
          sourceId,
          ...values,
          createdAt: now,
        }).run();
      }
      for (const stale of existing) {
        if (stale.decidedBy === "resolution" && !incomingIds.has(stale.entityId)) {
          tx.delete(entityDocLinks).where(eq(entityDocLinks.id, stale.id)).run();
        }
      }
    });

    for (const entityId of affected) this.recomputeEntity(entityId, incomingIds.has(entityId));
    return inputs.flatMap((input) => {
      const entity = this.getEntity(input.entityId);
      return entity ? [entity] : [];
    });
  }

  /** 来源永久删除：移除包括手动挂载在内的全部链接并同步回扣。 */
  removeSourceLinks(sourceKind: SourceKind, sourceId: string): number {
    const links = this.linksOfSource(sourceKind, sourceId);
    if (links.length === 0) return 0;
    this.db.delete(entityDocLinks)
      .where(and(eq(entityDocLinks.sourceKind, sourceKind), eq(entityDocLinks.sourceId, sourceId)))
      .run();
    for (const entityId of new Set(links.map((link) => link.entityId))) this.recomputeEntity(entityId);
    return links.length;
  }

  /** 按证据组取最高贡献，重算实体分数、计数与 weak/ready 双向状态。 */
  recomputeEntity(entityId: string, reviveArchived = false): EntityRow | null {
    const current = this.getEntity(entityId);
    if (!current) return null;
    const links = this.linksOfEntity(entityId);
    const winners = new Map<string, EntityLinkRow>();
    for (const link of links) {
      const existing = winners.get(link.evidenceGroupKey);
      if (!existing || link.effectiveWeight > existing.effectiveWeight
        || (link.effectiveWeight === existing.effectiveWeight && Number(link.trusted) > Number(existing.trusted))) {
        winners.set(link.evidenceGroupKey, link);
      }
    }
    const grouped = [...winners.values()];
    const evidenceScore = Math.round(grouped.reduce((sum, link) => sum + link.effectiveWeight, 0) * 10_000) / 10_000;
    const eligibleSourceCount = grouped.filter((link) => link.effectiveWeight > 0).length;
    const trustedSourceCount = grouped.filter((link) => link.effectiveWeight > 0 && link.trusted).length;
    const strongSourceCount = grouped.filter((link) => link.effectiveWeight > 0 && link.strong).length;
    const readinessPath = recommendationPathOf({
      evidenceScore,
      sourceCount: links.length,
      eligibleSourceCount,
      trustedSourceCount,
      strongSourceCount,
    }, this.thresholds);
    let status = current.status;
    if (status === "weak" || status === "ready" || (reviveArchived && status === "archived" && links.length > 0)) {
      status = readinessPath ? "ready" : "weak";
    }
    const lastLinkedAt = links.reduce<Date | null>((latest, link) => (
      !latest || link.updatedAt > latest ? link.updatedAt : latest
    ), null);
    const unchanged = current.evidenceScore === evidenceScore
      && current.sourceCount === links.length
      && current.eligibleSourceCount === eligibleSourceCount
      && current.trustedSourceCount === trustedSourceCount
      && current.strongSourceCount === strongSourceCount
      && current.readinessPath === readinessPath
      && current.scoringVersion === SCORING_VERSION
      && current.status === status
      && (current.lastLinkedAt?.getTime() ?? null) === (lastLinkedAt?.getTime() ?? null);
    if (unchanged) return current;
    this.db.update(entities).set({
      evidenceScore,
      sourceCount: links.length,
      eligibleSourceCount,
      trustedSourceCount,
      strongSourceCount,
      readinessPath,
      scoringVersion: SCORING_VERSION,
      lastLinkedAt,
      status,
      updatedAt: new Date(),
    }).where(eq(entities.id, entityId)).run();
    return this.getEntity(entityId);
  }

  /** 启动迁移与规则升级共用：重新快照每条链接并回算全部实体。 */
  rescoreAll(): { links: number; entities: number } {
    const allLinks = this.db.select().from(entityDocLinks).all();
    for (const row of allLinks) {
      const input: EntityLinkInput = {
        entityId: row.entityId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
        role: row.role,
        salience: row.salience,
        evidence: row.evidence,
        decidedBy: row.decidedBy,
      };
      const score = this.scoringOf(input);
      if (row.evidenceGroupKey !== score.evidenceGroupKey
        || row.roleWeight !== score.roleWeight
        || row.sourceWeight !== score.sourceWeight
        || row.qualityFactor !== score.qualityFactor
        || row.relevanceFactor !== score.relevanceFactor
        || row.effectiveWeight !== score.effectiveWeight
        || row.qualityLevel !== score.qualityLevel
        || row.trusted !== score.trusted
        || row.strong !== score.strong
        || row.scoringVersion !== score.scoringVersion
        || JSON.stringify(row.scoreReasons ?? []) !== JSON.stringify(score.scoreReasons)) {
        this.db.update(entityDocLinks).set(this.linkScoreValues(score))
          .where(eq(entityDocLinks.id, row.id)).run();
      }
    }
    const allEntities = this.db.select({ id: entities.id }).from(entities).all();
    for (const entity of allEntities) this.recomputeEntity(entity.id);
    return { links: allLinks.length, entities: allEntities.length };
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
          evidenceGroupKey: link.evidenceGroupKey,
          roleWeight: link.roleWeight,
          sourceWeight: link.sourceWeight,
          qualityFactor: link.qualityFactor,
          relevanceFactor: link.relevanceFactor,
          effectiveWeight: link.effectiveWeight,
          qualityLevel: link.qualityLevel,
          trusted: link.trusted,
          strong: link.strong,
          scoreReasons: link.scoreReasons.length > 0 ? link.scoreReasons : null,
          scoringVersion: link.scoringVersion,
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

    this.db.update(entities).set({
      aliases: aliases.size > 0 ? [...aliases].slice(0, 20) : null,
      mergedFrom: [...into.mergedFrom, from.id].slice(0, 50),
      centroid,
      centroidDocs,
      centroidModel: centroidModel ?? null,
      updatedAt: now,
    }).where(eq(entities.id, into.id)).run();

    this.recomputeEntity(into.id);
    this.db.update(entities).set({
      status: "archived",
      roomId: null,
      evidenceScore: 0,
      sourceCount: 0,
      eligibleSourceCount: 0,
      trustedSourceCount: 0,
      strongSourceCount: 0,
      readinessPath: null,
      lastLinkedAt: null,
      updatedAt: now,
    })
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

  /** 晋升失败回滚：promoting → 原候选态（rooms 行未插时的唯一善后）。 */
  releasePromotion(entityId: string, status: "weak" | "ready" = "weak"): void {
    this.db.update(entities).set({ status, updatedAt: new Date() })
      .where(and(eq(entities.id, entityId), eq(entities.status, "promoting")))
      .run();
  }

  /** 用户暂不创建：保留实体和证据，但从推荐/自动晋升候选中移除。 */
  suppress(entityId: string): EntityRow | null {
    this.db.update(entities).set({ status: "suppressed", roomId: null, updatedAt: new Date() })
      .where(and(eq(entities.id, entityId), inArray(entities.status, ["weak", "ready"]))).run();
    return this.getEntity(entityId);
  }

  restoreSuppressed(entityId: string): EntityRow | null {
    this.db.update(entities).set({ status: "weak", updatedAt: new Date() })
      .where(and(eq(entities.id, entityId), eq(entities.status, "suppressed"))).run();
    return this.recomputeEntity(entityId);
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
