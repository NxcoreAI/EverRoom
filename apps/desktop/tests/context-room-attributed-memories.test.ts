import { describe, expect, it } from 'vitest'

import { mergeRoomMemoryItems } from '../src/renderer/src/components/context-room/ported/attributedRoomMemories'
import { createContextRoomFixture } from './context-room-fixture'

describe('mergeRoomMemoryItems', () => {
  it('appends attributed memories as confirmed (with flags) and keeps snapshot items first', () => {
    const room = createContextRoomFixture('room-1', '上线项目')
    room.memoryItems = [
      { id: 'memory-a', content: '快照项', type: '事实', status: '已禁用' },
    ]

    const merged = mergeRoomMemoryItems(room, [
      { memoryId: 'memory-b', type: '人物偏好', content: '归因项 B' },
      { memoryId: 'memory-a', type: '事实', content: '归因旧快照' },
    ])

    expect(merged.memoryItems).toEqual([
      { id: 'memory-a', content: '快照项', type: '事实', status: '已禁用' },
      { id: 'memory-b', memoryId: 'memory-b', attributed: true, content: '归因项 B', type: '人物偏好', status: '已确认' },
    ])
    // 原 room 不被就地修改（合并发生在只读展示层）。
    expect(room.memoryItems).toHaveLength(1)
  })

  it('returns the same room when no attributed memories resolve', () => {
    const room = createContextRoomFixture('room-2', '空房间')

    expect(mergeRoomMemoryItems(room, [])).toBe(room)
  })

  it('drops snapshot items whose memoryId matches an attribution (attribution wins, no duplicates)', () => {
    const room = createContextRoomFixture('room-3', '晋升回链')
    room.memoryItems = [
      // 晋升回链条目：worker 已写 memoryId，归因版本内容更新 → 只显示归因版本。
      { id: 'room-3-memory-1', memoryId: 'mem-x', content: '旧措辞', type: '事实', status: '已确认', promotionSessionId: 'room-memory:room-3:room-3-memory-1' },
      // 禁用 shadow：memoryId 未命中归因集（已解绑）→ 保留。
      { id: 'mem-y', memoryId: 'mem-y', content: '已禁用项', type: '事实', status: '已禁用' },
    ]

    const merged = mergeRoomMemoryItems(room, [
      { memoryId: 'mem-x', type: '事实', content: '蒸馏后措辞' },
    ])

    expect(merged.memoryItems).toEqual([
      { id: 'mem-y', memoryId: 'mem-y', content: '已禁用项', type: '事实', status: '已禁用' },
      { id: 'mem-x', memoryId: 'mem-x', attributed: true, content: '蒸馏后措辞', type: '事实', status: '已确认' },
    ])
  })
})
