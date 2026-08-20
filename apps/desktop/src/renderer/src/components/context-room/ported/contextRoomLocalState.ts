import type {
  ContextRoomSnapshot,
  ContextRoomSnapshotItem,
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract';

import type { ContextRoomRecord } from './types';
import { removeDemoContextRooms } from './demoContextRooms';

export const CONTEXT_ROOM_LOCAL_STATE_KEY = 'nexcore:context-room:state:v1';

export interface ContextRoomLocalState {
  rooms: ContextRoomRecord[];
  deletedRooms: ContextRoomRecord[];
}

export function removeDemoContextRoomState(
  state: ContextRoomLocalState,
): ContextRoomLocalState {
  return {
    rooms: removeDemoContextRooms(state.rooms),
    deletedRooms: removeDemoContextRooms(state.deletedRooms),
  };
}

const CONTEXT_ROOM_KINDS = new Set(['人物', '项目', '主题', '长期目标', '议题', '事件']);

const LEGACY_BRAND_REPLACEMENTS = [
  ['极核 NEXCORE HUB', 'Everroom HUB'],
  ['NEXCORE HUB', 'Everroom HUB'],
  ['极核开源', 'Everroom 开源'],
  ['极核 PC', 'Everroom PC'],
  ['NexCore 系统通知', 'Everroom 系统通知'],
  ['@nexcore.local', '@everroom.local'],
] as const;

function migrateLegacyBrandText(value: unknown): unknown {
  if (typeof value === 'string') {
    return LEGACY_BRAND_REPLACEMENTS.reduce(
      (text, [legacy, current]) => text.replaceAll(legacy, current),
      value,
    );
  }
  if (Array.isArray(value)) return value.map(migrateLegacyBrandText);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, migrateLegacyBrandText(item)]),
  );
}

export function isContextRoomRecord(value: unknown): value is ContextRoomRecord {
  if (!value || typeof value !== 'object') return false;
  const room = value as Partial<ContextRoomRecord>;
  return (
    typeof room.id === 'string' &&
    Boolean(room.id.trim()) &&
    typeof room.title === 'string' &&
    Boolean(room.title.trim()) &&
    typeof room.kind === 'string' &&
    CONTEXT_ROOM_KINDS.has(room.kind) &&
    Boolean(room.brief) &&
    Boolean(room.stats) &&
    Array.isArray(room.materials) &&
    Array.isArray(room.fileItems)
  );
}

function mergeStoredRoom(stored: ContextRoomRecord, fallback?: ContextRoomRecord) {
  if (!fallback) return stored;
  const mergeItems = <T extends { id: string }>(defaults: T[], saved: T[]) => [
    ...saved.map((item) => ({
      ...defaults.find((candidate) => candidate.id === item.id),
      ...item,
    })),
    ...defaults.filter((item) => !saved.some((candidate) => candidate.id === item.id)),
  ];
  return {
    ...fallback,
    ...stored,
    materials: mergeItems(fallback.materials, stored.materials).map((material) => {
      const defaultMaterial = fallback.materials.find((item) => item.id === material.id);
      return {
        ...material,
        meetingActions: defaultMaterial?.meetingActions
          ? mergeItems(defaultMaterial.meetingActions, material.meetingActions ?? [])
          : material.meetingActions,
      };
    }),
    actionItems: mergeItems(fallback.actionItems, stored.actionItems),
    memoryItems: mergeItems(fallback.memoryItems, stored.memoryItems),
    fileItems: mergeItems(fallback.fileItems, stored.fileItems),
  };
}

function migrateLegacyUpdatedAt(room: ContextRoomRecord, fallbackUpdatedAt: string): ContextRoomRecord {
  if (room.updatedAt || room.lastViewed !== '刚刚') return room;
  return { ...room, updatedAt: fallbackUpdatedAt };
}

function migrateLegacyGeneratedContext(room: ContextRoomRecord): ContextRoomRecord {
  if (!room.generatedContext || typeof room.generatedContext.overview === 'string') return room;
  return {
    ...room,
    generatedContext: {
      ...room.generatedContext,
      overview: '',
    },
  };
}

