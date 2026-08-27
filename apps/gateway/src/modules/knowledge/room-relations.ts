import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorEmails,
  documents,
  entities,
  gatewayMetadata,
  ingestEvents,
  jobs,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  roomRelations,
  rooms,
  roomSourceMemberships,
  routeDecisions,
} from "../../infrastructure/database/schema.js";
import {
  PRIMARY_SALIENCE_MIN,
  scoreEvidence,
  type LinkRole,
  type SourceKind,
} from "./entity-registry.js";
import { normalizeEntityName } from "./entity-index.js";

export const ROOM_RELATION_SCORING_VERSION = 1;
export const ROOM_RELATION_INDEX_JOB_TYPE = "knowledge.relation-index";

export type RoomRelationVisibility = "active" | "hidden" | "all";
export type RoomRelationManualType = "related" | "depends_on" | "part_of" | "supports" | "blocks" | "owns" | "custom";
export type RoomRelationStrength = "weak" | "medium" | "strong";

export interface RelationIndexMentionInput {
  entityId: string;
  salience: number;
  evidence?: string | null;
}

/** 事实记忆投影入参：entityIds 为调用方已解析的实体 id（解析不到的不链接）。 */
export interface RelationIndexFactInput {
  content: string;
  type: "属性" | "关系";
  entityIds: string[];
}

export interface RelationIndexInput {
  sourceKind: SourceKind;
  sourceId: string;
  sourceVersion: number;
  sourceTitle?: string | null;
  roomIds: string[];
  roomRoles?: Record<string, "entry" | "primary" | "mention" | "manual" | "rule">;
  mentions: RelationIndexMentionInput[];
  facts?: RelationIndexFactInput[];
}

/** 事实内容指纹：跨来源聚合去重键（schema.roomEntityFacts.factId 同源）。 */
export function factFingerprint(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 20);
}

export interface RoomRelationReasonDto {
  kind: "shared_source" | "direct_mention" | "shared_entity";
  contribution: number;
  key: string;
  label: string;
  sourceKind?: SourceKind;
  sourceId?: string;
  entityId?: string;
  evidence?: string | null;
}

export interface RoomRelationDto {
  id: string;
  sourceRoomId: string;
  targetRoomId: string;
  directed: boolean;
  type: "shared_evidence" | "shared_entity" | "mixed" | RoomRelationManualType;
  origin: "auto" | "manual" | "hybrid";
  score: number;
  strength: RoomRelationStrength;
  sharedSourceCount: number;
  sharedEntityCount: number;
  directMentionCount: number;
  pinned: boolean;
  hidden: boolean;
  label: string | null;
  note: string | null;
  topReasons: RoomRelationReasonDto[];
  updatedAt: string;
}

export interface RoomGraphDto {
  revision: number;
  generatedAt: string;
  indexing: { status: "ready" | "building" | "degraded"; pendingSources: number };
  nodes: Array<{ id: string; title: string; kind: string; origin: string; updatedAt: string }>;
  edges: RoomRelationDto[];
}

interface RelationAccumulator {
  roomAId: string;
  roomBId: string;
  score: number;
  sharedSourceKeys: Set<string>;
  sharedEntityIds: Set<string>;
  directMentionKeys: Set<string>;
  reasons: RoomRelationReasonDto[];
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function canonicalPair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

function pairKey(left: string, right: string): string {
  const [roomAId, roomBId] = canonicalPair(left, right);
  return `${roomAId}\u0000${roomBId}`;
}

function relationId(left: string, right: string): string {
  return `rel-${createHash("sha256").update(pairKey(left, right)).digest("hex").slice(0, 20)}`;
}

function strengthOf(score: number): RoomRelationStrength {
  return score >= 4 ? "strong" : score >= 2 ? "medium" : "weak";
}

interface RelationEvidenceSnapshot {
  entities?: Array<{ entityId?: unknown; name?: unknown; salience?: unknown; evidence?: unknown }>;
  facts?: Array<{ content?: unknown; type?: unknown; entityIds?: unknown[] }>;
  rooms?: Array<{ roomId?: unknown }>;
  linkOnlyRooms?: unknown[];
}

function asEvidence(value: unknown): RelationEvidenceSnapshot {
  return value && typeof value === "object" ? value as RelationEvidenceSnapshot : {};
}

function manualPresent(row: typeof roomRelations.$inferSelect): boolean {
  return row.manualType !== null || row.pinned;
}

export class RoomRelationRegistry {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly minScore = 1,
  ) {}

  private sourceScore(sourceKind: SourceKind, sourceId: string, role: string, salience = 1) {
    const latestIngest = this.db.select({
      filterStatus: ingestEvents.filterStatus,
      filterVerdict: ingestEvents.filterVerdict,
    }).from(ingestEvents)
      .where(and(eq(ingestEvents.sourceKind, sourceKind), eq(ingestEvents.sourceId, sourceId)))
      .orderBy(desc(ingestEvents.createdAt))
      .get();
    const mail = sourceKind === "mail"
      ? this.db.select({
          threadId: connectorEmails.threadId,
          senderAddress: connectorEmails.senderAddress,
          labels: connectorEmails.labels,
          extensionPayload: connectorEmails.extensionPayload,
        }).from(connectorEmails).where(eq(connectorEmails.id, sourceId)).get() ?? null
      : null;
    const linkRole: LinkRole = role === "manual" ? "manual" : role === "mention" ? "mention" : "primary";
    return scoreEvidence({
      sourceKind,
      sourceId,
      role: linkRole,
      salience,
      decidedBy: role === "manual" ? "user" : "resolution",
      filterStatus: latestIngest?.filterStatus ?? null,
      filterVerdict: latestIngest?.filterVerdict ?? null,
      mail,
    });
  }

