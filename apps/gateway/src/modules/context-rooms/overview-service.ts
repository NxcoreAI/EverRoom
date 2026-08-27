import { createHash, randomUUID } from "node:crypto";
import type {
  ProposeRoomContextCorrectionInput,
  RoomContextCorrection,
  RoomOverviewClaim,
  RoomOverviewEvidence,
  RoomOverviewProjection,
  RoomOverviewSection,
} from "@nxcore/agent-contract";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { contextRooms, roomContextCorrections, roomOverviews } from "../../infrastructure/database/schema.js";
import type { ContextRoomService } from "./service.js";
import {
  invocationText,
  parseRoomOverviewSynthesis,
  type ContextRoomOverviewSynthesis,
  type RoomAgentDispatcher,
} from "./room-agent.js";

const SECTION_KEYS: RoomOverviewSection[] = [
  "overview", "status", "next_steps", "timeline", "entities",
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function stringList(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value) ? value.map((item) => text(item, 1_000)).filter(Boolean).slice(0, maxItems) : [];
}

function claimId(section: RoomOverviewSection, value: string): string {
  return `${section}:${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function claim(
  section: RoomOverviewSection,
  value: string,
  origin: RoomOverviewClaim["origin"],
  evidence: RoomOverviewEvidence[] = [],
  confidence: number | null = null,
  occurredAt?: string | null,
): RoomOverviewClaim {
  return {
    id: claimId(section, value), section, text: value, origin, confidence, evidence, corrected: false,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
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
    return stored ? stored.projection as unknown as RoomOverviewProjection : this.refresh(resolved);
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
      taskInput: { roomId: resolved, roomTitle: row.title },
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
    const data = record(row.data);
    const brief = record(data.brief);
    const generated = record(data.generatedContext);
    const facts = this.rooms.roomAppliedEntities(resolved);
    const generatedAt = new Date();

    const sourceOf = (source: { sourceKind: string; sourceId: string; sourceTitle: string | null }): RoomOverviewEvidence => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceTitle: source.sourceTitle,
    });
    const overviewText = synthesis?.overview || text(generated.overview) || text(brief.background);
    const statusText = synthesis?.status || text(generated.status) || text(brief.status);
    const timelineItems = Array.isArray(data.timeline) ? data.timeline.flatMap((item) => {
      const value = record(item);
      const title = text(value.title, 500);
      const description = text(value.description, 2_000);
      if (!title && !description) return [];
      const sourceId = text(value.sourceDocumentId, 256);
      return [claim(
        "timeline",
        title && description ? `${title}：${description}` : title || description,
        value.generated === true ? "inference" : "fact",
        sourceId ? [{ sourceKind: "everroom-doc", sourceId, sourceTitle: null }] : [],
        value.generated === true ? null : 1,
        text(value.time, 200) || null,
      )];
    }) : [];
    return {
      roomId: resolved,
      revision: 0,
      generatedAt: generatedAt.toISOString(),
      stale: false,
      overview: overviewText ? [claim("overview", overviewText, "inference")] : [],
      status: statusText ? [claim("status", statusText, "inference")] : [],
      nextSteps: (synthesis?.nextSteps ?? stringList(generated.nextSteps))
        .map((item) => claim("next_steps", item, "inference")),
      timeline: timelineItems.length ? timelineItems : facts.facts
        .filter((fact) => fact.lastMentionAt)
        .map((fact) => claim("timeline", fact.content, "fact", fact.sources.map(sourceOf), 1, fact.lastMentionAt)),
      entities: facts.entities.map((entity) => claim(
        "entities",
        entity.summary ? `${entity.name}：${entity.summary}` : entity.name,
        "fact",
        entity.sources.map(sourceOf),
        entity.salience,
      )),
      appliedCorrectionIds: [],
    };
  }

  private persistBase(base: RoomOverviewProjection): RoomOverviewProjection {
    const existing = this.db.select().from(roomOverviews).where(eq(roomOverviews.roomId, base.roomId)).get();
    const revision = (existing?.revision ?? 0) + 1;
    const applied = this.list(base.roomId).filter((item) => item.status === "applied");
    const projection: RoomOverviewProjection = structuredClone({
      ...base,
      revision,
      appliedCorrectionIds: applied.map((item) => item.id),
    });
    this.applyCorrections(projection, applied);
    const storedBase = { ...base, revision, appliedCorrectionIds: [] };
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
        if (correction.targetSource) projection[key] = items.filter((item) => !hasSource(item, correction.targetSource!));
        continue;
      }
      if (correction.operation === "content_suppress") {
        if (targetIndex >= 0) items.splice(targetIndex, 1);
        continue;
      }
      const replacement = correction.replacementText?.trim();
      if (!replacement) continue;
      const corrected = {
        ...claim(correction.section, replacement, "user", [], 1, targetIndex >= 0 ? items[targetIndex]?.occurredAt : undefined),
        corrected: true,
      };
      if (["content_replace", "fact_correct"].includes(correction.operation) && targetIndex >= 0) items.splice(targetIndex, 1, corrected);
      else if (["content_add", "fact_add"].includes(correction.operation)) items.push(corrected);
    }
  }
}
