import type { MemoryRoomMemoryItemDto } from '../../../../../shared/memory'

import type { ContextRoomMemoryItem, ContextRoomRecord } from './types'

/**
 * 快照记忆卡 + Room 归属记忆（gateway room_memory_attributions）的只读合并视图：
 * 建联链路（chip 预览/跳转、选择器、记忆卡）的数据源。快照已有项优先（保留用户
 * 确认/禁用状态），归因项统一视为已确认；只在展示层合并，不写回快照 state。
 */
export function mergeRoomMemoryItems(
  room: ContextRoomRecord,
  attributed: MemoryRoomMemoryItemDto[],
): ContextRoomRecord {
  if (attributed.length === 0) return room
  const known = new Set(room.memoryItems.map((item) => item.id))
  const additions = attributed
    .filter((item) => !known.has(item.memoryId))
    .map<ContextRoomMemoryItem>((item) => ({
      id: item.memoryId,
      content: item.content,
      type: item.type,
      status: '已确认',
    }))
  if (additions.length === 0) return room
  return { ...room, memoryItems: [...room.memoryItems, ...additions] }
}
