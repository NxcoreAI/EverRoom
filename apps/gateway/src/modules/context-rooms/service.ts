import { randomUUID } from "node:crypto";
import type {
  AgentRoomReference,
  ContextRoomSnapshot,
  ContextRoomSnapshotItem,
  CreateContextRoomInput,
  CreateContextRoomResult,
  RoomAppliedEntitiesResult,
  RoomAppliedEntity,
  RoomAppliedEntityStatus,
  SaveContextRoomSnapshotInput,
} from "@nxcore/agent-contract";
import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { contextRooms, entities as entitiesTable, roomEntityMentions } from "../../infrastructure/database/schema.js";
import {
  fallbackContextRoomEnrichment,
  invocationText,
  parseBriefRefresh,
  parseContextRoomEnrichment,
  type ContextRoomEnrichment,
  type RoomAgentDispatcher,
} from "./room-agent.js";
import type { RoomDuplicateService } from "./duplicate-service.js";

function snapshotItem(row: typeof contextRooms.$inferSelect): ContextRoomSnapshotItem {
  return {
    ...roomReference(row),
    data: row.data,
    ...(row.lifecycle !== "active" ? { lifecycle: row.lifecycle } : {}),
    ...(row.mergedIntoRoomId ? { mergedIntoRoomId: row.mergedIntoRoomId } : {}),
  };
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = optionalText(item, maxLength);
        return text ? [text] : [];
      }).slice(0, maxItems)
    : [];
}

function roomContextSummary(value: Record<string, unknown>): AgentRoomReference["contextSummary"] | undefined {
  const overview = optionalText(value.overview, 500) ?? "";
  const nextSteps = stringArray(value.nextSteps, 4, 300);
  const entities = Array.isArray(value.entities) ? value.entities.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entity = item as Record<string, unknown>;
    const name = optionalText(entity.name, 120);
    if (!name) return [];
    return [{
      name,
      kind: optionalText(entity.kind, 24) ?? "主题",
      description: optionalText(entity.description, 300) ?? "",
    }];
  }).slice(0, 10) : [];
  const actionItems = Array.isArray(value.actionItems) ? value.actionItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const action = item as Record<string, unknown>;
    const title = optionalText(action.title, 300);
    const sourceTitle = optionalText(action.sourceTitle, 300);
    if (!title || !sourceTitle) return [];
    return [{
      title,
      owner: optionalText(action.owner, 120) ?? null,
      dueDate: optionalText(action.dueDate, 120) ?? null,
      sourceTitle,
    }];
  }).slice(0, 10) : [];
  const meetings = Array.isArray(value.meetings) ? value.meetings.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const meeting = item as Record<string, unknown>;
    const title = optionalText(meeting.title, 300);
    const when = optionalText(meeting.when, 120);
    const sourceTitle = optionalText(meeting.sourceTitle, 300);
    if (!title || !when || !sourceTitle) return [];
    return [{
      title,
      when,
      participants: stringArray(meeting.participants, 20, 120),
      sourceTitle,
    }];
  }).slice(0, 10) : [];
  const sourceDocuments = Array.isArray(value.sourceDocuments) ? value.sourceDocuments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const documentId = optionalText(source.documentId, 200);
    const title = optionalText(source.title, 300);
    const updatedAt = optionalText(source.updatedAt, 40);
    if (!documentId || !title || !updatedAt) return [];
    return [{
      documentId,
      title,
      version: typeof source.version === "number" && Number.isInteger(source.version) ? source.version : 0,
      updatedAt,
    }];
  }).slice(0, 20) : [];
  if (!overview && !nextSteps.length && !entities.length && !actionItems.length && !meetings.length && !sourceDocuments.length) {
    return undefined;
  }
  const generatedAt = optionalText(value.generatedAt, 40);
  return {
    ...(generatedAt ? { generatedAt } : {}),
    overview,
    nextSteps,
    entities,
    actionItems,
    meetings,
    sourceDocuments,
  };
}

