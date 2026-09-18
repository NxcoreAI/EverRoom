import { BOARD_SUBTABS, BOARD_TABS, type BoardId, type BoardSubtab } from './components/RoomIconSidebar'

/**
 * Room 工作现场持久化：记住每个 Room 上次所在的板块、页签和选中对象，
 * 应用重启后重进 Room 恢复现场（滚动位置等轻量状态不在此范围）。
 */
const STORAGE_KEY = 'nxcore-ce:room-pane:v1'
const MAX_ROOMS = 200

export interface RoomWorkspaceState {
  board: BoardId
  subtab?: BoardSubtab
  selectedResourceId?: string
  /** 思路伴随区收起（打开云文档时的三栏布局记忆）。 */
  thoughtsCompanionCollapsed?: boolean
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

function loadMap(): RoomWorkspaceStateMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as RoomWorkspaceStateMap
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
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent.map((id) => [id, map[id]]))))
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
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
    ...(candidate.thoughtsCompanionCollapsed === true ? { thoughtsCompanionCollapsed: true } : {}),
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
    ...(patch.thoughtsCompanionCollapsed !== undefined || current?.thoughtsCompanionCollapsed !== undefined
      ? { thoughtsCompanionCollapsed: patch.thoughtsCompanionCollapsed ?? current?.thoughtsCompanionCollapsed ?? false }
      : {}),
    savedAt: Date.now(),
  }
  saveMap({ ...map, [roomId]: next })
}
