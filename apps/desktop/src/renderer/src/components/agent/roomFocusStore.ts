import { createVersionedLocalStorageStore } from '@nxcore/migration-kit/local'

/**
 * 房间聚焦偏好（per-Room 持久）：每个 Context Room 记住各自的聚焦开关，
 * 回到房间恢复上次选择、切到其他房间互不影响。localStorage 不可用时
 * （隐私模式/配额）静默降级为仅会话内状态，不抛错。
 */
const KEY_BASE = 'nexcore:agent:room-focus'
const KEY_VERSION = 1

function createStore() {
  return createVersionedLocalStorageStore<Record<string, boolean>>({
    keyBase: KEY_BASE,
    version: KEY_VERSION,
    adoptBaseline: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const output: Record<string, boolean> = {}
      for (const [roomId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === true) output[roomId] = true
      }
      return output
    },
    fallback: {},
    migrations: [],
  })
}

function readMap(): Record<string, boolean> {
  try {
    return createStore().get()
  } catch {
    return {}
  }
}

export function loadRoomFocus(roomId: string): boolean {
  return readMap()[roomId] === true
}

export function saveRoomFocus(roomId: string, enabled: boolean): void {
  try {
    const map = readMap()
    if (enabled) map[roomId] = true
    else delete map[roomId]
    createStore().set(map)
  } catch {
    // 存储失败只损失持久性，开关本身仍按会话内状态工作。
  }
}
