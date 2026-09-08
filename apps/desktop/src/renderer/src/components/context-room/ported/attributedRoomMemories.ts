import type { MemoryRoomMemoryItemDto } from '../../../../../shared/memory'

import type { ContextRoomMemoryItem, ContextRoomRecord } from './types'

/**
 * 快照记忆卡 + Room 归属记忆（gateway room_memory_attributions）的只读合并视图：
 * 建联链路（chip 预览/跳转、选择器、记忆卡）的数据源。
 * - 归因项读时物化（attributed 标记，不写回快照 state），统一视为已确认；
 * - 快照条目带 memoryId 且命中归因集时跳过（归因版本内容更新，防重复）——
 *   晋升回链与 room-enrich 带 memoryId 的条目靠此去重；
 * - 已禁用 shadow（memoryId 未命中归因集）保留，由启用操作重新绑定。
 */
export function mergeRoomMemoryItems(
  room: ContextRoomRecord,
  attributed: MemoryRoomMemoryItemDto[],
): ContextRoomRecord {
  if (attributed.length === 0) return room
  const attributedIds = new Set(attributed.map((item) => item.memoryId))
  const snapshotItems = room.memoryItems.filter((item) => !item.memoryId || !attributedIds.has(item.memoryId))
  const known = new Set(snapshotItems.map((item) => item.id))
  const additions = attributed
    .filter((item) => !known.has(item.memoryId))
    .map<ContextRoomMemoryItem>((item) => ({
      id: item.memoryId,
      memoryId: item.memoryId,
      attributed: true,
      content: item.content,
      type: item.type,
      status: '已确认',
    }))
  if (additions.length === 0 && snapshotItems.length === room.memoryItems.length) return room
  return { ...room, memoryItems: [...snapshotItems, ...additions] }
}
