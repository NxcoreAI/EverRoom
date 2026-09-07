import { dispatchRoomMemoryChanged } from '../roomMemoryChange'
import type { ContextRoomMemoryItem, ContextRoomRecord } from './types'

type RoomRecordMutator = (current: ContextRoomRecord) => ContextRoomRecord

function setMemoryItemStatus(item: ContextRoomMemoryItem, status: string): RoomRecordMutator {
  return (current) => ({
    ...current,
    // map-or-append：归属条目不在 raw 快照里（合并视图读时物化），禁用落 shadow 时追加。
    memoryItems: current.memoryItems.some((candidate) => candidate.id === item.id)
      ? current.memoryItems.map((candidate) => (
        candidate.id === item.id ? { ...candidate, status } : candidate
      ))
      : [...current.memoryItems, { ...item, attributed: undefined, status }],
  })
}

/**
 * 禁用 Room 记忆条目。归属条目（attributed）联动清除绑定（解绑+压制，agent 注入
 * 随之停止）后落已禁用 shadow（块索引标记仍可解析）；legacy 条目仅翻状态。
 * 归属联动失败时抛出且不写状态（避免“面板已禁用但 agent 仍注入”的假象）。
 */
export async function disableRoomMemoryItem(item: ContextRoomMemoryItem): Promise<RoomRecordMutator> {
  if (item.attributed && item.memoryId) {
    await window.nxcore!.memory.setAtomicRoom(item.memoryId, null)
    dispatchRoomMemoryChanged()
    return setMemoryItemStatus(item, '已禁用')
  }
  return setMemoryItemStatus(item, '已禁用')
}

/**
 * 启用已禁用条目。带 memoryId 的（禁用 shadow）重新绑定（压制行随手动重绑失效，
 * 记忆已删则 gateway 404 抛出）；legacy 条目仅翻状态。
 */
export async function enableRoomMemoryItem(
  roomId: string,
  item: ContextRoomMemoryItem,
): Promise<RoomRecordMutator> {
  if (item.memoryId) {
    await window.nxcore!.memory.setAtomicRoom(item.memoryId, roomId, {
      content: item.content,
      type: item.type,
      memoryUpdatedAt: new Date().toISOString(),
    })
    dispatchRoomMemoryChanged()
    return setMemoryItemStatus(item, '已确认')
  }
  return setMemoryItemStatus(item, '已确认')
}
