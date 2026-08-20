import { randomUUID } from "node:crypto";
import type {
  AgentRoomReference,
  ContextRoomSnapshot,
  ContextRoomSnapshotItem,
  CreateContextRoomInput,
  CreateContextRoomResult,
  SaveContextRoomSnapshotInput,
} from "@nxcore/agent-contract";
import { asc, eq, isNull, notInArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { contextRooms } from "../../infrastructure/database/schema.js";
import {
  fallbackContextRoomEnrichment,
  type ContextRoomEnricher,
  type ContextRoomEnrichment,
} from "./agent-enricher.js";

function snapshotItem(row: typeof contextRooms.$inferSelect): ContextRoomSnapshotItem {
  return {
    ...roomReference(row),
    data: row.data,
  };
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
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
    timeline: [],
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

  constructor(
    private readonly db: GatewayDatabase,
    private readonly enricher?: ContextRoomEnricher,
  ) {}

  getSnapshot(): ContextRoomSnapshot {
    const rows = this.db.select().from(contextRooms)
      .orderBy(asc(contextRooms.position), asc(contextRooms.createdAt))
      .all();
    const updatedAt = rows.reduce<Date | null>((latest, room) => (
      !latest || room.updatedAt > latest ? room.updatedAt : latest
    ), null);
    return {
      rooms: rows.filter((room) => room.deletedAt === null).map(snapshotItem),
      deletedRooms: rows.filter((room) => room.deletedAt !== null).map(snapshotItem),
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  listReferences(): AgentRoomReference[] {
    return this.db.select().from(contextRooms)
      .where(isNull(contextRooms.deletedAt))
      .orderBy(asc(contextRooms.position), asc(contextRooms.createdAt))
      .all()
      .map(roomReference);
  }

  isActive(roomId: string): boolean {
    const room = this.db.select({ deletedAt: contextRooms.deletedAt })
      .from(contextRooms)
      .where(eq(contextRooms.id, roomId))
      .get();
    return Boolean(room && room.deletedAt === null);
  }

  async createRoom(input: CreateContextRoomInput): Promise<CreateContextRoomResult> {
    const title = optionalText(input.title, 120);
    if (!title) throw new Error("context_room_title_required");
    const description = optionalText(input.description, 2_000);
    if (!description) throw new Error("context_room_description_required");
    const titleKey = title.toLocaleLowerCase();
    const existing = this.db.select().from(contextRooms)
      .where(isNull(contextRooms.deletedAt))
      .all()
      .find((room) => room.title.trim().toLocaleLowerCase() === titleKey);
    if (existing) return { room: snapshotItem(existing), created: false };

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
    const enrichment = await (this.enricher?.enrich({ title, description })
      ?? Promise.resolve(fallbackContextRoomEnrichment({ title, description })));
    const now = new Date();
    const position = this.db.select({ id: contextRooms.id }).from(contextRooms)
      .where(isNull(contextRooms.deletedAt))
      .all().length;
    const inserted = this.db.insert(contextRooms).values({
      id,
      title,
      kind: enrichment.kind,
      data: newRoomData({ id, title, description, enrichment, now: now.toISOString() }),
      position,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return { room: snapshotItem(inserted), created: true };
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
    this.db.transaction((tx) => {
      if (ids.length === 0) {
        tx.delete(contextRooms).run();
      } else {
        tx.delete(contextRooms).where(notInArray(contextRooms.id, ids)).run();
      }
      const upsert = (room: ContextRoomSnapshotItem, position: number, deletedAt: Date | null) => {
        tx.insert(contextRooms).values({
          id: room.id,
          title: room.title,
          kind: room.kind ?? null,
          data: room.data,
          position,
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
            deletedAt,
            updatedAt: now,
          },
        }).run();
      };
      active.forEach((room, position) => upsert(room, position, null));
      deleted.forEach((room, position) => upsert(room, position, now));
    });
    return this.getSnapshot();
  }
}
