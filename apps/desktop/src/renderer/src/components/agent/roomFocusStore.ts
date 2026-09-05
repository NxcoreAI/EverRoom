/**
 * 房间聚焦偏好（per-Room 持久）：每个 Context Room 记住各自的聚焦开关，
 * 回到房间恢复上次选择、切到其他房间互不影响。localStorage 不可用时
 * （隐私模式/配额）静默降级为仅会话内状态，不抛错。
 */
const STORAGE_KEY = 'nexcore:agent:room-focus:v1'

function readMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {}
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 存储失败只损失持久性，开关本身仍按会话内状态工作。
  }
}
