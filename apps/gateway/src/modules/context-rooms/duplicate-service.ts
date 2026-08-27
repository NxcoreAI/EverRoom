import { createHash, randomUUID } from "node:crypto";
import type {
  ContextRoomSnapshotItem,
  RoomDuplicateCandidate,
  RoomDuplicateCandidateStatus,
  RoomDuplicateCheckInput,
  RoomDuplicateCheckResult,
  RoomMergeImpactCounts,
  RoomMergeOperation,
  RoomMergePreview,
} from "@nxcore/agent-contract";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentRuns,
  agentSessionLinks,
  agentSessions,
  contextRooms,
  documentBlockReferences,
  documentOperations,
  entities,
  roomDocumentLinks,
  roomDuplicateCandidates,
  roomEntityMentions,
  roomMemoryAttributions,
  roomMergeItems,
  roomMergeOperations,
  roomRelations,
  roomSourceMemberships,
  roomWikis,
  rooms,
  routeDecisions,
  routingRules,
} from "../../infrastructure/database/schema.js";
import { cosineSimilarity, decodeCentroid } from "../knowledge/embedding.js";
import { bigramDiceSimilarity, normalizeEntityName } from "../knowledge/entity-index.js";

const SCORING_VERSION = 1;
const OVERRIDE_TTL_MS = 10 * 60_000;
const ARRAY_FIELDS = [
  "materials", "memoryItems", "fileItems", "actionItems", "timeline",
  "pendingMemoryItems", "people", "graphEdges",
] as const;

type ContextRow = typeof contextRooms.$inferSelect;
type KnowledgeRoomRow = typeof rooms.$inferSelect;

export interface RoomIdentityJudgeInput {
  name: string;
  aliases: string[];
  kind: string;
  evidenceSamples: string[];
}

export interface RoomDuplicateServiceOptions {
  judgeIdentity?: (a: RoomIdentityJudgeInput, b: RoomIdentityJudgeInput) => Promise<{ same: boolean; reason: string }>;
  mergeKnowledge?: (sourceRoomId: string, targetRoomId: string) => Promise<void>;
  rebuildRelations?: () => void;
  wikiFileCount?: (roomId: string) => Promise<number>;
}

interface RoomFacts {
  context: ContextRow;
  knowledge: KnowledgeRoomRow | null;
  aliases: string[];
  evidenceGroups: Set<string>;
  entityIds: Set<string>;
  evidenceSamples: string[];
  centroid: number[] | null;
  centroidModel: string | null;
}

interface PairAssessment {
  nameScore: number;
  centroidScore: number;
  contentOverlap: number;
  entityOverlap: number;
  duplicateScore: number;
  confidence: "high" | "medium" | "related" | "distinct" | "pending";
  llmVerdict: "same" | "different" | "unavailable" | null;
  reasons: string[];
  evidenceRevision: string;
}

interface OverrideEntry {
  fingerprint: string;
  expiresAt: number;
}

export class DuplicateReviewRequiredError extends Error {
  readonly code = "duplicate_review_required";