function roomReference(row: typeof contextRooms.$inferSelect): AgentRoomReference {
  const brief = row.data.brief && typeof row.data.brief === "object"
    ? row.data.brief as Record<string, unknown>
    : {};
  const background = optionalText(brief.background, 2_000);
  const goal = optionalText(brief.goal, 2_000);
  const generatedContext = row.data.generatedContext && typeof row.data.generatedContext === "object"
    ? row.data.generatedContext as Record<string, unknown>
    : {};
  const status = optionalText(generatedContext.status, 500) ?? optionalText(brief.status, 500);
  const contextSummary = roomContextSummary(generatedContext);
  return {
    id: row.id,
    title: row.title,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(background ? { background } : {}),
    ...(goal ? { goal } : {}),
    ...(status ? { status } : {}),
    ...(contextSummary ? { contextSummary } : {}),
  };
}

function canonicalItem(item: ContextRoomSnapshotItem): ContextRoomSnapshotItem {
  const id = item.id.trim();
  const title = item.title.trim();
  const kind = item.kind?.trim();
  return {
    id,
    title,
    ...(kind ? { kind } : {}),
    data: {
      ...item.data,
      id,
      title,
      ...(kind ? { kind } : {}),
    },
  };
}

function newRoomData(input: {
  id: string;
  title: string;
  description: string;
  enrichment: ContextRoomEnrichment;
  now: string;
}): Record<string, unknown> {
  const { enrichment } = input;
  const people = enrichment.entities
    .filter((entity) => entity.kind === "人物")
    .map((entity) => ({
      name: entity.name,
      role: entity.description || "关联人物",
      avatar: entity.name.slice(0, 1).toUpperCase(),
    }));
  const memoryItems = enrichment.facts.map((fact, index) => ({
    id: `${input.id}-memory-${index + 1}`,
    content: fact.content,
    type: fact.type,
    status: "已确认",
    sources: [{ type: "记忆", name: "创建时记忆召回" }],
  }));
  return {
    id: input.id,
    title: input.title,
    kind: enrichment.kind,
    icon: enrichment.kind,
    tone: "zinc",
    status: "进行中",
    starred: false,
    updatedAt: input.now,
    lastViewed: "刚刚",
    roomCode: input.id.toUpperCase(),
    origin: "user",
    creationDescription: input.description,
    brief: {
      background: enrichment.background,
      goal: enrichment.goal,
      status: enrichment.status,
      risks: [],
      decisions: [],
    },
    generatedContext: {
      roomId: input.id,
      generatedAt: input.now,
      sourceDocuments: [],
      overview: enrichment.overview,
      status: enrichment.status,
      nextSteps: enrichment.nextSteps,
      entities: enrichment.entities,
      actionItems: [],
      meetings: [],
    },
    stats: { docs: 0, mails: 0, meetings: 0, events: 0, memories: memoryItems.length, tasks: 0 },
    riskCount: 0,
    pendingMemoryCount: 0,
    people,
    timeline: [{
      time: input.now,
      title: "Room 已创建",
      description: "基于创建描述初始化，等待资料补充。",
      kind: "info",
      generated: true,
    }],
    materials: [],
    actionItems: [],
    graphEdges: enrichment.entities.map((entity) => ({
      from: input.title,
      to: entity.name,
      relation: entity.kind,
    })),
    pendingMemoryItems: [],
    memoryItems,
    fileItems: [],
    nextReverseRecall: "暂无",
    cloudDoc: {
      workspaceId: "local-placeholder",
      docId: `local-${input.id}`,
      title: input.title,
    },
  };
}

export class ContextRoomService {
  private readonly pendingCreations = new Map<string, Promise<CreateContextRoomResult>>();
  private duplicateService: RoomDuplicateService | null = null;
  private roomAgent: RoomAgentDispatcher | null = null;
  private roomAgentLogger: ((bindings: Record<string, unknown>, message: string) => void) | null = null;

  constructor(
    private readonly db: GatewayDatabase,
  ) {}

  setDuplicateService(service: RoomDuplicateService): void {
    this.duplicateService = service;
  }

  /**
   * 注入 Context Room 子 Agent 调度器（create-server 在 SubagentOrchestrator
   * 就绪后调用；晚于本服务构造，故用 setter）。
   */
  setRoomAgentDispatcher(
    dispatcher: RoomAgentDispatcher | null,
    logger?: (bindings: Record<string, unknown>, message: string) => void,
  ): void {
    this.roomAgent = dispatcher;
    this.roomAgentLogger = logger ?? null;
  }

