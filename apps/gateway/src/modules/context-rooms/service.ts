import type {
  AgentRoomReference,
  ContextRoomSnapshot,
  ContextRoomSnapshotItem,
  SaveContextRoomSnapshotInput,
} from "@nxcore/agent-contract";
import { asc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { contextRooms } from "../../infrastructure/database/schema.js";

function snapshotItem(row: typeof contextRooms.$inferSelect): ContextRoomSnapshotItem {
  return {
    id: row.id,
    title: row.title,
    ...(row.kind ? { kind: row.kind } : {}),
    data: row.data,
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

export class ContextRoomService {
  constructor(private readonly db: GatewayDatabase) {}

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
    return this.db.select({
      id: contextRooms.id,
      title: contextRooms.title,
      kind: contextRooms.kind,
    }).from(contextRooms)
      .where(isNull(contextRooms.deletedAt))
      .orderBy(asc(contextRooms.position), asc(contextRooms.createdAt))
      .all()
      .map((room) => ({
        id: room.id,
        title: room.title,
        ...(room.kind ? { kind: room.kind } : {}),
      }));
  }

  isActive(roomId: string): boolean {
    const room = this.db.select({ deletedAt: contextRooms.deletedAt })
      .from(contextRooms)
      .where(eq(contextRooms.id, roomId))
      .get();
    return Boolean(room && room.deletedAt === null);
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