  /** Replace one source version atomically. Stale versions are ignored. */
  replaceSource(input: RelationIndexInput): boolean {
    const current = this.db.select({ sourceVersion: roomSourceMemberships.sourceVersion })
      .from(roomSourceMemberships)
      .where(and(eq(roomSourceMemberships.sourceKind, input.sourceKind), eq(roomSourceMemberships.sourceId, input.sourceId)))
      .orderBy(desc(roomSourceMemberships.sourceVersion))
      .get();
    if (current && current.sourceVersion > input.sourceVersion) return false;
    const activeRoomIds = new Set(this.db.select({ id: rooms.id }).from(rooms)
      .where(and(isNull(rooms.deletedAt), eq(rooms.lifecycle, "active"))).all().map((room) => room.id));
    const roomIds = [...new Set(input.roomIds)].filter((roomId) => activeRoomIds.has(roomId));
    const now = new Date();
    this.db.transaction((tx) => {
      tx.delete(roomEntityFacts).where(and(
        eq(roomEntityFacts.sourceKind, input.sourceKind),
        eq(roomEntityFacts.sourceId, input.sourceId),
      )).run();
      tx.delete(roomEntityMentions).where(and(
        eq(roomEntityMentions.sourceKind, input.sourceKind),
        eq(roomEntityMentions.sourceId, input.sourceId),
      )).run();
      tx.delete(roomSourceMemberships).where(and(
        eq(roomSourceMemberships.sourceKind, input.sourceKind),
        eq(roomSourceMemberships.sourceId, input.sourceId),
      )).run();
      for (const roomId of roomIds) {
        const role = input.roomRoles?.[roomId] ?? "primary";
        const sourceScore = this.sourceScore(input.sourceKind, input.sourceId, role, 1);
        tx.insert(roomSourceMemberships).values({
          id: randomUUID(),
          roomId,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          sourceTitle: input.sourceTitle?.trim().slice(0, 500) || null,
          evidenceGroupKey: sourceScore.evidenceGroupKey,
          role,
          effectiveWeight: sourceScore.effectiveWeight,
          qualityLevel: sourceScore.qualityLevel,
          trusted: sourceScore.trusted,
          scoreReasons: sourceScore.scoreReasons.length ? sourceScore.scoreReasons : null,
          scoringVersion: ROOM_RELATION_SCORING_VERSION,
          entityIndexed: true,
          createdAt: now,
          updatedAt: now,
        }).run();
        for (const mention of input.mentions) {
          const relevanceFactor = mention.salience >= PRIMARY_SALIENCE_MIN ? 1 : mention.salience >= 0.35 ? 0.5 : 0;
          if (relevanceFactor === 0 || !sourceScore.trusted) continue;
          tx.insert(roomEntityMentions).values({
            id: randomUUID(),
            roomId,
            entityId: mention.entityId,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
            evidenceGroupKey: sourceScore.evidenceGroupKey,
            salience: mention.salience,
            relevanceFactor,
            qualityLevel: sourceScore.qualityLevel,
            trusted: sourceScore.trusted,
            evidence: mention.evidence?.trim().slice(0, 500) || null,
            createdAt: now,
            updatedAt: now,
          }).run();
        }
        // 事实投影与 mentions 同闸：来源级整体替换，trusted 门槛一致（PRD：记忆只读展示）；
        // 同内容去重防唯一索引 (roomId, sourceKind, sourceId, factId) 冲突。
        const seenFactContents = new Set<string>();
        for (const fact of input.facts ?? []) {
          const content = fact.content.trim().slice(0, 300);
          if (!content || !sourceScore.trusted || seenFactContents.has(content)) continue;
          seenFactContents.add(content);
          const entityIds = [...new Set(fact.entityIds.filter((entityId) => typeof entityId === "string"))].slice(0, 8);
          tx.insert(roomEntityFacts).values({
            id: randomUUID(),
            roomId,
            factId: factFingerprint(content),
            content,
            type: fact.type === "关系" ? "关系" : "属性",
            entityIds,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
            evidenceGroupKey: sourceScore.evidenceGroupKey,
            createdAt: now,
            updatedAt: now,
          }).run();
        }
      }
    });
    this.recomputeAll();
    return true;
  }

  removeSource(sourceKind: SourceKind, sourceId: string): void {
    this.db.transaction((tx) => {
      tx.delete(roomEntityFacts).where(and(eq(roomEntityFacts.sourceKind, sourceKind), eq(roomEntityFacts.sourceId, sourceId))).run();
      tx.delete(roomEntityMentions).where(and(eq(roomEntityMentions.sourceKind, sourceKind), eq(roomEntityMentions.sourceId, sourceId))).run();
      tx.delete(roomSourceMemberships).where(and(eq(roomSourceMemberships.sourceKind, sourceKind), eq(roomSourceMemberships.sourceId, sourceId))).run();
    });
    this.recomputeAll();
  }

