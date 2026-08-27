import { createHash, randomUUID } from "node:crypto";
import type {
  ProposeRoomContextCorrectionInput,
  RoomContextCorrection,
  RoomOverviewClaim,
  RoomOverviewClaimData,
  RoomOverviewEvidence,
  RoomOverviewProjection,
  RoomOverviewSection,
} from "@nxcore/agent-contract";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorTodos,
  contextRooms,
  documents,
  roomContextCorrections,
  roomDocumentLinks,
  roomOverviews,
  roomSourceMemberships,
  routeDecisions,
} from "../../infrastructure/database/schema.js";
import type { ContextRoomService } from "./service.js";
import {
  invocationText,
  parseRoomOverviewSynthesis,
  type ContextRoomOverviewSynthesis,
  type RoomAgentDispatcher,
} from "./room-agent.js";
import {
  buildRoomOverviewProjection,
  createRoomOverviewClaim,
  dedupeRoomOverviewClaims,
  roomOverviewFreshness,
} from "./overview-projection.js";

const SECTION_KEYS: RoomOverviewSection[] = [
  "overview", "status", "next_steps", "timeline", "entities",
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isoTime(value: unknown): string | null {
  const normalized = text(value, 120);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return null;
  return new Date(normalized).toISOString();
}

/** 从日历快照的“时间：开始 → 结束”行解析开始时间；解析不到（如“明天 10:00”）返回 null。 */
function calendarStartAt(markdown: string): string | null {
  const match = markdown.match(/^时间：[ \t]*([^→\n]+?)[ \t]*(?:→|$)/m);
  const raw = match?.[1]?.trim();
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function correctionRow(row: typeof roomContextCorrections.$inferSelect): RoomContextCorrection {
  const targetSource = record(row.targetSource);
  const sourceKind = text(targetSource.sourceKind, 100);
  const sourceId = text(targetSource.sourceId, 256);
  return {
    id: row.id,
    roomId: row.roomId,
    operation: row.operation,
    section: row.section,
    targetClaimId: row.targetClaimId,
    ...(sourceKind && sourceId ? {
      targetSource: {
        sourceKind,
        sourceId,
        sourceTitle: text(targetSource.sourceTitle, 500) || null,
      },
    } : {}),
    ...(row.targetRoomId ? { targetRoomId: row.targetRoomId } : {}),
    originalText: row.originalText,
    replacementText: row.replacementText,
    rationale: row.rationale,
    status: row.status,
    entryPoint: row.entryPoint,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function hasSource(item: RoomOverviewClaim, source: RoomOverviewEvidence): boolean {
  return item.evidence.some((candidate) =>
    candidate.sourceKind === source.sourceKind && candidate.sourceId === source.sourceId);
}

export class RoomOverviewService {
  private roomAgent: RoomAgentDispatcher | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly rooms: ContextRoomService,
  ) {}

  setRoomAgentDispatcher(dispatcher: RoomAgentDispatcher | null): void {
    this.roomAgent = dispatcher;
  }

  get(roomId: string): RoomOverviewProjection {
    const resolved = this.requireRoom(roomId);
    const stored = this.db.select().from(roomOverviews).where(eq(roomOverviews.roomId, resolved)).get();
    if (!stored) return this.refresh(resolved);
    const projection = structuredClone(stored.projection as unknown as RoomOverviewProjection);
    const sourceUpdatedAt = this.latestSourceUpdate(resolved);
    const lastObservedAt = projection.freshness?.sourceUpdatedAt ?? projection.generatedAt;
    if (sourceUpdatedAt && sourceUpdatedAt > lastObservedAt) {
      return this.incrementalRefresh(resolved, stored.baseProjection as unknown as RoomOverviewProjection);
    }
    projection.freshness = roomOverviewFreshness(projection.generatedAt, sourceUpdatedAt);
    projection.stale = projection.freshness.state === "stale";
    return projection;
  }

  refresh(roomId: string): RoomOverviewProjection {
    const resolved = this.requireRoom(roomId);
    return this.persistBase(this.buildBase(resolved));
  }

  async regenerate(roomId: string): Promise<RoomOverviewProjection> {
    const resolved = this.requireRoom(roomId);
    if (!this.roomAgent) throw new Error("context_room_agent_not_configured");
    const row = this.db.select().from(contextRooms).where(eq(contextRooms.id, resolved)).get();
    if (!row) throw new Error("context_room_not_found");
    const invocation = await this.roomAgent.dispatch({
      task: "room-overview",
      taskInput: {
        roomId: resolved,
        roomTitle: row.title,
        outputContract: {
          overview: [{ key: "stable semantic key", text: "string", aspect: "summary|background|goal", confidence: "0..1", evidenceRefs: ["factId or sourceKind:sourceId"] }],
          status: [{ key: "stable semantic key", text: "string", category: "conclusion|progress|problem|blocker", state: "active|resolved|unknown", confidence: "0..1", evidenceRefs: ["factId or sourceKind:sourceId"] }],
          nextSteps: [{ key: "stable semantic key", text: "string", owner: "string|null", dueAt: "ISO time|null", priority: "high|medium|low|null", confidence: "0..1", evidenceRefs: ["factId or sourceKind:sourceId"] }],
        },
        rules: [
          "Call room_context_get first and ground every factual statement in its facts or sources.",
          "Applied corrections are authoritative and must not be contradicted.",
          "Do not emit timeline or entities; those sections are generated deterministically from facts.",
        ],
      },
    });
    const content = invocation.status === "completed" ? invocationText(invocation) : null;
    if (!content) throw new Error("context_room_overview_generation_failed");
    return this.persistBase(this.buildBase(resolved, parseRoomOverviewSynthesis(content)));
  }

  private buildBase(
    roomId: string,
    synthesis?: ContextRoomOverviewSynthesis,
  ): RoomOverviewProjection {
    const resolved = this.requireRoom(roomId);
    const row = this.db.select().from(contextRooms).where(eq(contextRooms.id, resolved)).get()!;
    const applied = this.rooms.roomAppliedEntities(resolved);
    return buildRoomOverviewProjection({
      roomId: resolved,
      roomData: record(row.data),
      applied,
      generatedAt: new Date(),
      sourceUpdatedAt: this.latestSourceUpdate(resolved, applied),
      documents: this.roomDocuments(resolved),
      calendarEvents: this.roomCalendarEvents(resolved),
      todos: this.roomTodos(resolved),
      ...(synthesis ? { synthesis } : {}),
    });
  }

  /** Room 关联的活跃云文档（更新时间倒序）：时间轴“收录/版本”事件的确定性来源。 */
  private roomDocuments(roomId: string): Array<{
    id: string; title: string; version: number; createdAt: string; updatedAt: string;
  }> {
    return this.db.select({ document: documents })
      .from(roomDocumentLinks)
      .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(roomDocumentLinks.roomId, roomId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt))
      .all()
      .filter(({ document }) => document.status === "active")
      .slice(0, 20)
      .map(({ document }) => ({
        id: document.id,
        title: document.title,
        version: document.version,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      }));
  }

  /**
   * 已路由进 Room 的日历事件：membership sourceId 即 connector_calendar_events 行 id
   * （connector ref 全程透传），直连域表取精确 startAt/endAt/allDay/location；
   * 域行缺失（历史数据）时回退路由快照正则解析 startedAt。
   */
  private roomCalendarEvents(roomId: string): Array<{
    sourceId: string; title: string; startedAt: string | null;
    endAt: string | null; allDay: boolean; location: string | null;
  }> {
    const memberships = this.db.select({
      sourceId: roomSourceMemberships.sourceId,
    })
      .from(roomSourceMemberships)
      .where(and(
        eq(roomSourceMemberships.roomId, roomId),
        eq(roomSourceMemberships.sourceKind, "calendar-event"),
      ))
      .all();
    if (memberships.length === 0) return [];
    const sourceIds = memberships.map((item) => item.sourceId);
    const domainRows = new Map(this.db.select()
      .from(connectorCalendarEvents)
      .where(and(
        inArray(connectorCalendarEvents.id, sourceIds),
        isNull(connectorCalendarEvents.deletedAt),
      ))
      .all()
      .map((row) => [row.id, row]));
    const resolved = [...new Set(sourceIds)].flatMap((sourceId) => {
      const row = domainRows.get(sourceId);
      if (row) {
        return [{
          sourceId,
          title: row.title.trim(),
          startedAt: row.startAt?.toISOString() ?? null,
          endAt: row.endAt?.toISOString() ?? null,
          allDay: row.allDay,
          location: row.location,
        }];
      }
      return [];
    }).filter((event) => event.title);
    // 域表全缺（历史库）或部分命中：缺失的走路由快照回退解析。
    const missing = sourceIds.filter((id) => !domainRows.has(id));
    if (missing.length === 0) return resolved;
    const snapshots = this.db.select({
      sourceId: routeDecisions.sourceId,
      sourceVersion: routeDecisions.sourceVersion,
      sourceTitle: routeDecisions.sourceTitle,
      sourceMarkdown: routeDecisions.sourceMarkdown,
    })
      .from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, "calendar-event"),
        inArray(routeDecisions.sourceId, missing),
        isNotNull(routeDecisions.sourceMarkdown),
      ))
      .orderBy(desc(routeDecisions.sourceVersion))
      .all();
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!latest.has(snapshot.sourceId)) latest.set(snapshot.sourceId, snapshot);
    }
    const fallback = [...latest.values()].flatMap((snapshot) => {
      const title = snapshot.sourceTitle?.trim();
      if (!title) return [];
      return [{
        sourceId: snapshot.sourceId,
        title,
        startedAt: calendarStartAt(snapshot.sourceMarkdown ?? ""),
        endAt: null,
        allDay: false,
        location: null,
      }];
    });
    return [...resolved, ...fallback];
  }

  /** 已路由进 Room 的待办（kind "todo"）：按 dueAt 升序（无截止沉底）截 20。 */
  private roomTodos(roomId: string): Array<{
    sourceId: string; title: string; status: string | null;
    dueAt: string | null; completedAt: string | null; priority: string | null;
  }> {
    const memberships = this.db.select({
      sourceId: roomSourceMemberships.sourceId,
    })
      .from(roomSourceMemberships)
      .where(and(
        eq(roomSourceMemberships.roomId, roomId),
        eq(roomSourceMemberships.sourceKind, "todo"),
      ))
      .all();
    if (memberships.length === 0) return [];
    const rows = this.db.select()
      .from(connectorTodos)
      .where(and(
        inArray(connectorTodos.id, memberships.map((item) => item.sourceId)),
        isNull(connectorTodos.deletedAt),
      ))
      .all();
    return rows
      .map((row) => ({
        sourceId: row.id,
        title: row.title.trim(),
        status: row.status,
        dueAt: row.dueAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        priority: row.priority,
      }))
      .filter((todo) => todo.title)
      .sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") || left.sourceId.localeCompare(right.sourceId))
      .slice(0, 20);
  }

  private latestSourceUpdate(
    roomId: string,
    applied = this.rooms.roomAppliedEntities(roomId),
  ): string | null {
    const row = this.db.select().from(contextRooms).where(eq(contextRooms.id, roomId)).get();
    const candidates = [
      row?.updatedAt.toISOString(),
      isoTime(record(row?.data).updatedAt),
      ...applied.facts.map((fact) => fact.lastMentionAt),
      ...applied.entities.map((entity) => entity.lastMentionAt),
      // 文档更新/日历路由/待办路由也应把投影标记为待刷新。
      ...this.roomDocuments(roomId).map((document) => document.updatedAt),
      ...this.roomCalendarEvents(roomId).map((event) => event.startedAt),
      ...this.roomTodos(roomId).map((todo) => todo.dueAt),
    ].filter((value): value is string => Boolean(value));
    return candidates.sort((left, right) => right.localeCompare(left))[0] ?? null;
  }

  private incrementalRefresh(roomId: string, previousBase: RoomOverviewProjection): RoomOverviewProjection {
    const deterministic = this.buildBase(roomId);
    const inferredNextSteps = previousBase.nextSteps.filter((item) =>
      item.data?.kind !== "next_step" || item.data.itemType === "suggestion");
    return this.persistBase({
      ...previousBase,
      stale: true,
      nextSteps: dedupeRoomOverviewClaims([
        ...deterministic.nextSteps.filter((item) =>
          item.data?.kind === "next_step" && item.data.itemType !== "suggestion"),
        ...inferredNextSteps,
      ]),
      timeline: deterministic.timeline,
      entities: deterministic.entities,
      freshness: roomOverviewFreshness(previousBase.generatedAt, deterministic.freshness?.sourceUpdatedAt ?? null),
    });
  }

  private persistBase(base: RoomOverviewProjection): RoomOverviewProjection {
    const existing = this.db.select().from(roomOverviews).where(eq(roomOverviews.roomId, base.roomId)).get();
    const revision = (existing?.revision ?? 0) + 1;
    const applied = this.list(base.roomId).filter((item) => item.status === "applied");
    const freshness = roomOverviewFreshness(base.generatedAt, this.latestSourceUpdate(base.roomId));
    const projection: RoomOverviewProjection = structuredClone({
      ...base,
      revision,
      stale: freshness.state === "stale",
      freshness,
      appliedCorrectionIds: applied.map((item) => item.id),
    });
    this.applyCorrections(projection, applied);
    const storedBase = {
      ...base,
      revision,
      stale: freshness.state === "stale",
      freshness,
      appliedCorrectionIds: [],
    };
    const generatedAt = new Date(base.generatedAt);
    const updatedAt = new Date();
    this.db.insert(roomOverviews).values({
      roomId: base.roomId,
      revision,
      baseProjection: storedBase as unknown as Record<string, unknown>,
      projection: projection as unknown as Record<string, unknown>,
      generatedAt,
      updatedAt,
    }).onConflictDoUpdate({
      target: roomOverviews.roomId,
      set: {
        revision,
        baseProjection: storedBase as unknown as Record<string, unknown>,
        projection: projection as unknown as Record<string, unknown>,
        generatedAt,
        updatedAt,
      },
    }).run();
    return projection;
  }

  private reproject(roomId: string): RoomOverviewProjection {
    const resolved = this.requireRoom(roomId);
    const stored = this.db.select().from(roomOverviews).where(eq(roomOverviews.roomId, resolved)).get();
    const base = stored
      ? stored.baseProjection as unknown as RoomOverviewProjection
      : this.buildBase(resolved);
    return this.persistBase(base);
  }

  list(roomId: string): RoomContextCorrection[] {
    const resolved = this.requireRoom(roomId);
    return this.db.select().from(roomContextCorrections)
      .where(eq(roomContextCorrections.roomId, resolved))
      .orderBy(asc(roomContextCorrections.createdAt))
      .all()
      .map(correctionRow);
  }

  propose(
    roomId: string,
    input: ProposeRoomContextCorrectionInput,
    agentContext?: { sessionId: string; runId: string },
  ): RoomContextCorrection {
    const resolved = this.requireRoom(roomId);
    this.validateProposal(resolved, input);
    const now = new Date();
    const row = this.db.insert(roomContextCorrections).values({
      id: randomUUID(),
      roomId: resolved,
      operation: input.operation,
      section: input.section,
      targetClaimId: text(input.targetClaimId, 200) || null,
      targetSource: input.targetSource ? { ...input.targetSource } : null,
      targetRoomId: text(input.targetRoomId, 128) || null,
      originalText: text(input.originalText) || null,
      replacementText: text(input.replacementText) || null,
      rationale: text(input.rationale, 2_000),
      status: "proposed",
      entryPoint: input.entryPoint,
      sessionId: agentContext?.sessionId ?? (text(input.sessionId, 200) || null),
      proposedByRunId: agentContext?.runId ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return correctionRow(row);
  }

  apply(
    roomId: string,
    correctionId: string,
    agentContext?: { sessionId: string; runId: string },
  ): { correction: RoomContextCorrection; overview: RoomOverviewProjection } {
    const resolved = this.requireRoom(roomId);
    const candidate = this.db.select().from(roomContextCorrections).where(and(
      eq(roomContextCorrections.id, correctionId),
      eq(roomContextCorrections.roomId, resolved),
    )).get();
    if (agentContext && (!candidate
      || candidate.sessionId !== agentContext.sessionId
      || candidate.proposedByRunId === agentContext.runId)) {
      throw new Error("room_correction_confirmation_required");
    }
    const now = new Date();
    const row = this.db.update(roomContextCorrections).set({ status: "applied", appliedAt: now, revokedAt: null, updatedAt: now })
      .where(and(
        eq(roomContextCorrections.id, correctionId),
        eq(roomContextCorrections.roomId, resolved),
        eq(roomContextCorrections.status, "proposed"),
      )).returning().get();
    if (!row) throw new Error("room_correction_not_applicable");
    return { correction: correctionRow(row), overview: this.reproject(resolved) };
  }

  revoke(roomId: string, correctionId: string): { correction: RoomContextCorrection; overview: RoomOverviewProjection } {
    const resolved = this.requireRoom(roomId);
    const now = new Date();
    const row = this.db.update(roomContextCorrections).set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(
        eq(roomContextCorrections.id, correctionId),
        eq(roomContextCorrections.roomId, resolved),
        eq(roomContextCorrections.status, "applied"),
      )).returning().get();
    if (!row) throw new Error("room_correction_not_revocable");
    return { correction: correctionRow(row), overview: this.reproject(resolved) };
  }

  private requireRoom(roomId: string): string {
    const resolved = this.rooms.resolveRoomId(roomId);
    if (!resolved) throw new Error("context_room_not_found");
    return resolved;
  }

  private validateProposal(roomId: string, input: ProposeRoomContextCorrectionInput): void {
    if (!SECTION_KEYS.includes(input.section)) throw new Error("room_correction_invalid_section");
    if (!text(input.rationale, 2_000)) throw new Error("room_correction_rationale_required");
    if (["content_add", "content_replace", "fact_add", "fact_correct"].includes(input.operation)
      && !text(input.replacementText)) throw new Error("room_correction_replacement_required");
    if (["content_replace", "content_suppress", "fact_correct"].includes(input.operation)
      && !text(input.targetClaimId) && !text(input.originalText)) throw new Error("room_correction_target_required");
    if (["source_remove", "source_reassign"].includes(input.operation)
      && (!input.targetSource?.sourceKind || !input.targetSource.sourceId)) throw new Error("room_correction_source_required");
    if (input.operation === "source_reassign") {
      const targetRoomId = text(input.targetRoomId, 128);
      if (!targetRoomId || targetRoomId === roomId || !this.rooms.resolveRoomId(targetRoomId)) {
        throw new Error("room_correction_target_room_invalid");
      }
    }
  }

  private applyCorrections(projection: RoomOverviewProjection, corrections: RoomContextCorrection[]): void {
    for (const correction of corrections) {
      const key = correction.section === "next_steps" ? "nextSteps" : correction.section;
      const items = projection[key];
      if (!Array.isArray(items)) continue;
      const targetIndex = items.findIndex((item) =>
        (correction.targetClaimId && item.id === correction.targetClaimId)
        || (correction.originalText && item.text === correction.originalText));
      if (correction.operation === "source_remove" || correction.operation === "source_reassign") {
        if (correction.targetSource) projection[key] = items.flatMap((item) => {
          if (!hasSource(item, correction.targetSource!)) return [item];
          const remainingEvidence = item.evidence.filter((candidate) =>
            candidate.sourceKind !== correction.targetSource!.sourceKind
            || candidate.sourceId !== correction.targetSource!.sourceId);
          return item.origin === "fact" && remainingEvidence.length === 0
            ? []
            : [{ ...item, evidence: remainingEvidence, corrected: true }];
        });
        continue;
      }
      if (correction.operation === "content_suppress") {
        if (targetIndex >= 0) items.splice(targetIndex, 1);
        continue;
      }
      const replacement = correction.replacementText?.trim();
      if (!replacement) continue;
      const target = targetIndex >= 0 ? items[targetIndex] : null;
      const corrected: RoomOverviewClaim = target
        ? {
            ...target,
            text: replacement,
            origin: "user",
            confidence: 1,
            corrected: true,
            ...(target.data?.kind === "timeline"
              ? { data: { ...target.data, title: replacement, description: null } }
              : {}),
          }
        : {
            ...createRoomOverviewClaim(
              correction.section, replacement, "user", [], 1, undefined,
              this.userClaimData(correction.section, replacement),
              `correction:${correction.id}`,
            ),
            corrected: true,
          };
      if (["content_replace", "fact_correct"].includes(correction.operation) && targetIndex >= 0) items.splice(targetIndex, 1, corrected);
      else if (["content_add", "fact_add"].includes(correction.operation)) items.push(corrected);
    }
  }

  private userClaimData(section: RoomOverviewSection, value: string): RoomOverviewClaimData {
    if (section === "overview") return { kind: "overview", aspect: "summary" };
    if (section === "status") return { kind: "status", category: "conclusion", state: "active" };
    if (section === "next_steps") return {
      kind: "next_step", itemType: "suggestion", actionId: null, owner: null,
      dueAt: null, status: null, priority: null,
    };
    if (section === "timeline") return {
      kind: "timeline", eventType: "other", title: value, description: null, certainty: "fact",
    };
    return {
      kind: "entity", entityId: `user:${createHash("sha256").update(value).digest("hex").slice(0, 20)}`,
      entityKind: "用户补充", entityStatus: "ready", linkedRoomId: null, salience: 1, mentionCount: 1,
    };
  }
}