  getSnapshot(): ContextRoomSnapshot {
    const rows = this.db.select().from(contextRooms)
      .orderBy(asc(contextRooms.position), asc(contextRooms.createdAt))
      .all();
    const updatedAt = rows.reduce<Date | null>((latest, room) => (
      !latest || room.updatedAt > latest ? room.updatedAt : latest
    ), null);
    return {
      rooms: rows.filter((room) => room.deletedAt === null && room.lifecycle === "active").map(snapshotItem),
      deletedRooms: rows.filter((room) => room.deletedAt !== null && room.lifecycle === "active").map(snapshotItem),
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  listReferences(): AgentRoomReference[] {
    return this.db.select().from(contextRooms)
      .where(and(isNull(contextRooms.deletedAt), eq(contextRooms.lifecycle, "active")))
      .orderBy(asc(contextRooms.position), asc(contextRooms.createdAt))
      .all()
      .map(roomReference);
  }

  resolveRoomId(roomId: string): string | null {
    let current = roomId.trim();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const room = this.db.select({
        id: contextRooms.id,
        lifecycle: contextRooms.lifecycle,
        mergedIntoRoomId: contextRooms.mergedIntoRoomId,
        deletedAt: contextRooms.deletedAt,
      }).from(contextRooms).where(eq(contextRooms.id, current)).get();
      if (!room || room.deletedAt) return null;
      if (room.lifecycle === "active") return room.id;
      if (room.lifecycle !== "merged" || !room.mergedIntoRoomId) return null;
      current = room.mergedIntoRoomId;
    }
    return null;
  }

  isActive(roomId: string): boolean {
    const room = this.db.select({ deletedAt: contextRooms.deletedAt, lifecycle: contextRooms.lifecycle })
      .from(contextRooms)
      .where(eq(contextRooms.id, roomId))
      .get();
    return Boolean(room && room.deletedAt === null && room.lifecycle === "active");
  }

  /**
   * Room 关联的应用实体：room_entity_mentions 按实体聚合，状态直读 entities 表。
   * 不缓存——便宜 SQL，每次返回 DB 真值（展示与实际状态一致）。
   */
  roomAppliedEntities(roomId: string): RoomAppliedEntitiesResult {
    const resolved = this.resolveRoomId(roomId);
    if (!resolved) throw new Error("context_room_not_found");
    const rows = this.db.select({ entity: entitiesTable, mention: roomEntityMentions })
      .from(roomEntityMentions)
      .innerJoin(entitiesTable, eq(roomEntityMentions.entityId, entitiesTable.id))
      .where(eq(roomEntityMentions.roomId, resolved))
      .all();
    const grouped = new Map<string, {
      entity: typeof entitiesTable.$inferSelect;
      sources: Set<string>;
      sourceKinds: Set<string>;
      salience: number;
      lastMentionAt: Date | null;
      evidence: string | null;
      evidenceAt: Date | null;
    }>();
    for (const { entity, mention } of rows) {
      const current = grouped.get(entity.id) ?? {
        entity,
        sources: new Set<string>(),
        sourceKinds: new Set<string>(),
        salience: 0,
        lastMentionAt: null,
        evidence: null,
        evidenceAt: null,
      };
      current.sources.add(`${mention.sourceKind}:${mention.sourceId}`);
      current.sourceKinds.add(mention.sourceKind);
      current.salience = Math.max(current.salience, mention.salience);
      if (!current.lastMentionAt || mention.updatedAt > current.lastMentionAt) {
        current.lastMentionAt = mention.updatedAt;
      }
      if (mention.evidence && (!current.evidenceAt || mention.updatedAt >= current.evidenceAt)) {
        current.evidence = mention.evidence;
        current.evidenceAt = mention.updatedAt;
      }
      grouped.set(entity.id, current);
    }
    const entities: RoomAppliedEntity[] = [...grouped.values()].map((item) => ({
      entityId: item.entity.id,
      name: item.entity.name,
      kind: item.entity.kind,
      status: item.entity.status as RoomAppliedEntityStatus,
      summary: item.entity.summary,
      aliases: item.entity.aliases ?? [],
      linkedRoomId: item.entity.roomId ?? null,
      mentionCount: item.sources.size,
      sourceKinds: [...item.sourceKinds],
      salience: item.salience,
      lastMentionAt: item.lastMentionAt?.toISOString() ?? null,
      evidence: item.evidence,
    })).sort((a, b) => (
      b.mentionCount - a.mentionCount
      || b.salience - a.salience
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )).slice(0, 100);
    return { roomId: resolved, entities, updatedAt: new Date().toISOString() };
  }

  async createRoom(input: CreateContextRoomInput): Promise<CreateContextRoomResult> {
    const title = optionalText(input.title, 120);
    if (!title) throw new Error("context_room_title_required");
    const description = optionalText(input.description, 2_000);
    if (!description) throw new Error("context_room_description_required");
    const duplicateOverrideAccepted = await this.duplicateService?.assertCreationAllowed({
      title,
      description,
      ...(input.duplicateOverrideToken ? { duplicateOverrideToken: input.duplicateOverrideToken } : {}),
    }) ?? false;
    const titleKey = title.toLocaleLowerCase();
    const existing = this.db.select().from(contextRooms)
      .where(and(isNull(contextRooms.deletedAt), eq(contextRooms.lifecycle, "active")))
      .all()
      .find((room) => room.title.trim().toLocaleLowerCase() === titleKey);
    if (existing && !duplicateOverrideAccepted) return { room: snapshotItem(existing), created: false };

    const pending = this.pendingCreations.get(titleKey);
    if (pending) return pending.then((result) => ({ ...result, created: false }));
    const creation = this.createNewRoom(title, description);
    this.pendingCreations.set(titleKey, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingCreations.get(titleKey) === creation) this.pendingCreations.delete(titleKey);
    }
  }