  /** Backfill durable projections without importing the old heuristic graph. */
  rebuildFromFacts(): { memberships: number; mentions: number; pendingDocuments: number } {
    const activeRooms = new Set(this.db.select({ id: rooms.id }).from(rooms)
      .where(and(isNull(rooms.deletedAt), eq(rooms.lifecycle, "active"))).all().map((room) => room.id));
    const documentRows = this.db.select({ document: documents, roomId: roomDocumentLinks.roomId })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(documents.id, roomDocumentLinks.documentId))
      .where(isNull(documents.deletedAt))
      .all();
    for (const { document, roomId } of documentRows) {
      if (!activeRooms.has(roomId)) continue;
      this.upsertMembership({
        roomId,
        sourceKind: "everroom-doc",
        sourceId: document.id,
        sourceVersion: document.version,
        sourceTitle: document.title,
        role: "entry",
      });
    }

    const latest = new Map<string, typeof routeDecisions.$inferSelect>();
    for (const decision of this.db.select().from(routeDecisions).orderBy(desc(routeDecisions.createdAt)).all()) {
      const key = `${decision.sourceKind}:${decision.sourceId}`;
      if (!latest.has(key) && decision.status !== "reverted") latest.set(key, decision);
    }
    for (const decision of latest.values()) {
      const evidence = asEvidence(decision.evidence);
      const roomIds = new Set<string>();
      if (decision.primaryRoomId) roomIds.add(decision.primaryRoomId);
      for (const roomId of decision.linkedRoomIds ?? []) roomIds.add(roomId);
      for (const entry of evidence.rooms ?? []) if (typeof entry.roomId === "string") roomIds.add(entry.roomId);
      for (const roomId of evidence.linkOnlyRooms ?? []) if (typeof roomId === "string") roomIds.add(roomId);
      for (const roomId of roomIds) {
        if (!activeRooms.has(roomId)) continue;
        const role = decision.decidedBy === "entry" ? "entry" : decision.decidedBy === "rule" ? "rule" : decision.decidedBy === "user" ? "manual" : "primary";
        this.upsertMembership({
          roomId,
          sourceKind: decision.sourceKind,
          sourceId: decision.sourceId,
          sourceVersion: decision.sourceVersion,
          sourceTitle: decision.sourceTitle,
          role,
          entityIndexed: Boolean(evidence.entities?.length),
        });
        for (const entity of evidence.entities ?? []) {
          if (typeof entity.entityId !== "string") continue;
          this.upsertMention({
            roomId,
            entityId: entity.entityId,
            sourceKind: decision.sourceKind,
            sourceId: decision.sourceId,
            sourceVersion: decision.sourceVersion,
            salience: typeof entity.salience === "number" ? entity.salience : 0.5,
            evidence: typeof entity.evidence === "string" ? entity.evidence : null,
          });
        }
        for (const fact of evidence.facts ?? []) {
          if (typeof fact.content !== "string" || !fact.content.trim()) continue;
          this.upsertFact({
            roomId,
            fact: {
              content: fact.content,
              type: fact.type === "关系" ? "关系" : "属性",
              entityIds: (fact.entityIds ?? []).flatMap((entityId) => typeof entityId === "string" ? [entityId] : []),
            },
            sourceKind: decision.sourceKind,
            sourceId: decision.sourceId,
            sourceVersion: decision.sourceVersion,
          });
        }
      }
    }

