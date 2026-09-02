import { describe, expect, it } from 'vitest'

import {
  createKnowledgeContextRoom,
  mergeKnowledgeRooms,
  shouldDeleteRoomFromKnowledge,
  shouldSyncRoomToKnowledge,
} from '../src/renderer/src/components/context-room/ported/knowledgeRoomSync'
import { createEmptyContextRoom } from '../src/renderer/src/components/context-room/ported/contextRoomFactory'
import { DEMO_CONTEXT_ROOM_IDS } from '../src/renderer/src/components/context-room/ported/demoContextRooms'
import { createContextRoomFixture } from './context-room-fixture'

const promotedRoom = {
  id: 'auto-1234',
  title: '推荐归集主题',
  kind: '项目',
  origin: 'user',
  summary: '来自两份资料的共同主题',
  aliases: [],
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
}

/** 迁移 0051 之前的遗留行（现网已统一翻为 user，读取兼容仍识别）。 */
const legacyAutoRoom = { ...promotedRoom, id: 'auto-legacy', origin: 'auto' }

describe('Context Room knowledge synchronization', () => {
  it('filters demo and legacy-auto Rooms from outbound synchronization', () => {
    const legacyDemoRooms = DEMO_CONTEXT_ROOM_IDS.map((id) => createEmptyContextRoom({
      id,
      title: '旧演示 Room',
      kind: '项目',
      background: '',
      goal: '',
      briefStatus: '',
    }))

    expect(legacyDemoRooms.every((room) => !shouldSyncRoomToKnowledge(room))).toBe(true)
    expect(shouldSyncRoomToKnowledge(createKnowledgeContextRoom(legacyAutoRoom))).toBe(false)
    expect(shouldSyncRoomToKnowledge(createKnowledgeContextRoom(promotedRoom))).toBe(true)
    expect(shouldSyncRoomToKnowledge(createContextRoomFixture('room-user', '用户 Room'))).toBe(true)
    expect(legacyDemoRooms.every((room) => !shouldDeleteRoomFromKnowledge(room))).toBe(true)
    expect(shouldDeleteRoomFromKnowledge(createKnowledgeContextRoom(promotedRoom))).toBe(true)
  })

  it('converts promotion-born rooms as user-owned without claim placeholders', () => {
    expect(createKnowledgeContextRoom(promotedRoom)).toMatchObject({
      id: promotedRoom.id,
      title: promotedRoom.title,
      kind: '项目',
      origin: 'user',
      brief: { background: promotedRoom.summary, goal: '', status: '' },
    })
    expect(createKnowledgeContextRoom(promotedRoom)).not.toHaveProperty('recentSource')
    expect(createKnowledgeContextRoom(promotedRoom)).not.toHaveProperty('crossHint')

    // 遗留 auto 行：读取兼容保 origin，但不再附带「等待认领」占位。
    expect(createKnowledgeContextRoom(legacyAutoRoom)).toMatchObject({
      origin: 'auto',
      brief: { goal: '', status: '' },
    })
  })

  it('merges only unknown knowledge rooms into the local list', () => {
    const existing = createContextRoomFixture('room-user', '用户 Room')
    const merged = mergeKnowledgeRooms([existing], [], [promotedRoom, { ...promotedRoom, id: existing.id }])
    expect(merged.map((room) => room.id)).toEqual([promotedRoom.id, existing.id])
    expect(merged[0]).toMatchObject({ origin: 'user' })
  })

  it('creates empty Rooms without inheriting demo-only fields', () => {
    const room = createEmptyContextRoom({
      id: 'room-empty',
      title: '空 Room',
      kind: '主题',
      background: '',
      goal: '',
      briefStatus: '',
    })

    expect(room).toMatchObject({
      id: 'room-empty',
      title: '空 Room',
      icon: '主题',
      tone: 'zinc',
      materials: [],
    })
    expect(room).not.toHaveProperty('recentSource')
    expect(room).not.toHaveProperty('crossHint')
  })

  it('merges only unknown knowledge Rooms and never resurrects a locally deleted Room', () => {
    const active = createContextRoomFixture('room-user', '用户 Room')
    const deleted = createContextRoomFixture(promotedRoom.id, promotedRoom.title)
    expect(mergeKnowledgeRooms([active], [deleted], [promotedRoom])).toEqual([active])

    const merged = mergeKnowledgeRooms([active], [], [promotedRoom])
    expect(merged.map((room) => room.id)).toEqual([promotedRoom.id, active.id])
  })
})