  private async createNewRoom(title: string, description: string): Promise<CreateContextRoomResult> {
    const id = `room-${randomUUID()}`;
    // 先以 fallback 内容立即创建（创建对话框零等待），再异步调度子 Agent 整理；
    // 整理失败时保留 fallback，与旧 enricher 失败降级行为一致。
    const enrichment = fallbackContextRoomEnrichment({ title, description });
    const now = new Date();
    const position = this.db.select({ id: contextRooms.id }).from(contextRooms)
      .where(isNull(contextRooms.deletedAt))
      .all().length;
    const inserted = this.db.insert(contextRooms).values({
      id,
      title,
      kind: enrichment.kind,
      data: {
        ...newRoomData({ id, title, description, enrichment, now: now.toISOString() }),
        roomAgentTask: "room-enrich",
      },
      position,
      lifecycle: "active",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    this.dispatchRoomEnrichment(id, title, description);
    this.duplicateService?.requestRebuild();
    return { room: snapshotItem(inserted), created: true };
  }

  private dispatchRoomEnrichment(roomId: string, title: string, description: string): void {
    if (!this.roomAgent) return;
    void this.roomAgent.dispatch({
      task: "room-enrich",
      taskInput: { roomId, title, description },
      idempotencyKey: `room-enrich:${roomId}`,
    }).then((invocation) => {
      if (invocation.status !== "completed") {
        this.abandonRoomEnrichment(roomId, "context room enrichment invocation did not complete", {
          status: invocation.status,
        });
        return;
      }
      const content = invocationText(invocation);
      if (!content) return;
      const enrichment = parseContextRoomEnrichment(
        content,
        fallbackContextRoomEnrichment({ title, description }),
      );
      this.applyAgentEnrichment(roomId, enrichment);
    }).catch((error: unknown) => {
      this.roomAgentLogger?.(
        { roomId, error: error instanceof Error ? error.message : String(error) },
        "context room enrichment dispatch failed; keeping fallback content",
      );
      this.abandonRoomEnrichment(roomId, "context room enrichment dispatch failed");
    });
  }

  /** 整理失败时清除标记，Room 保留 fallback 内容且不再接受迟到的回写。 */
  private abandonRoomEnrichment(roomId: string, reason: string, bindings: Record<string, unknown> = {}): void {
    this.roomAgentLogger?.({ roomId, ...bindings }, reason);
    const row = this.db.select({ data: contextRooms.data }).from(contextRooms)
      .where(eq(contextRooms.id, roomId)).get();
    if (!row || row.data.roomAgentTask !== "room-enrich") return;
    const data = { ...row.data } as Record<string, unknown>;
    delete data.roomAgentTask;
    this.db.update(contextRooms).set({ data }).where(eq(contextRooms.id, roomId)).run();
  }

  /**
   * 将子 Agent 整理结果回写到刚创建的 Room。仅当 data.roomAgentTask 标记仍为
   * room-enrich 时生效（用户尚未通过快照保存改写这些字段）；回写后清除标记。
   */
  applyAgentEnrichment(roomId: string, enrichment: ContextRoomEnrichment): boolean {
    const row = this.db.select().from(contextRooms)
      .where(and(eq(contextRooms.id, roomId), isNull(contextRooms.deletedAt))).get();
    if (!row || row.data.roomAgentTask !== "room-enrich") return false;
    const now = new Date().toISOString();
    const data = { ...row.data } as Record<string, unknown>;
    const brief = isRecord(data.brief) ? { ...data.brief } : {};
    const generatedContext = isRecord(data.generatedContext) ? { ...data.generatedContext } : {};
    const memoryItems = Array.isArray(data.memoryItems) ? [...data.memoryItems] : [];
    const people = Array.isArray(data.people) ? [...data.people] : [];
    const knownPeople = new Set(people.flatMap((person) => (
      isRecord(person) && typeof person.name === "string" ? [person.name] : []
    )));
    for (const entity of enrichment.entities) {
      if (entity.kind !== "人物" || knownPeople.has(entity.name)) continue;
      knownPeople.add(entity.name);
      people.push({
        name: entity.name,
        role: entity.description || "关联人物",
        avatar: entity.name.slice(0, 1).toUpperCase(),
      });
    }
    const knownMemories = new Set(memoryItems.flatMap((item) => (
      isRecord(item) && typeof item.content === "string" ? [item.content] : []
    )));
    for (const [index, fact] of enrichment.facts.entries()) {
      if (knownMemories.has(fact.content)) continue;
      knownMemories.add(fact.content);
      memoryItems.push({
        id: `${roomId}-memory-${memoryItems.length + index + 1}`,
        content: fact.content,
        type: fact.type,
        status: "已确认",
        sources: [{ type: "记忆", name: "创建时记忆召回" }],
      });
    }
    const timeline = Array.isArray(data.timeline) ? [...data.timeline] : [];
    timeline.push({
      time: now,
      title: "Room 创建整理完成",
      description: "基于创建描述与记忆召回生成 Room 初始信息。",
      kind: "done",
      generated: true,
    });
    Object.assign(data, {
      kind: enrichment.kind,
      icon: enrichment.kind,
      brief: {
        ...brief,
        background: enrichment.background,
        goal: enrichment.goal,
        status: enrichment.status,
      },
      generatedContext: {
        ...generatedContext,
        generatedAt: now,
        overview: enrichment.overview,
        status: enrichment.status,
        nextSteps: enrichment.nextSteps,
        entities: enrichment.entities,
      },
      people,
      memoryItems,
      timeline,
      stats: {
        ...(isRecord(data.stats) ? data.stats : {}),
        memories: memoryItems.length,
      },
      graphEdges: enrichment.entities.map((entity) => ({
        from: row.title,
        to: entity.name,
        relation: entity.kind,
      })),
      updatedAt: now,
    });
    delete data.roomAgentTask;
    this.db.update(contextRooms).set({
      kind: enrichment.kind,
      data,
      updatedAt: new Date(),
    }).where(eq(contextRooms.id, roomId)).run();
    return true;
  }

  /** 调度子 Agent 再生成 Room 简报并回写；返回更新后的 Room 快照。 */
  async refreshBrief(roomId: string): Promise<ContextRoomSnapshotItem> {
    const resolved = this.resolveRoomId(roomId);
    if (!resolved) throw new Error("context_room_not_found");
    if (!this.roomAgent) throw new Error("context_room_agent_not_configured");
    const row = this.db.select().from(contextRooms)
      .where(eq(contextRooms.id, resolved)).get();
    if (!row) throw new Error("context_room_not_found");
    const brief = row.data.brief && typeof row.data.brief === "object" && !Array.isArray(row.data.brief)
      ? row.data.brief as Record<string, unknown>
      : {};
    const invocation = await this.roomAgent.dispatch({
      task: "brief-refresh",
      taskInput: {
        roomId: resolved,
        roomTitle: row.title,
        currentBrief: {
          background: typeof brief.background === "string" ? brief.background : "",
          goal: typeof brief.goal === "string" ? brief.goal : "",
          status: typeof brief.status === "string" ? brief.status : "",
          risks: Array.isArray(brief.risks) ? brief.risks : [],
          decisions: Array.isArray(brief.decisions) ? brief.decisions : [],
        },
      },
      idempotencyKey: `brief-refresh:${resolved}:${row.updatedAt.getTime()}`,
    });
    const content = invocation.status === "completed" ? invocationText(invocation) : null;
    if (!content) throw new Error("context_room_brief_refresh_failed");
    const parsed = parseBriefRefresh(content);
    const now = new Date();
    const data = { ...row.data } as Record<string, unknown>;
    data.brief = {
      ...(row.data.brief && typeof row.data.brief === "object" && !Array.isArray(row.data.brief)
        ? row.data.brief as Record<string, unknown>
        : {}),
      ...(parsed.background ? { background: parsed.background } : {}),
      ...(parsed.goal ? { goal: parsed.goal } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      risks: parsed.risks,
      decisions: parsed.decisions,
    };
    data.updatedAt = now.toISOString();
    const updated = this.db.update(contextRooms).set({ data, updatedAt: now })
      .where(eq(contextRooms.id, resolved)).returning().get();
    return snapshotItem(updated ?? row);
  }

  saveSnapshot(input: SaveContextRoomSnapshotInput): ContextRoomSnapshot {
    const active = input.rooms.map(canonicalItem);
    const deleted = input.deletedRooms.map(canonicalItem);
    if ([...active, ...deleted].some((room) => !room.id || !room.title)) {
      throw new Error("context_room_snapshot_has_invalid_room");
    }
    const ids = [...active, ...deleted].map((room) => room.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("context_room_snapshot_has_duplicate_ids");
    }

    const now = new Date();
    const protectedIds = new Set(this.db.select({ id: contextRooms.id, lifecycle: contextRooms.lifecycle })
      .from(contextRooms).all().filter((room) => room.lifecycle !== "active").map((room) => room.id));
    this.db.transaction((tx) => {
      if (ids.length === 0) {
        tx.delete(contextRooms).where(eq(contextRooms.lifecycle, "active")).run();
      } else {
        tx.delete(contextRooms).where(and(
          eq(contextRooms.lifecycle, "active"),
          notInArray(contextRooms.id, ids),
        )).run();
      }
      const upsert = (room: ContextRoomSnapshotItem, position: number, deletedAt: Date | null) => {
        if (protectedIds.has(room.id)) return;
        const current = this.db.select({ data: contextRooms.data }).from(contextRooms)
          .where(eq(contextRooms.id, room.id)).get();
        const currentMergeAt = optionalText(current?.data.lastMergeAt, 40);
        const incomingMergeAt = optionalText(room.data.lastMergeAt, 40);
        if (currentMergeAt && currentMergeAt !== incomingMergeAt) return;
        tx.insert(contextRooms).values({
          id: room.id,
          title: room.title,
          kind: room.kind ?? null,
          data: room.data,
          position,
          lifecycle: "active",
          deletedAt,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: contextRooms.id,
          set: {
            title: room.title,
            kind: room.kind ?? null,
            data: room.data,
            position,
            lifecycle: "active",
            deletedAt,
            updatedAt: now,
          },
        }).run();
      };
      active.forEach((room, position) => upsert(room, position, null));
      deleted.forEach((room, position) => upsert(room, position, now));
    });
    this.duplicateService?.requestRebuild();
    return this.getSnapshot();
  }
}