function migrateContextRoomRecord(
  room: ContextRoomRecord,
  fallbackUpdatedAt: string,
): ContextRoomRecord {
  return migrateLegacyUpdatedAt(migrateLegacyGeneratedContext(room), fallbackUpdatedAt);
}

export function loadContextRoomLocalState(fallback: ContextRoomRecord[]): ContextRoomLocalState {
  if (typeof window === 'undefined') {
    return removeDemoContextRoomState({ rooms: fallback, deletedRooms: [] });
  }

  try {
    const raw = window.localStorage.getItem(CONTEXT_ROOM_LOCAL_STATE_KEY);
    if (!raw) return removeDemoContextRoomState({ rooms: fallback, deletedRooms: [] });
    const parsed = migrateLegacyBrandText(JSON.parse(raw)) as Partial<ContextRoomLocalState>;
    if (!Array.isArray(parsed.rooms) || !parsed.rooms.every(isContextRoomRecord)) {
      return removeDemoContextRoomState({ rooms: fallback, deletedRooms: [] });
    }
    const deletedRooms = Array.isArray(parsed.deletedRooms)
      ? parsed.deletedRooms.filter(isContextRoomRecord)
      : [];
    const fallbackById = new Map(fallback.map((room) => [room.id, room]));
    const fallbackUpdatedAt = new Date().toISOString();
    return removeDemoContextRoomState({
      rooms: parsed.rooms.map((room) => migrateContextRoomRecord(
        mergeStoredRoom(room, fallbackById.get(room.id)),
        fallbackUpdatedAt,
      )),
      deletedRooms: deletedRooms.map((room) => migrateContextRoomRecord(
        mergeStoredRoom(room, fallbackById.get(room.id)),
        fallbackUpdatedAt,
      )),
    });
  } catch {
    return removeDemoContextRoomState({ rooms: fallback, deletedRooms: [] });
  }
}

function snapshotItem(room: ContextRoomRecord): ContextRoomSnapshotItem {
  return {
    id: room.id,
    title: room.title,
    kind: room.kind,
    data: { ...room },
  };
}

export function createContextRoomSnapshotInput(
  state: ContextRoomLocalState,
): SaveContextRoomSnapshotInput {
  return {
    rooms: state.rooms.map(snapshotItem),
    deletedRooms: state.deletedRooms.map(snapshotItem),
  };
}

export function isContextRoomSnapshotEmpty(snapshot: ContextRoomSnapshot): boolean {
  return snapshot.rooms.length === 0 && snapshot.deletedRooms.length === 0;
}

function roomFromSnapshotItem(
  item: ContextRoomSnapshotItem,
): ContextRoomRecord | null {
  const value = {
    ...item.data,
    id: item.id,
    title: item.title,
    ...(item.kind ? { kind: item.kind } : {}),
  };
  if (!isContextRoomRecord(value)) return null;
  return migrateLegacyGeneratedContext(value);
}

export function restoreContextRoomSnapshot(
  snapshot: ContextRoomSnapshot,
): ContextRoomLocalState | null {
  const rooms = snapshot.rooms.map((item) => roomFromSnapshotItem(item));
  const deletedRooms = snapshot.deletedRooms.map((item) => roomFromSnapshotItem(item));
  if (rooms.some((room) => room === null) || deletedRooms.some((room) => room === null)) return null;
  const allIds = [...rooms, ...deletedRooms].map((room) => room!.id);
  if (new Set(allIds).size !== allIds.length) return null;
  if (!snapshot.updatedAt) {
    return removeDemoContextRoomState({
      rooms: rooms as ContextRoomRecord[],
      deletedRooms: deletedRooms as ContextRoomRecord[],
    });
  }
  const fallbackUpdatedAt = snapshot.updatedAt;
  return removeDemoContextRoomState({
    rooms: (rooms as ContextRoomRecord[]).map((room) => migrateLegacyUpdatedAt(room, fallbackUpdatedAt)),
    deletedRooms: (deletedRooms as ContextRoomRecord[]).map((room) => migrateLegacyUpdatedAt(room, fallbackUpdatedAt)),
  });
}

export function saveContextRoomLocalState(state: ContextRoomLocalState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONTEXT_ROOM_LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory workspace usable when storage is unavailable or full.
  }
}
