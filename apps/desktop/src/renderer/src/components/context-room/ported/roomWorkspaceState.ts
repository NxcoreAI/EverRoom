import { createVersionedLocalStorageStore } from '@nxcore/migration-kit/local'

import { BOARD_SUBTABS, BOARD_TABS, type BoardId, type BoardSubtab } from './components/RoomIconSidebar'

/**
 * Room 工作现场持久化：记住每个 Room 上次所在的板块、页签和选中对象，
 * 应用重启后重进 Room 恢复现场（滚动位置等轻量状态不在此范围）。
 * v1 裸 map（R1 旧页签）在 v2 认领时逐项校验并迁移页签。
 */
const KEY_BASE = 'nxcore-ce:room-pane'
const KEY_VERSION = 2
const MAX_ROOMS = 200

export interface RoomWorkspaceState {
  board: BoardId
  subtab?: BoardSubtab
  selectedResourceId?: string
  savedAt: number
}

type RoomWorkspaceStateMap = Record<string, RoomWorkspaceState>

const BOARD_IDS: readonly BoardId[] = BOARD_TABS.map((tab) => tab.id)

/** R1 旧页签到 PRD 四视图的迁移：日程/任务并入待办，邮件并入资料。 */
const SUBTAB_MIGRATION: Partial<Record<string, BoardSubtab>> = {
  schedule: 'todo',
  tasks: 'todo',
  mails: 'materials',
}

function migrateSubtab(board: BoardId, subtab: unknown): BoardSubtab | undefined {
  if (typeof subtab !== 'string') return undefined
  const candidate: string = SUBTAB_MIGRATION[subtab] ?? subtab
  return BOARD_SUBTABS[board].some((tab) => tab.id === candidate) ? candidate as BoardSubtab : undefined
}

function createStore() {
  return createVersionedLocalStorageStore<RoomWorkspaceStateMap>({
    keyBase: KEY_BASE,
    version: KEY_VERSION,
    adoptBaseline: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const output: RoomWorkspaceStateMap = {}
      for (const [roomId, value] of Object.entries(raw as Record<string, unknown>)) {
        const normalized = normalizeState(roomId, value)
        if (normalized) output[roomId] = normalized
      }
      return output
    },
    fallback: {},
    migrations: [],
  })
}

function loadMap(): RoomWorkspaceStateMap {
  try {
    return createStore().get()
  } catch {
    return {}
  }
}

function saveMap(map: RoomWorkspaceStateMap): void {
  try {
    const roomIds = Object.keys(map)
    if (roomIds.length > MAX_ROOMS) {
      const recent = roomIds
        .sort((a, b) => (map[b]?.savedAt ?? 0) - (map[a]?.savedAt ?? 0))
        .slice(0, MAX_ROOMS)
      createStore().set(Object.fromEntries(recent.map((id) => [id, map[id]])))
      return
    }
    createStore().set(map)
  } catch {
    // 存储不可用（隐私模式/配额）时静默放弃，现场恢复是增强而非关键路径。
  }
}

function normalizeState(roomId: string, value: unknown): RoomWorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RoomWorkspaceState>
  if (!BOARD_IDS.includes(candidate.board as BoardId)) return null
  const board = candidate.board as BoardId
  const subtab = migrateSubtab(board, candidate.subtab)
  return {
    board,
    ...(subtab ? { subtab } : {}),
    ...(typeof candidate.selectedResourceId === 'string' ? { selectedResourceId: candidate.selectedResourceId } : {}),
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
  }
}

export function loadRoomWorkspaceState(roomId: string): RoomWorkspaceState | null {
  return normalizeState(roomId, loadMap()[roomId])
}

export function saveRoomWorkspaceState(roomId: string, patch: Partial<Omit<RoomWorkspaceState, 'savedAt'>>): void {
  const map = loadMap()
  const current = normalizeState(roomId, map[roomId])
  const next: RoomWorkspaceState = {
    board: (patch.board && BOARD_IDS.includes(patch.board) ? patch.board : current?.board) ?? 'work',
    ...(patch.subtab !== undefined ? { subtab: patch.subtab } : current?.subtab !== undefined ? { subtab: current.subtab } : {}),
    ...(patch.selectedResourceId !== undefined || current?.selectedResourceId !== undefined
      ? { selectedResourceId: patch.selectedResourceId ?? current?.selectedResourceId }
      : {}),
    savedAt: Date.now(),
  }
  saveMap({ ...map, [roomId]: next })
}