  constructor(readonly result: RoomDuplicateCheckResult) {
    super("A similar Context Room already exists");
    this.name = "DuplicateReviewRequiredError";
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  const denominator = Math.min(a.size, b.size);
  if (denominator === 0) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return overlap / denominator;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function itemKey(item: Record<string, unknown>): string {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  return id || hash(item);
}

function mergeArrays(target: unknown, source: unknown): Array<Record<string, unknown>> {
  const result = arrayOf(target);
  const seen = new Set(result.map(itemKey));
  for (const item of arrayOf(source)) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function replaceRoomId(value: unknown, sourceRoomId: string, targetRoomId: string): unknown {
  if (value === sourceRoomId) return targetRoomId;
  if (Array.isArray(value)) return value.map((item) => replaceRoomId(item, sourceRoomId, targetRoomId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, replaceRoomId(item, sourceRoomId, targetRoomId)]));
}

function roomSnapshot(row: ContextRow): ContextRoomSnapshotItem {
  return {
    id: row.id,
    title: row.title,
    ...(row.kind ? { kind: row.kind } : {}),
    data: row.data,
    lifecycle: row.lifecycle,
    mergedIntoRoomId: row.mergedIntoRoomId,
  };
}

function operationDto(row: typeof roomMergeOperations.$inferSelect): RoomMergeOperation {
  return {
    id: row.id,
    sourceRoomId: row.sourceRoomId,
    targetRoomId: row.targetRoomId,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    commitReached: row.commitReached,
    impact: row.impact as unknown as RoomMergeImpactCounts,
    error: row.error,
    confirmedAt: row.confirmedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class RoomDuplicateService {
  private readonly overrides = new Map<string, OverrideEntry>();
  private readonly runningMerges = new Map<string, Promise<void>>();
  private rebuildTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly options: RoomDuplicateServiceOptions = {},
  ) {}

  initialize(): void {
    this.disposed = false;
    this.db.update(roomMergeOperations).set({
      status: "failed",
      error: "gateway_restarted_during_merge",
      updatedAt: new Date(),
    }).where(eq(roomMergeOperations.status, "running")).run();
    this.requestRebuild();
  }

  requestRebuild(): void {
    if (this.disposed || this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (!this.disposed) void this.rebuildCandidates().catch(() => undefined);
    }, 250);
    this.rebuildTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  private activeContextRows(): ContextRow[] {
    return this.db.select().from(contextRooms)
      .where(and(isNull(contextRooms.deletedAt), eq(contextRooms.lifecycle, "active")))
      .all();
  }

  private factsFor(row: ContextRow): RoomFacts {
    const knowledge = this.db.select().from(rooms).where(eq(rooms.id, row.id)).get() ?? null;
    const registryEntity = knowledge?.entityId
      ? this.db.select().from(entities).where(eq(entities.id, knowledge.entityId)).get()
      : null;
    const memberships = this.db.select().from(roomSourceMemberships)
      .where(eq(roomSourceMemberships.roomId, row.id)).all()
      .filter((item) => item.trusted && (item.qualityLevel === "normal" || item.qualityLevel === "high"));
    const mentions = this.db.select().from(roomEntityMentions)
      .where(eq(roomEntityMentions.roomId, row.id)).all()
      .filter((item) => item.trusted && (item.qualityLevel === "normal" || item.qualityLevel === "high"));
    return {
      context: row,
      knowledge,
      aliases: knowledge?.aliases ?? [],
      evidenceGroups: new Set(memberships.map((item) => item.evidenceGroupKey)),
      entityIds: new Set(mentions.map((item) => item.entityId)),
      evidenceSamples: mentions.flatMap((item) => item.evidence ? [item.evidence] : []).slice(0, 5),
      centroid: registryEntity?.centroid ? decodeCentroid(registryEntity.centroid) : null,
      centroidModel: registryEntity?.centroidModel ?? null,
    };
  }

  private nameScore(a: { context: ContextRow; aliases: string[] }, b: { context: ContextRow; aliases: string[] }): number {
    const namesA = [a.context.title, ...a.aliases];
    const namesB = [b.context.title, ...b.aliases];
    let score = 0;
    for (const left of namesA) for (const right of namesB) {
      const normalizedLeft = normalizeEntityName(left);
      const normalizedRight = normalizeEntityName(right);
      score = Math.max(score, normalizedLeft === normalizedRight ? 1 : bigramDiceSimilarity(normalizedLeft, normalizedRight));
    }
    return round(score);
  }

  private hasRelation(a: string, b: string): boolean {
    const [roomAId, roomBId] = sortedPair(a, b);
    const relation = this.db.select().from(roomRelations)
      .where(and(eq(roomRelations.roomAId, roomAId), eq(roomRelations.roomBId, roomBId))).get();
    return Boolean(relation && (relation.autoScore >= 1 || relation.pinned || relation.manualType));
  }

  private async assess(a: RoomFacts, b: RoomFacts): Promise<PairAssessment | null> {
    const nameScore = this.nameScore(a, b);
    const centroidScore = a.centroid && b.centroid && a.centroidModel && a.centroidModel === b.centroidModel
      ? round(cosineSimilarity(a.centroid, b.centroid)) : 0;
    const contentOverlap = round(overlapCoefficient(a.evidenceGroups, b.evidenceGroups));
    const entityOverlap = round(jaccard(a.entityIds, b.entityIds));
    const relatedByGraph = this.hasRelation(a.context.id, b.context.id);
    if (nameScore < 0.6 && centroidScore < 0.82 && contentOverlap < 0.35 && entityOverlap < 0.4 && !relatedByGraph) return null;

    const duplicateScore = round(nameScore * 0.3 + centroidScore * 0.3 + contentOverlap * 0.25 + entityOverlap * 0.15);
    const sameKind = (a.context.kind ?? "") === (b.context.kind ?? "");
    const exactName = nameScore === 1;
    const reasons: string[] = [];
    if (exactName) reasons.push("规范化标题或别名相同");
    else if (nameScore >= 0.6) reasons.push(`标题相似度 ${nameScore.toFixed(2)}`);
    if (centroidScore >= 0.82) reasons.push(`内容语义相似度 ${centroidScore.toFixed(2)}`);
    if (contentOverlap >= 0.35) reasons.push(`合格资料重叠 ${Math.round(contentOverlap * 100)}%`);
    if (entityOverlap >= 0.4) reasons.push(`规范化实体重叠 ${Math.round(entityOverlap * 100)}%`);
    if (relatedByGraph) reasons.push("关系图谱存在共享资料或实体依据");

    let confidence: PairAssessment["confidence"] = "related";
    let llmVerdict: PairAssessment["llmVerdict"] = null;
    if (sameKind && (exactName || (duplicateScore >= 0.82 && (contentOverlap >= 0.5 || entityOverlap >= 0.35)))) {
      confidence = "high";
    } else if (sameKind && duplicateScore >= 0.68) {
      confidence = "medium";
    } else if (duplicateScore >= 0.6 || exactName || !sameKind) {
      if (this.options.judgeIdentity) {
        try {
          const judged = await this.options.judgeIdentity(
            { name: a.context.title, aliases: a.aliases, kind: a.context.kind ?? "议题", evidenceSamples: a.evidenceSamples },
            { name: b.context.title, aliases: b.aliases, kind: b.context.kind ?? "议题", evidenceSamples: b.evidenceSamples },
          );
          llmVerdict = judged.same ? "same" : "different";
          reasons.push(judged.reason);
          confidence = judged.same ? (duplicateScore >= 0.68 || exactName ? "medium" : "pending") : "related";
        } catch {
          llmVerdict = "unavailable";
          confidence = duplicateScore >= 0.68 && sameKind ? "medium" : "pending";
          reasons.push("同一性判定暂不可用");
        }
      } else if (duplicateScore >= 0.68 && sameKind) {
        confidence = "medium";
      } else if (duplicateScore >= 0.6 || exactName) {
        confidence = "pending";
      }
    }
    const evidenceRevision = hash({
      roomA: {
        id: a.context.id,
        title: normalizeEntityName(a.context.title),
        kind: a.context.kind,
        aliases: a.aliases.map(normalizeEntityName).sort(),
        evidenceGroups: [...a.evidenceGroups].sort(),
        entityIds: [...a.entityIds].sort(),
        centroid: a.centroid,
        centroidModel: a.centroidModel,
      },
      roomB: {
        id: b.context.id,
        title: normalizeEntityName(b.context.title),
        kind: b.context.kind,
        aliases: b.aliases.map(normalizeEntityName).sort(),
        evidenceGroups: [...b.evidenceGroups].sort(),
        entityIds: [...b.entityIds].sort(),
        centroid: b.centroid,
        centroidModel: b.centroidModel,
      },
      nameScore, centroidScore, contentOverlap, entityOverlap, duplicateScore,
    });
    return { nameScore, centroidScore, contentOverlap, entityOverlap, duplicateScore, confidence, llmVerdict, reasons, evidenceRevision };
  }

  async rebuildCandidates(): Promise<number> {
    const facts = this.activeContextRows().map((row) => this.factsFor(row));
    const seen = new Set<string>();
    let count = 0;
    for (let left = 0; left < facts.length; left += 1) {
      for (let right = left + 1; right < facts.length; right += 1) {
        const a = facts[left]!;
        const b = facts[right]!;
        const assessment = await this.assess(a, b);
        if (!assessment) continue;
        const [roomAId, roomBId] = sortedPair(a.context.id, b.context.id);
        const pairKey = `${roomAId}:${roomBId}`;
        seen.add(pairKey);
        const existing = this.db.select().from(roomDuplicateCandidates)
          .where(and(eq(roomDuplicateCandidates.roomAId, roomAId), eq(roomDuplicateCandidates.roomBId, roomBId))).get();
        const preserveDecision = existing
          && (existing.status === "distinct" || existing.status === "related")
          && existing.evidenceRevision === assessment.evidenceRevision;
        const now = new Date();
        this.db.insert(roomDuplicateCandidates).values({
          id: existing?.id ?? `room-duplicate-${hash(pairKey).slice(0, 20)}`,
          roomAId,
          roomBId,
          ...assessment,
          status: preserveDecision ? existing.status : "open",
          scoringVersion: SCORING_VERSION,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [roomDuplicateCandidates.roomAId, roomDuplicateCandidates.roomBId],
          set: {
            ...assessment,
            status: preserveDecision ? existing!.status : "open",
            scoringVersion: SCORING_VERSION,
            updatedAt: now,
          },
        }).run();
        count += 1;
      }
    }
    for (const candidate of this.db.select().from(roomDuplicateCandidates).where(eq(roomDuplicateCandidates.status, "open")).all()) {
      if (!seen.has(`${candidate.roomAId}:${candidate.roomBId}`)) {
        this.db.delete(roomDuplicateCandidates).where(eq(roomDuplicateCandidates.id, candidate.id)).run();
      }
    }
    return count;
  }

  private candidateDto(row: typeof roomDuplicateCandidates.$inferSelect): RoomDuplicateCandidate | null {
    const roomA = this.db.select().from(contextRooms).where(eq(contextRooms.id, row.roomAId)).get();
    const roomB = this.db.select().from(contextRooms).where(eq(contextRooms.id, row.roomBId)).get();
    if (!roomA || !roomB) return null;
    return {
      id: row.id,
      roomAId: row.roomAId,
      roomBId: row.roomBId,
      roomA: { id: roomA.id, title: roomA.title, ...(roomA.kind ? { kind: roomA.kind } : {}) },
      roomB: { id: roomB.id, title: roomB.title, ...(roomB.kind ? { kind: roomB.kind } : {}) },
      nameScore: row.nameScore,
      centroidScore: row.centroidScore,
      contentOverlap: row.contentOverlap,
      entityOverlap: row.entityOverlap,
      duplicateScore: row.duplicateScore,
      confidence: row.confidence,
      reasons: row.reasons,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  listCandidates(status?: RoomDuplicateCandidateStatus): RoomDuplicateCandidate[] {
    const rows = status
      ? this.db.select().from(roomDuplicateCandidates).where(eq(roomDuplicateCandidates.status, status)).all()
      : this.db.select().from(roomDuplicateCandidates).all();
    return rows.flatMap((row) => {
      const dto = this.candidateDto(row);
      return dto ? [dto] : [];
    }).sort((a, b) => {
      const rank = { high: 0, medium: 1, pending: 2, related: 3, distinct: 4 } as const;
      return rank[a.confidence] - rank[b.confidence] || b.duplicateScore - a.duplicateScore;
    });
  }

  updateCandidate(id: string, status: "related" | "distinct"): RoomDuplicateCandidate | null {
    const updated = this.db.update(roomDuplicateCandidates).set({ status, updatedAt: new Date() })
      .where(eq(roomDuplicateCandidates.id, id)).returning().get();
    return updated ? this.candidateDto(updated) : null;
  }

  private creationFingerprint(input: RoomDuplicateCheckInput): string {
    return hash({
      title: normalizeEntityName(input.title),
      description: input.description?.trim() ?? "",
      kind: input.kind?.trim() ?? "",
      excludeRoomId: input.excludeRoomId ?? "",
    });
  }

  async checkCreation(input: RoomDuplicateCheckInput): Promise<RoomDuplicateCheckResult> {
    const pseudoRow = {
      id: "new-room",
      title: input.title.trim(),
      kind: input.kind?.trim() || null,
      data: { creationDescription: input.description?.trim() ?? "" },
      position: 0,
      lifecycle: "active" as const,
      mergedIntoRoomId: null,
      mergedAt: null,
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } satisfies ContextRow;
    const pseudo: RoomFacts = {
      context: pseudoRow,
      knowledge: null,
      aliases: [],
      evidenceGroups: new Set(),
      entityIds: new Set(),
      evidenceSamples: input.description ? [input.description.slice(0, 500)] : [],
      centroid: null,
      centroidModel: null,
    };
    const candidates: RoomDuplicateCandidate[] = [];
    for (const row of this.activeContextRows()) {
      if (row.id === input.excludeRoomId) continue;
      const facts = this.factsFor(row);
      const assessment = await this.assess(pseudo, facts);
      if (!assessment || !["high", "medium", "pending"].includes(assessment.confidence)) continue;
      candidates.push({
        id: `creation:${row.id}`,
        roomAId: pseudoRow.id,
        roomBId: row.id,
        roomA: { id: pseudoRow.id, title: pseudoRow.title, ...(pseudoRow.kind ? { kind: pseudoRow.kind } : {}) },
        roomB: { id: row.id, title: row.title, ...(row.kind ? { kind: row.kind } : {}) },
        nameScore: assessment.nameScore,
        centroidScore: assessment.centroidScore,
        contentOverlap: assessment.contentOverlap,
        entityOverlap: assessment.entityOverlap,
        duplicateScore: assessment.duplicateScore,
        confidence: assessment.confidence,
        reasons: assessment.reasons,
        status: "open",
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    candidates.sort((a, b) => b.nameScore - a.nameScore || b.duplicateScore - a.duplicateScore);
    if (candidates.length === 0) return { candidates: [], overrideToken: null, expiresAt: null };
    const token = randomUUID();
    const expiresAt = Date.now() + OVERRIDE_TTL_MS;
    this.overrides.set(token, { fingerprint: this.creationFingerprint(input), expiresAt });
    return { candidates, overrideToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async assertCreationAllowed(input: RoomDuplicateCheckInput & { duplicateOverrideToken?: string }): Promise<boolean> {
    const token = input.duplicateOverrideToken;
    if (token) {
      const entry = this.overrides.get(token);
      this.overrides.delete(token);
      if (entry && entry.expiresAt >= Date.now() && entry.fingerprint === this.creationFingerprint(input)) return true;
    }
    const result = await this.checkCreation(input);
    if (result.candidates.length > 0) throw new DuplicateReviewRequiredError(result);
    return false;
  }

  private roomOrThrow(roomId: string): ContextRow {
    const room = this.db.select().from(contextRooms).where(eq(contextRooms.id, roomId)).get();
    if (!room || room.deletedAt || room.lifecycle !== "active") throw new Error("context_room_not_mergeable");
    return room;
  }

  private sessionImpact(sourceRoomId: string): { unassignedRuns: number; crossRoomSessions: number } {
    const sessions = this.db.select().from(agentSessions).where(eq(agentSessions.roomId, sourceRoomId)).all();
    let unassignedRuns = 0;
    let crossRoomSessions = 0;
    for (const session of sessions) {
      const runs = this.db.select().from(agentRuns).where(eq(agentRuns.sessionId, session.id)).all();
      unassignedRuns += runs.filter((run) => !run.roomId).length;
      if (new Set(runs.flatMap((run) => run.roomId ? [run.roomId] : [])).size > 1) crossRoomSessions += 1;
    }
    return { unassignedRuns, crossRoomSessions };
  }

  async previewMerge(sourceRoomId: string, targetRoomId: string): Promise<RoomMergePreview> {
    if (sourceRoomId === targetRoomId) throw new Error("context_room_merge_same_room");
    const source = this.roomOrThrow(sourceRoomId);
    const target = this.roomOrThrow(targetRoomId);
    const memberships = this.db.select().from(roomSourceMemberships).where(eq(roomSourceMemberships.roomId, sourceRoomId)).all();
    const sessionImpact = this.sessionImpact(sourceRoomId);
    const impact: RoomMergeImpactCounts = {
      documents: this.db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.roomId, sourceRoomId)).all().length,
      externalSources: memberships.filter((item) => item.sourceKind !== "everroom-doc").length,
      wikiFiles: await this.options.wikiFileCount?.(sourceRoomId).catch(() => 0) ?? 0,
      localMemories: arrayOf(source.data.memoryItems).length,
      attributedMemories: this.db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.roomId, sourceRoomId)).all().length,
      agentRuns: this.db.select().from(agentRuns).where(eq(agentRuns.roomId, sourceRoomId)).all().length,
      sessionLinks: this.db.select().from(agentSessionLinks).where(eq(agentSessionLinks.sourceRoomId, sourceRoomId)).all().length,
      entities: new Set(this.db.select({ entityId: roomEntityMentions.entityId }).from(roomEntityMentions)
        .where(eq(roomEntityMentions.roomId, sourceRoomId)).all().map((item) => item.entityId)).size,
      relations: this.db.select().from(roomRelations).where(or(
        eq(roomRelations.roomAId, sourceRoomId), eq(roomRelations.roomBId, sourceRoomId),
      )).all().length,
      ...sessionImpact,
    };
    const conflicts: string[] = [];
    if (normalizeEntityName(source.title) !== normalizeEntityName(target.title)) conflicts.push("来源 Room 名称将作为主 Room 别名保留");
    if (source.kind && target.kind && source.kind !== target.kind) conflicts.push("Room 类型不同，将保留主 Room 类型");
    for (const field of ARRAY_FIELDS) {
      const targetIds = new Set(arrayOf(target.data[field]).map(itemKey));
      const overlap = arrayOf(source.data[field]).filter((item) => targetIds.has(itemKey(item))).length;
      if (overlap > 0) conflicts.push(`${field} 中 ${overlap} 项将按稳定 ID 折叠`);
    }
    const excluded = [
      `${impact.unassignedRuns} 个无 Room 归属的旧 Agent run 不迁移`,
      `${impact.crossRoomSessions} 个跨 Room 会话不整体迁移`,
      "全局或缺少明确 provenance 的 MemoryCore 记忆不迁移",
    ];
    const generatedAt = new Date().toISOString();
    const previewHash = hash({
      source: [source.id, source.updatedAt.toISOString(), source.lifecycle],
      target: [target.id, target.updatedAt.toISOString(), target.lifecycle],
      impact,
      conflicts,
      scoringVersion: SCORING_VERSION,
    });
    return {
      sourceRoom: roomSnapshot(source),
      targetRoom: roomSnapshot(target),
      recommendedTargetRoomId: targetRoomId,
      impact,
      conflicts,
      excluded,
      previewHash,
      generatedAt,
    };
  }

  async startMerge(input: {
    sourceRoomId: string;
    targetRoomId: string;
    previewHash: string;
    idempotencyKey: string;
  }): Promise<RoomMergeOperation> {
    const existing = this.db.select().from(roomMergeOperations)
      .where(eq(roomMergeOperations.idempotencyKey, input.idempotencyKey)).get();
    if (existing) return operationDto(existing);
    const preview = await this.previewMerge(input.sourceRoomId, input.targetRoomId);
    if (preview.previewHash !== input.previewHash) throw new Error("context_room_merge_preview_stale");
    const busy = this.db.select().from(roomMergeOperations)
      .where(and(inArray(roomMergeOperations.status, ["queued", "running", "failed"]), or(
        eq(roomMergeOperations.sourceRoomId, input.sourceRoomId),
        eq(roomMergeOperations.targetRoomId, input.sourceRoomId),
        eq(roomMergeOperations.sourceRoomId, input.targetRoomId),
        eq(roomMergeOperations.targetRoomId, input.targetRoomId),
      ))).get();
    if (busy) throw new Error("context_room_merge_busy");
    const now = new Date();
    const id = `room-merge-${randomUUID()}`;
    const inserted = this.db.transaction((tx) => {
      tx.update(contextRooms).set({ lifecycle: "merging", updatedAt: now })
        .where(and(eq(contextRooms.id, input.sourceRoomId), eq(contextRooms.lifecycle, "active"))).run();
      tx.update(rooms).set({ lifecycle: "merging", updatedAt: now })
        .where(eq(rooms.id, input.sourceRoomId)).run();
      return tx.insert(roomMergeOperations).values({
        id,
        sourceRoomId: input.sourceRoomId,
        targetRoomId: input.targetRoomId,
        idempotencyKey: input.idempotencyKey,
        previewHash: input.previewHash,
        status: "queued",
        stage: "queued",
        progress: 0,
        impact: preview.impact as unknown as Record<string, unknown>,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
    });
    this.runMerge(id);
    return operationDto(inserted);
  }

  getOperation(id: string): RoomMergeOperation | null {
    const row = this.db.select().from(roomMergeOperations).where(eq(roomMergeOperations.id, id)).get();
    return row ? operationDto(row) : null;
  }

  retryMerge(id: string): RoomMergeOperation | null {
    const row = this.db.select().from(roomMergeOperations).where(eq(roomMergeOperations.id, id)).get();
    if (!row) return null;
    if (row.status !== "failed") return operationDto(row);
    this.db.update(roomMergeOperations).set({ status: "queued", error: null, updatedAt: new Date() })
      .where(eq(roomMergeOperations.id, id)).run();
    this.runMerge(id);
    return this.getOperation(id);
  }

  cancelMerge(id: string): RoomMergeOperation | null {
    const row = this.db.select().from(roomMergeOperations).where(eq(roomMergeOperations.id, id)).get();
    if (!row) return null;
    if (row.commitReached || !["queued", "failed"].includes(row.status)) throw new Error("context_room_merge_cannot_cancel");
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(contextRooms).set({ lifecycle: "active", updatedAt: now })
        .where(eq(contextRooms.id, row.sourceRoomId)).run();
      tx.update(rooms).set({ lifecycle: "active", updatedAt: now })
        .where(eq(rooms.id, row.sourceRoomId)).run();
      tx.update(roomMergeOperations).set({ status: "cancelled", stage: "cancelled", updatedAt: now })
        .where(eq(roomMergeOperations.id, id)).run();
    });
    return this.getOperation(id);
  }

  private setProgress(id: string, stage: string, progress: number): void {
    this.db.update(roomMergeOperations).set({ status: "running", stage, progress, updatedAt: new Date() })
      .where(eq(roomMergeOperations.id, id)).run();
  }

  private runMerge(id: string): void {
    if (this.runningMerges.has(id)) return;
    const running = this.executeMerge(id).finally(() => this.runningMerges.delete(id));
    this.runningMerges.set(id, running);
  }

  private recordItem(operationId: string, resourceType: string, resourceId: string, beforeRoomId: string, afterRoomId: string, status: "moved" | "folded"): void {
    const now = new Date();
    this.db.insert(roomMergeItems).values({
      id: randomUUID(), operationId, resourceType, resourceId, beforeRoomId, afterRoomId, status, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
  }

  private mergeContextData(source: ContextRow, target: ContextRow): Record<string, unknown> {
    const data: Record<string, unknown> = { ...source.data, ...target.data, id: target.id, title: target.title };
    for (const field of ARRAY_FIELDS) data[field] = mergeArrays(target.data[field], source.data[field]);
    const targetGenerated = target.data.generatedContext && typeof target.data.generatedContext === "object"
      ? target.data.generatedContext as Record<string, unknown> : {};
    const sourceGenerated = source.data.generatedContext && typeof source.data.generatedContext === "object"
      ? source.data.generatedContext as Record<string, unknown> : {};
    data.generatedContext = {
      ...sourceGenerated,
      ...targetGenerated,
      roomId: target.id,
      sourceDocuments: mergeArrays(targetGenerated.sourceDocuments, sourceGenerated.sourceDocuments),
      generatedAt: new Date().toISOString(),
    };
    const stats = target.data.stats && typeof target.data.stats === "object"
      ? { ...(target.data.stats as Record<string, unknown>) } : {};
    stats.memories = arrayOf(data.memoryItems).length;
    stats.tasks = arrayOf(data.actionItems).length;
    stats.docs = arrayOf(data.materials).length;
    data.stats = stats;
    data.updatedAt = new Date().toISOString();
    data.lastMergeAt = data.updatedAt;
    return data;
  }

  private moveDocumentLinks(operationId: string, sourceRoomId: string, targetRoomId: string): void {
    const sourceLinks = this.db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.roomId, sourceRoomId)).all();
    const targetIds = new Set(this.db.select({ id: roomDocumentLinks.documentId }).from(roomDocumentLinks)
      .where(eq(roomDocumentLinks.roomId, targetRoomId)).all().map((item) => item.id));
    for (const link of sourceLinks) {
      if (targetIds.has(link.documentId)) {
        this.db.delete(roomDocumentLinks).where(and(eq(roomDocumentLinks.roomId, sourceRoomId), eq(roomDocumentLinks.documentId, link.documentId))).run();
        this.recordItem(operationId, "document", link.documentId, sourceRoomId, targetRoomId, "folded");
      } else {
        this.db.update(roomDocumentLinks).set({ roomId: targetRoomId })
          .where(and(eq(roomDocumentLinks.roomId, sourceRoomId), eq(roomDocumentLinks.documentId, link.documentId))).run();
        this.recordItem(operationId, "document", link.documentId, sourceRoomId, targetRoomId, "moved");
      }
    }
  }

  private moveMemberships(operationId: string, sourceRoomId: string, targetRoomId: string): void {
    const sourceRows = this.db.select().from(roomSourceMemberships).where(eq(roomSourceMemberships.roomId, sourceRoomId)).all();
    for (const row of sourceRows) {
      const existing = this.db.select().from(roomSourceMemberships).where(and(
        eq(roomSourceMemberships.roomId, targetRoomId),
        eq(roomSourceMemberships.sourceKind, row.sourceKind),
        eq(roomSourceMemberships.sourceId, row.sourceId),
      )).get();
      if (existing) {
        this.db.update(roomSourceMemberships).set({
          sourceVersion: Math.max(existing.sourceVersion, row.sourceVersion),
          effectiveWeight: Math.max(existing.effectiveWeight, row.effectiveWeight),
          trusted: existing.trusted || row.trusted,
          entityIndexed: existing.entityIndexed || row.entityIndexed,
          updatedAt: new Date(),
        }).where(eq(roomSourceMemberships.id, existing.id)).run();
        this.db.delete(roomSourceMemberships).where(eq(roomSourceMemberships.id, row.id)).run();
        this.recordItem(operationId, "source", `${row.sourceKind}:${row.sourceId}`, sourceRoomId, targetRoomId, "folded");
      } else {
        this.db.update(roomSourceMemberships).set({ roomId: targetRoomId, updatedAt: new Date() })
          .where(eq(roomSourceMemberships.id, row.id)).run();
        this.recordItem(operationId, "source", `${row.sourceKind}:${row.sourceId}`, sourceRoomId, targetRoomId, "moved");
      }
    }
  }

  private moveMentions(sourceRoomId: string, targetRoomId: string): void {
    for (const row of this.db.select().from(roomEntityMentions).where(eq(roomEntityMentions.roomId, sourceRoomId)).all()) {
      const existing = this.db.select().from(roomEntityMentions).where(and(
        eq(roomEntityMentions.roomId, targetRoomId),
        eq(roomEntityMentions.entityId, row.entityId),
        eq(roomEntityMentions.sourceKind, row.sourceKind),
        eq(roomEntityMentions.sourceId, row.sourceId),
      )).get();
      if (existing) {
        this.db.update(roomEntityMentions).set({
          salience: Math.max(existing.salience, row.salience),
          relevanceFactor: Math.max(existing.relevanceFactor, row.relevanceFactor),
          trusted: existing.trusted || row.trusted,
          evidence: existing.evidence ?? row.evidence,
          updatedAt: new Date(),
        }).where(eq(roomEntityMentions.id, existing.id)).run();
        this.db.delete(roomEntityMentions).where(eq(roomEntityMentions.id, row.id)).run();
      } else {
        this.db.update(roomEntityMentions).set({ roomId: targetRoomId, updatedAt: new Date() })
          .where(eq(roomEntityMentions.id, row.id)).run();
      }
    }
  }

  private moveRelations(sourceRoomId: string, targetRoomId: string): void {
    const sourceRelations = this.db.select().from(roomRelations).where(or(
      eq(roomRelations.roomAId, sourceRoomId), eq(roomRelations.roomBId, sourceRoomId),
    )).all();
    for (const relation of sourceRelations) {
      const neighbor = relation.roomAId === sourceRoomId ? relation.roomBId : relation.roomAId;
      if (neighbor === targetRoomId) {
        this.db.delete(roomRelations).where(eq(roomRelations.id, relation.id)).run();
        continue;
      }
      const [roomAId, roomBId] = sortedPair(targetRoomId, neighbor);
      const existing = this.db.select().from(roomRelations).where(and(
        eq(roomRelations.roomAId, roomAId), eq(roomRelations.roomBId, roomBId),
      )).get();
      const manualFromRoomId = relation.manualFromRoomId === sourceRoomId ? targetRoomId : relation.manualFromRoomId;
      const manualToRoomId = relation.manualToRoomId === sourceRoomId ? targetRoomId : relation.manualToRoomId;
      if (existing && existing.id !== relation.id) {
        this.db.update(roomRelations).set({
          pinned: existing.pinned || relation.pinned,
          hidden: existing.hidden || relation.hidden,
          manualType: existing.manualType ?? relation.manualType,
          manualFromRoomId: existing.manualFromRoomId ?? manualFromRoomId,
          manualToRoomId: existing.manualToRoomId ?? manualToRoomId,
          manualLabel: existing.manualLabel ?? relation.manualLabel,
          manualNote: existing.manualNote ?? relation.manualNote,
          updatedAt: new Date(),
        }).where(eq(roomRelations.id, existing.id)).run();
        this.db.delete(roomRelations).where(eq(roomRelations.id, relation.id)).run();
      } else {
        this.db.update(roomRelations).set({ roomAId, roomBId, manualFromRoomId, manualToRoomId, updatedAt: new Date() })
          .where(eq(roomRelations.id, relation.id)).run();
      }
    }
  }

  private async executeMerge(id: string): Promise<void> {
    const operation = this.db.select().from(roomMergeOperations).where(eq(roomMergeOperations.id, id)).get();
    if (!operation || operation.status === "completed" || operation.status === "cancelled") return;
    const sourceRoomId = operation.sourceRoomId;
    const targetRoomId = operation.targetRoomId;
    try {
      this.setProgress(id, "migrating_local_data", 15);
      const source = this.db.select().from(contextRooms).where(eq(contextRooms.id, sourceRoomId)).get();
      const target = this.db.select().from(contextRooms).where(eq(contextRooms.id, targetRoomId)).get();
      if (!source || !target) throw new Error("context_room_merge_room_missing");
      if (!operation.commitReached) {
        const now = new Date();
        this.db.transaction(() => {
          this.db.update(contextRooms).set({ data: this.mergeContextData(source, target), updatedAt: now })
            .where(eq(contextRooms.id, targetRoomId)).run();
          this.moveDocumentLinks(id, sourceRoomId, targetRoomId);
          this.moveMemberships(id, sourceRoomId, targetRoomId);
          this.moveMentions(sourceRoomId, targetRoomId);
          this.db.update(roomMemoryAttributions).set({ roomId: targetRoomId, updatedAt: now })
            .where(eq(roomMemoryAttributions.roomId, sourceRoomId)).run();
          this.db.update(agentRuns).set({ roomId: targetRoomId })
            .where(eq(agentRuns.roomId, sourceRoomId)).run();
          for (const link of this.db.select().from(agentSessionLinks).all()) {
            if (link.sourceRoomId !== sourceRoomId && !JSON.stringify(link.target).includes(sourceRoomId)) continue;
            this.db.update(agentSessionLinks).set({
              sourceRoomId: link.sourceRoomId === sourceRoomId ? targetRoomId : link.sourceRoomId,
              target: replaceRoomId(link.target, sourceRoomId, targetRoomId) as typeof link.target,
            }).where(eq(agentSessionLinks.id, link.id)).run();
          }
          this.db.update(documentBlockReferences).set({ targetRoomId })
            .where(eq(documentBlockReferences.targetRoomId, sourceRoomId)).run();
          this.db.update(documentOperations).set({ roomId: targetRoomId, updatedAt: now })
            .where(eq(documentOperations.roomId, sourceRoomId)).run();
          this.db.update(routingRules).set({ targetRoomId })
            .where(eq(routingRules.targetRoomId, sourceRoomId)).run();
          for (const decision of this.db.select().from(routeDecisions).all()) {
            const linkedRoomIds = (decision.linkedRoomIds ?? []).map((roomId) => roomId === sourceRoomId ? targetRoomId : roomId);
            if (decision.primaryRoomId !== sourceRoomId && JSON.stringify(linkedRoomIds) === JSON.stringify(decision.linkedRoomIds ?? [])) continue;
            this.db.update(routeDecisions).set({
              primaryRoomId: decision.primaryRoomId === sourceRoomId ? targetRoomId : decision.primaryRoomId,
              linkedRoomIds: [...new Set(linkedRoomIds)],
              updatedAt: now,
            }).where(eq(routeDecisions.id, decision.id)).run();
          }
          this.moveRelations(sourceRoomId, targetRoomId);
          const targetKnowledge = this.db.select().from(rooms).where(eq(rooms.id, targetRoomId)).get();
          const sourceKnowledge = this.db.select().from(rooms).where(eq(rooms.id, sourceRoomId)).get();
          if (targetKnowledge && sourceKnowledge) {
            const aliases = new Set([...(targetKnowledge.aliases ?? []), ...(sourceKnowledge.aliases ?? []), sourceKnowledge.title]);
            aliases.delete(targetKnowledge.title);
            this.db.update(rooms).set({ aliases: [...aliases].slice(0, 50), updatedAt: now })
              .where(eq(rooms.id, targetRoomId)).run();
          }
          this.db.update(roomMergeOperations).set({ commitReached: true, stage: "database_committed", progress: 55, updatedAt: now })
            .where(eq(roomMergeOperations.id, id)).run();
        });
      }

      this.setProgress(id, "rebuilding_knowledge", 70);
      await this.options.mergeKnowledge?.(sourceRoomId, targetRoomId);
      this.options.rebuildRelations?.();

      this.setProgress(id, "finalizing", 90);
      const completedAt = new Date();
      this.db.transaction((tx) => {
        tx.update(contextRooms).set({
          lifecycle: "merged",
          mergedIntoRoomId: targetRoomId,
          mergedAt: completedAt,
          data: {
            id: sourceRoomId,
            title: source.title,
            kind: source.kind,
            lifecycle: "merged",
            mergedIntoRoomId: targetRoomId,
            mergedAt: completedAt.toISOString(),
          },
          updatedAt: completedAt,
        }).where(eq(contextRooms.id, sourceRoomId)).run();
        tx.update(rooms).set({ lifecycle: "merged", mergedIntoRoomId: targetRoomId, mergedAt: completedAt, updatedAt: completedAt })
          .where(eq(rooms.id, sourceRoomId)).run();
        tx.update(roomDuplicateCandidates).set({ status: "merged", updatedAt: completedAt })
          .where(and(eq(roomDuplicateCandidates.roomAId, sortedPair(sourceRoomId, targetRoomId)[0]), eq(roomDuplicateCandidates.roomBId, sortedPair(sourceRoomId, targetRoomId)[1]))).run();
        tx.delete(roomDuplicateCandidates).where(and(
          or(eq(roomDuplicateCandidates.roomAId, sourceRoomId), eq(roomDuplicateCandidates.roomBId, sourceRoomId)),
          eq(roomDuplicateCandidates.status, "open"),
        )).run();
        tx.update(roomMergeOperations).set({
          status: "completed", stage: "completed", progress: 100, completedAt, error: null, updatedAt: completedAt,
        }).where(eq(roomMergeOperations.id, id)).run();
      });
      this.requestRebuild();
    } catch (error) {
      this.db.update(roomMergeOperations).set({
        status: "failed",
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      }).where(eq(roomMergeOperations.id, id)).run();
    }
  }
}
