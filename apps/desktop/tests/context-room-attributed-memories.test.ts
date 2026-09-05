import { describe, expect, it } from 'vitest'

import { mergeRoomMemoryItems } from '../src/renderer/src/components/context-room/ported/attributedRoomMemories'
import { createContextRoomFixture } from './context-room-fixture'

describe('mergeRoomMemoryItems', () => {
  it('appends attributed memories as confirmed and keeps snapshot items first', () => {
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
      { id: 'memory-b', content: '归因项 B', type: '人物偏好', status: '已确认' },
    ])
    // 原 room 不被就地修改（合并发生在只读展示层）。
    expect(room.memoryItems).toHaveLength(1)
  })

  it('returns the same room when no attributed memories resolve', () => {
    const room = createContextRoomFixture('room-2', '空房间')

    expect(mergeRoomMemoryItems(room, [])).toBe(room)
  })
})