    const membershipKeys = new Map(this.db.select().from(roomSourceMemberships).all().map((row) => [
      `${row.roomId}\u0000${row.sourceKind}\u0000${row.sourceId}`,
      row.sourceVersion,
    ]));
    for (const mention of this.db.select().from(roomEntityMentions).all()) {
      const version = membershipKeys.get(`${mention.roomId}\u0000${mention.sourceKind}\u0000${mention.sourceId}`);
      if (version === undefined || version !== mention.sourceVersion) {
        this.db.delete(roomEntityMentions).where(eq(roomEntityMentions.id, mention.id)).run();
      }
    }
    for (const factRow of this.db.select({
      id: roomEntityFacts.id, roomId: roomEntityFacts.roomId, sourceKind: roomEntityFacts.sourceKind,
      sourceId: roomEntityFacts.sourceId, sourceVersion: roomEntityFacts.sourceVersion,
    }).from(roomEntityFacts).all()) {
      const version = membershipKeys.get(`${factRow.roomId}\u0000${factRow.sourceKind}\u0000${factRow.sourceId}`);
      if (version === undefined || version !== factRow.sourceVersion) {
        this.db.delete(roomEntityFacts).where(eq(roomEntityFacts.id, factRow.id)).run();
      }
    }
    this.recomputeAll();
    const pendingDocuments = documentRows.filter(({ document, roomId }) => activeRooms.has(roomId)
      && !this.db.select({ id: roomEntityMentions.id }).from(roomEntityMentions)
        .where(and(eq(roomEntityMentions.roomId, roomId), eq(roomEntityMentions.sourceKind, "everroom-doc"), eq(roomEntityMentions.sourceId, document.id), eq(roomEntityMentions.sourceVersion, document.version))).get()).length;
    return {
      memberships: this.db.select({ id: roomSourceMemberships.id }).from(roomSourceMemberships).all().length,
      mentions: this.db.select({ id: roomEntityMentions.id }).from(roomEntityMentions).all().length,
      pendingDocuments,
    };
  }

  private upsertMembership(input: {
    roomId: string;
    sourceKind: SourceKind;
    sourceId: string;
    sourceVersion: number;
    sourceTitle?: string | null;
    role: "entry" | "primary" | "mention" | "manual" | "rule";
    entityIndexed?: boolean;
  }): void {
    const score = this.sourceScore(input.sourceKind, input.sourceId, input.role, 1);
    const values = {
      sourceVersion: input.sourceVersion,
      sourceTitle: input.sourceTitle?.trim().slice(0, 500) || null,
      evidenceGroupKey: score.evidenceGroupKey,
      role: input.role,
      effectiveWeight: score.effectiveWeight,
      qualityLevel: score.qualityLevel,
      trusted: score.trusted,
      scoreReasons: score.scoreReasons.length ? score.scoreReasons : null,
      scoringVersion: ROOM_RELATION_SCORING_VERSION,
      ...(input.entityIndexed !== undefined ? { entityIndexed: input.entityIndexed } : {}),
      updatedAt: new Date(),
    };
    this.db.insert(roomSourceMemberships).values({ id: randomUUID(), roomId: input.roomId, sourceKind: input.sourceKind, sourceId: input.sourceId, ...values })
      .onConflictDoUpdate({ target: [roomSourceMemberships.roomId, roomSourceMemberships.sourceKind, roomSourceMemberships.sourceId], set: values }).run();
  }

  /** 回收站文档 id 集合：抽取管线的补建/回填路径据此跳过软删除来源。 */
  private trashedDocumentIds(): Set<string> {
    return new Set(this.db.select({ id: documents.id }).from(documents)
      .where(isNotNull(documents.deletedAt)).all().map((row) => row.id));
  }

  pendingDocumentIndexes(): Array<{ sourceId: string; sourceVersion: number; roomIds: string[] }> {
    // 回收站文档不再补建索引：软删除后投影读侧已剔除，这里跳过可避免
    // 启动回填给已删文档重跑抽取（白烧 LLM 并复活投影行）。
    const trashedDocumentIds = this.trashedDocumentIds();
    const pending = new Map<string, { sourceId: string; sourceVersion: number; roomIds: string[] }>();
    for (const membership of this.db.select().from(roomSourceMemberships).where(and(
      eq(roomSourceMemberships.sourceKind, "everroom-doc"),
      eq(roomSourceMemberships.entityIndexed, false),
    )).all()) {
      if (trashedDocumentIds.has(membership.sourceId)) continue;
      const current = pending.get(membership.sourceId) ?? {
        sourceId: membership.sourceId,
        sourceVersion: membership.sourceVersion,
        roomIds: [],
      };
      current.sourceVersion = Math.max(current.sourceVersion, membership.sourceVersion);
      if (!current.roomIds.includes(membership.roomId)) current.roomIds.push(membership.roomId);
      pending.set(membership.sourceId, current);
    }
    return [...pending.values()];
  }

  /** 事实记忆存量回填：已建成员关系但事实表无对应行的来源（一次性，完成后记标记，
   * 无 LLM 时不标记——下次配置了 LLM 的启动仍会补抽）。 */
  pendingFactBackfill(): Array<{ sourceKind: SourceKind; sourceId: string; sourceVersion: number; roomIds: string[] }> {
    if (this.db.select({ value: gatewayMetadata.value }).from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, "room-facts:backfill-completed")).get()) return [];
    const factKeys = new Set(this.db.select({
      roomId: roomEntityFacts.roomId, sourceKind: roomEntityFacts.sourceKind, sourceId: roomEntityFacts.sourceId,
    }).from(roomEntityFacts).all().map((row) => `${row.roomId}\u0000${row.sourceKind}\u0000${row.sourceId}`));
    const pending = new Map<string, { sourceKind: SourceKind; sourceId: string; sourceVersion: number; roomIds: string[] }>();
    const trashedDocumentIds = this.trashedDocumentIds();
    for (const membership of this.db.select().from(roomSourceMemberships).all()) {
      if (!membership.trusted) continue;
      if (membership.sourceKind === "everroom-doc" && trashedDocumentIds.has(membership.sourceId)) continue;
      if (factKeys.has(`${membership.roomId}\u0000${membership.sourceKind}\u0000${membership.sourceId}`)) continue;
      const key = `${membership.sourceKind}\u0000${membership.sourceId}`;
      const current = pending.get(key) ?? {
        sourceKind: membership.sourceKind,
        sourceId: membership.sourceId,
        sourceVersion: membership.sourceVersion,
        roomIds: [],
      };
      current.sourceVersion = Math.max(current.sourceVersion, membership.sourceVersion);
      if (!current.roomIds.includes(membership.roomId)) current.roomIds.push(membership.roomId);
      pending.set(key, current);
    }
    return [...pending.values()];
  }

  markFactBackfillCompleted(): void {
    this.setMetadata("room-facts:backfill-completed", new Date().toISOString());
  }

  private upsertMention(input: {
    roomId: string;
    entityId: string;
    sourceKind: SourceKind;
    sourceId: string;
    sourceVersion: number;
    salience: number;
    evidence: string | null;
  }): void {
    const membership = this.db.select().from(roomSourceMemberships).where(and(
      eq(roomSourceMemberships.roomId, input.roomId),
      eq(roomSourceMemberships.sourceKind, input.sourceKind),
      eq(roomSourceMemberships.sourceId, input.sourceId),
    )).get();
    if (!membership?.trusted) return;
    const relevanceFactor = input.salience >= PRIMARY_SALIENCE_MIN ? 1 : input.salience >= 0.35 ? 0.5 : 0;
    if (relevanceFactor === 0) return;
    const values = {
      sourceVersion: input.sourceVersion,
      evidenceGroupKey: membership.evidenceGroupKey,
      salience: input.salience,
      relevanceFactor,
      qualityLevel: membership.qualityLevel,
      trusted: membership.trusted,
      evidence: input.evidence?.trim().slice(0, 500) || null,
      updatedAt: new Date(),
    };
    this.db.insert(roomEntityMentions).values({
      id: randomUUID(), roomId: input.roomId, entityId: input.entityId,
      sourceKind: input.sourceKind, sourceId: input.sourceId, ...values,
    }).onConflictDoUpdate({
      target: [roomEntityMentions.roomId, roomEntityMentions.entityId, roomEntityMentions.sourceKind, roomEntityMentions.sourceId],
      set: values,
    }).run();
  }

  private upsertFact(input: {
    roomId: string;
    fact: RelationIndexFactInput;
    sourceKind: SourceKind;
    sourceId: string;
    sourceVersion: number;
  }): void {
    const membership = this.db.select().from(roomSourceMemberships).where(and(
      eq(roomSourceMemberships.roomId, input.roomId),
      eq(roomSourceMemberships.sourceKind, input.sourceKind),
      eq(roomSourceMemberships.sourceId, input.sourceId),
    )).get();
    if (!membership?.trusted) return;
    const content = input.fact.content.trim().slice(0, 300);
    if (!content) return;
    const values = {
      factId: factFingerprint(content),
      content,
      type: (input.fact.type === "关系" ? "关系" : "属性") as "属性" | "关系",
      entityIds: [...new Set(input.fact.entityIds)].slice(0, 8),
      sourceVersion: input.sourceVersion,
      evidenceGroupKey: membership.evidenceGroupKey,
      updatedAt: new Date(),
    };
    this.db.insert(roomEntityFacts).values({
      id: randomUUID(), roomId: input.roomId,
      sourceKind: input.sourceKind, sourceId: input.sourceId, ...values,
    }).onConflictDoUpdate({
      target: [roomEntityFacts.roomId, roomEntityFacts.sourceKind, roomEntityFacts.sourceId, roomEntityFacts.factId],
      set: values,
    }).run();
  }

  recomputeAll(): number {
    const roomRows = this.db.select().from(rooms)
      .where(and(isNull(rooms.deletedAt), eq(rooms.lifecycle, "active"))).all();
    const activeIds = new Set(roomRows.map((room) => room.id));
    const homeRoomByEntity = new Map(roomRows.flatMap((room) => room.entityId ? [[room.entityId, room.id] as const] : []));
    const accumulators = new Map<string, RelationAccumulator>();
    const accumulator = (left: string, right: string) => {
      const key = pairKey(left, right);
      let value = accumulators.get(key);
      if (!value) {
        const [roomAId, roomBId] = canonicalPair(left, right);
        value = { roomAId, roomBId, score: 0, sharedSourceKeys: new Set(), sharedEntityIds: new Set(), directMentionKeys: new Set(), reasons: [] };
        accumulators.set(key, value);
      }
      return value;
    };

    const membershipsByGroup = new Map<string, Array<typeof roomSourceMemberships.$inferSelect>>();
    for (const membership of this.db.select().from(roomSourceMemberships).all()) {
      if (!membership.trusted || membership.effectiveWeight <= 0 || !activeIds.has(membership.roomId)) continue;
      const group = membershipsByGroup.get(membership.evidenceGroupKey) ?? [];
      group.push(membership);
      membershipsByGroup.set(membership.evidenceGroupKey, group);
    }
    for (const [groupKey, group] of membershipsByGroup) {
      const bestByRoom = new Map<string, typeof roomSourceMemberships.$inferSelect>();
      for (const membership of group) {
        const existing = bestByRoom.get(membership.roomId);
        if (!existing || membership.effectiveWeight > existing.effectiveWeight) bestByRoom.set(membership.roomId, membership);
      }
      const values = [...bestByRoom.values()];
      for (let left = 0; left < values.length; left += 1) for (let right = left + 1; right < values.length; right += 1) {
        const a = values[left]!;
        const b = values[right]!;
        if (a.roomId === b.roomId) continue;
        const contribution = roundScore(Math.min(a.effectiveWeight, b.effectiveWeight));
        if (contribution <= 0) continue;
        const relation = accumulator(a.roomId, b.roomId);
        relation.score += contribution;
        relation.sharedSourceKeys.add(groupKey);
        relation.reasons.push({
          kind: "shared_source", contribution, key: groupKey,
          label: a.sourceTitle || b.sourceTitle || `${a.sourceKind}:${a.sourceId}`,
          sourceKind: a.sourceKind, sourceId: a.sourceId,
        });
      }
    }

    const trustedMentions = this.db.select().from(roomEntityMentions).where(eq(roomEntityMentions.trusted, true)).all()
      .filter((mention) => activeIds.has(mention.roomId));
    for (const mention of trustedMentions) {
      const otherRoomId = homeRoomByEntity.get(mention.entityId);
      if (!otherRoomId || otherRoomId === mention.roomId || mention.salience < PRIMARY_SALIENCE_MIN) continue;
      const relation = accumulator(mention.roomId, otherRoomId);
      const key = `${mention.evidenceGroupKey}:${mention.entityId}`;
      if (relation.directMentionKeys.has(key)) continue;
      relation.directMentionKeys.add(key);
      relation.score += 1.25;
      const entity = this.db.select({ name: entities.name }).from(entities).where(eq(entities.id, mention.entityId)).get();
      relation.reasons.push({
        kind: "direct_mention", contribution: 1.25, key,
        label: entity?.name ?? mention.entityId,
        entityId: mention.entityId,
        sourceKind: mention.sourceKind,
        sourceId: mention.sourceId,
        evidence: mention.evidence,
      });
    }

    const mentionsByEntity = new Map<string, typeof trustedMentions>();
    for (const mention of trustedMentions) {
      const group = mentionsByEntity.get(mention.entityId) ?? [];
      group.push(mention);
      mentionsByEntity.set(mention.entityId, group);
    }
    for (const [entityId, mentionRows] of mentionsByEntity) {
      const byRoom = new Map<string, Map<string, number>>();
      for (const mention of mentionRows) {
        const groups = byRoom.get(mention.roomId) ?? new Map<string, number>();
        groups.set(mention.evidenceGroupKey, Math.max(groups.get(mention.evidenceGroupKey) ?? 0, mention.relevanceFactor));
        byRoom.set(mention.roomId, groups);
      }
      const roomIds = [...byRoom.keys()];
      for (let left = 0; left < roomIds.length; left += 1) for (let right = left + 1; right < roomIds.length; right += 1) {
        const roomAId = roomIds[left]!;
        const roomBId = roomIds[right]!;
        if (homeRoomByEntity.get(entityId) === roomAId || homeRoomByEntity.get(entityId) === roomBId) continue;
        const groupsA = byRoom.get(roomAId)!;
        const groupsB = byRoom.get(roomBId)!;
        const supports: number[] = [];
        for (const [groupA, relevanceA] of groupsA) for (const [groupB, relevanceB] of groupsB) {
          if (groupA === groupB) continue;
          supports.push(0.5 * Math.min(relevanceA, relevanceB));
        }
        if (!supports.length) continue;
        const contribution = roundScore(Math.min(1, supports.sort((a, b) => b - a).slice(0, 2).reduce((sum, value) => sum + value, 0)));
        if (contribution <= 0) continue;
        const relation = accumulator(roomAId, roomBId);
        relation.score += contribution;
        relation.sharedEntityIds.add(entityId);
        const entity = this.db.select({ name: entities.name }).from(entities).where(eq(entities.id, entityId)).get();
        relation.reasons.push({ kind: "shared_entity", contribution, key: entityId, label: entity?.name ?? entityId, entityId });
      }
    }

    const existing = new Map(this.db.select().from(roomRelations).all().map((relation) => [pairKey(relation.roomAId, relation.roomBId), relation]));
    const now = new Date();
    for (const [key, relation] of accumulators) {
      relation.score = roundScore(relation.score);
      const current = existing.get(key);
      const sourceCount = relation.sharedSourceKeys.size;
      const entityCount = relation.sharedEntityIds.size;
      const directCount = relation.directMentionKeys.size;
      const autoType = sourceCount > 0 && (entityCount > 0 || directCount > 0)
        ? "mixed" as const
        : sourceCount > 0 ? "shared_evidence" as const : "shared_entity" as const;
      const values = {
        autoScore: relation.score,
        autoType,
        strength: relation.score >= this.minScore ? strengthOf(relation.score) : null,
        sharedSourceCount: sourceCount,
        sharedEntityCount: entityCount,
        directMentionCount: directCount,
        topReasons: relation.reasons.sort((a, b) => b.contribution - a.contribution)
          .map((reason) => ({ ...reason }) as Record<string, unknown>),
        scoringVersion: ROOM_RELATION_SCORING_VERSION,
        updatedAt: now,
      };
      if (current) this.db.update(roomRelations).set(values).where(eq(roomRelations.id, current.id)).run();
      else this.db.insert(roomRelations).values({
        id: relationId(relation.roomAId, relation.roomBId),
        roomAId: relation.roomAId,
        roomBId: relation.roomBId,
        ...values,
      }).run();
      existing.delete(key);
    }
    for (const current of existing.values()) {
      if (manualPresent(current) || current.hidden) {
        this.db.update(roomRelations).set({
          autoScore: 0, autoType: null, strength: current.pinned || current.manualType ? "weak" : null,
          sharedSourceCount: 0, sharedEntityCount: 0, directMentionCount: 0,
          topReasons: null, scoringVersion: ROOM_RELATION_SCORING_VERSION, updatedAt: now,
        }).where(eq(roomRelations.id, current.id)).run();
      } else this.db.delete(roomRelations).where(eq(roomRelations.id, current.id)).run();
    }
    const revision = this.revision() + 1;
    this.setMetadata("room-relations:revision", String(revision));
    this.setMetadata("room-relations:index-status", "ready");
    return revision;
  }

  private setMetadata(key: string, value: string): void {
    this.db.insert(gatewayMetadata).values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: gatewayMetadata.key, set: { value, updatedAt: new Date() } }).run();
  }

  revision(): number {
    const value = this.db.select({ value: gatewayMetadata.value }).from(gatewayMetadata).where(eq(gatewayMetadata.key, "room-relations:revision")).get()?.value;
    return Number.parseInt(value ?? "0", 10) || 0;
  }

  markIndexing(status: "ready" | "building" | "degraded"): void {
    this.setMetadata("room-relations:index-status", status);
  }

  graph(visibility: RoomRelationVisibility = "active"): RoomGraphDto {
    const roomRows = this.db.select().from(rooms)
      .where(and(isNull(rooms.deletedAt), eq(rooms.lifecycle, "active"))).all();
    const roomIds = new Set(roomRows.map((room) => room.id));
    const pendingSources = this.db.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.type, ROOM_RELATION_INDEX_JOB_TYPE), inArray(jobs.status, ["pending", "running"]))).all().length;
    const statusValue = this.db.select({ value: gatewayMetadata.value }).from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, "room-relations:index-status")).get()?.value;
    const status = pendingSources > 0 ? "building" : statusValue === "degraded" ? "degraded" : "ready";
    return {
      revision: this.revision(),
      generatedAt: new Date().toISOString(),
      indexing: { status, pendingSources },
      nodes: roomRows.map((room) => ({ id: room.id, title: room.title, kind: room.kind, origin: room.origin, updatedAt: room.updatedAt.toISOString() })),
      edges: this.db.select().from(roomRelations).all()
        .filter((relation) => roomIds.has(relation.roomAId) && roomIds.has(relation.roomBId))
        .filter((relation) => visibility === "all" || (visibility === "hidden" ? relation.hidden : !relation.hidden))
        .filter((relation) => relation.autoScore >= this.minScore || manualPresent(relation))
        .map((relation) => this.toDto(relation)),
    };
  }

  relationsOfRoom(roomId: string, visibility: RoomRelationVisibility = "active"): RoomGraphDto | null {
    const graph = this.graph(visibility);
    const center = graph.nodes.find((room) => room.id === roomId);
    if (!center) return null;
    const edges = graph.edges.filter((edge) => edge.sourceRoomId === roomId || edge.targetRoomId === roomId);
    const relatedIds = new Set([roomId, ...edges.flatMap((edge) => [edge.sourceRoomId, edge.targetRoomId])]);
    return { ...graph, nodes: graph.nodes.filter((room) => relatedIds.has(room.id)), edges };
  }

  relationEvidence(id: string, offset = 0, limit = 50): { items: RoomRelationReasonDto[]; total: number } | null {
    const relation = this.db.select().from(roomRelations).where(eq(roomRelations.id, id)).get();
    if (!relation) return null;
    const reasons = (relation.topReasons ?? []) as unknown as RoomRelationReasonDto[];
    return { items: reasons.slice(offset, offset + limit), total: reasons.length };
  }

  createManual(input: {
    fromRoomId: string;
    toRoomId: string;
    type: RoomRelationManualType;
    directed?: boolean;
    label?: string | null;
    note?: string | null;
  }): RoomRelationDto | null {
    if (input.fromRoomId === input.toRoomId) return null;
    const found = this.db.select({ id: rooms.id }).from(rooms)
      .where(and(
        inArray(rooms.id, [input.fromRoomId, input.toRoomId]),
        isNull(rooms.deletedAt),
        eq(rooms.lifecycle, "active"),
      )).all();
    if (found.length !== 2) return null;
    const [roomAId, roomBId] = canonicalPair(input.fromRoomId, input.toRoomId);
    const id = relationId(roomAId, roomBId);
    const existing = this.db.select().from(roomRelations).where(and(
      eq(roomRelations.roomAId, roomAId),
      eq(roomRelations.roomBId, roomBId),
    )).get();
    const now = new Date();
    const values = {
      pinned: true,
      hidden: false,
      manualType: input.type,
      manualFromRoomId: input.directed ? input.fromRoomId : null,
      manualToRoomId: input.directed ? input.toRoomId : null,
      manualLabel: input.label?.trim().slice(0, 120) || null,
      manualNote: input.note?.trim().slice(0, 1_000) || null,
      strength: existing?.autoScore && existing.autoScore >= this.minScore
        ? strengthOf(existing.autoScore)
        : "weak" as const,
      updatedAt: now,
    };
    this.db.insert(roomRelations).values({ id, roomAId, roomBId, ...values })
      .onConflictDoUpdate({ target: [roomRelations.roomAId, roomRelations.roomBId], set: values }).run();
    this.setMetadata("room-relations:revision", String(this.revision() + 1));
    return this.getRelation(id);
  }

  updateManual(id: string, input: Partial<{
    type: RoomRelationManualType;
    directed: boolean;
    fromRoomId: string;
    toRoomId: string;
    label: string | null;
    note: string | null;
    pinned: boolean;
    hidden: boolean;
  }>): RoomRelationDto | null {
    const current = this.db.select().from(roomRelations).where(eq(roomRelations.id, id)).get();
    if (!current) return null;
    const fromRoomId = input.fromRoomId ?? current.manualFromRoomId ?? current.roomAId;
    const toRoomId = input.toRoomId ?? current.manualToRoomId ?? current.roomBId;
    this.db.update(roomRelations).set({
      ...(input.type !== undefined ? { manualType: input.type } : {}),
      ...(input.directed !== undefined ? {
        manualFromRoomId: input.directed ? fromRoomId : null,
        manualToRoomId: input.directed ? toRoomId : null,
      } : {}),
      ...(input.label !== undefined ? { manualLabel: input.label?.trim().slice(0, 120) || null } : {}),
      ...(input.note !== undefined ? { manualNote: input.note?.trim().slice(0, 1_000) || null } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      updatedAt: new Date(),
    }).where(eq(roomRelations.id, id)).run();
    this.setMetadata("room-relations:revision", String(this.revision() + 1));
    return this.getRelation(id);
  }

  removeManual(id: string): RoomRelationDto | null | undefined {
    const current = this.db.select().from(roomRelations).where(eq(roomRelations.id, id)).get();
    if (!current) return undefined;
    if (current.autoScore < this.minScore) {
      this.db.delete(roomRelations).where(eq(roomRelations.id, id)).run();
      this.setMetadata("room-relations:revision", String(this.revision() + 1));
      return null;
    }
    this.db.update(roomRelations).set({
      pinned: false, hidden: false, manualType: null, manualFromRoomId: null,
      manualToRoomId: null, manualLabel: null, manualNote: null,
      strength: strengthOf(current.autoScore), updatedAt: new Date(),
    }).where(eq(roomRelations.id, id)).run();
    this.setMetadata("room-relations:revision", String(this.revision() + 1));
    return this.getRelation(id);
  }

  rewriteEntity(fromId: string, intoId: string): void {
    const rows = this.db.select().from(roomEntityMentions).where(eq(roomEntityMentions.entityId, fromId)).all();
    for (const row of rows) {
      const clash = this.db.select().from(roomEntityMentions).where(and(
        eq(roomEntityMentions.roomId, row.roomId), eq(roomEntityMentions.entityId, intoId),
        eq(roomEntityMentions.sourceKind, row.sourceKind), eq(roomEntityMentions.sourceId, row.sourceId),
      )).get();
      if (clash) this.db.delete(roomEntityMentions).where(eq(roomEntityMentions.id, row.id)).run();
      else this.db.update(roomEntityMentions).set({ entityId: intoId, updatedAt: new Date() }).where(eq(roomEntityMentions.id, row.id)).run();
    }
    // 事实引用的实体 id 同步改写（实体合并后不留悬挂引用）
    const factRows = this.db.select({ id: roomEntityFacts.id, entityIds: roomEntityFacts.entityIds })
      .from(roomEntityFacts).all()
      .filter((row) => (row.entityIds ?? []).includes(fromId));
    for (const row of factRows) {
      const entityIds = [...new Set((row.entityIds ?? []).map((entityId) => entityId === fromId ? intoId : entityId))];
      this.db.update(roomEntityFacts).set({ entityIds, updatedAt: new Date() }).where(eq(roomEntityFacts.id, row.id)).run();
    }
    this.recomputeAll();
  }

  resolveMentionEntity(name: string, kind: string): string {
    const normalized = normalizeEntityName(name);
    const existing = this.db.select().from(entities).all().find((entity) =>
      entity.kind === kind && [entity.name, ...(entity.aliases ?? [])].some((value) => normalizeEntityName(value) === normalized));
    if (existing) return existing.id;
    const id = `ent-relation-${createHash("sha256").update(`${kind}\u0000${normalized}`).digest("hex").slice(0, 16)}`;
    this.db.insert(entities).values({ id, name: name.trim().slice(0, 120), kind: kind as typeof entities.kind.enumValues[number], status: "weak" })
      .onConflictDoNothing().run();
    return id;
  }

  private getRelation(id: string): RoomRelationDto | null {
    const relation = this.db.select().from(roomRelations).where(eq(roomRelations.id, id)).get();
    return relation ? this.toDto(relation) : null;
  }

  private toDto(relation: typeof roomRelations.$inferSelect): RoomRelationDto {
    const directed = Boolean(relation.manualFromRoomId && relation.manualToRoomId);
    const automatic = relation.autoScore >= this.minScore;
    const manual = manualPresent(relation);
    return {
      id: relation.id,
      sourceRoomId: directed ? relation.manualFromRoomId! : relation.roomAId,
      targetRoomId: directed ? relation.manualToRoomId! : relation.roomBId,
      directed,
      type: relation.manualType ?? relation.autoType ?? "shared_entity",
      origin: automatic && manual ? "hybrid" : manual ? "manual" : "auto",
      score: relation.autoScore,
      strength: relation.strength ?? strengthOf(relation.autoScore),
      sharedSourceCount: relation.sharedSourceCount,
      sharedEntityCount: relation.sharedEntityCount,
      directMentionCount: relation.directMentionCount,
      pinned: relation.pinned,
      hidden: relation.hidden,
      label: relation.manualLabel,
      note: relation.manualNote,
      topReasons: ((relation.topReasons ?? []) as unknown as RoomRelationReasonDto[]).slice(0, 5),
      updatedAt: relation.updatedAt.toISOString(),
    };
  }
}
