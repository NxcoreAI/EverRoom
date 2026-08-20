import { describe, expect, it } from 'vitest'

import {
  createAutoContextRoom,
  mergeAutoKnowledgeRooms,
  shouldDeleteRoomFromKnowledge,
  shouldSyncRoomToKnowledge,
} from '../src/renderer/src/components/context-room/ported/knowledgeRoomSync'
import { createEmptyContextRoom } from '../src/renderer/src/components/context-room/ported/contextRoomFactory'
import { DEMO_CONTEXT_ROOM_IDS } from '../src/renderer/src/components/context-room/ported/demoContextRooms'
import { createContextRoomFixture } from './context-room-fixture'

const automaticRoom = {
  id: 'auto-1234',
  title: '自动归集主题',
  kind: '项目',
  origin: 'auto',
  summary: '来自两份资料的共同主题',
  aliases: [],
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
}

describe('Context Room knowledge synchronization', () => {
  it('filters demo and unclaimed automatic Rooms from outbound synchronization', () => {
    const legacyDemoRooms = DEMO_CONTEXT_ROOM_IDS.map((id) => createEmptyContextRoom({
      id,
      title: '旧演示 Room',
      kind: '项目',
      background: '',
      goal: '',
      briefStatus: '',
    }))

    expect(legacyDemoRooms.every((room) => !shouldSyncRoomToKnowledge(room))).toBe(true)
    expect(shouldSyncRoomToKnowledge(createAutoContextRoom(automaticRoom))).toBe(false)
    expect(shouldSyncRoomToKnowledge(createContextRoomFixture('room-user', '用户 Room'))).toBe(true)
    expect(legacyDemoRooms.every((room) => !shouldDeleteRoomFromKnowledge(room))).toBe(true)
    expect(shouldDeleteRoomFromKnowledge(createAutoContextRoom(automaticRoom))).toBe(true)
  })

  it('converts automatic knowledge Rooms and preserves their pending ownership', () => {
    expect(createAutoContextRoom(automaticRoom)).toMatchObject({
      id: automaticRoom.id,
      title: automaticRoom.title,
      kind: '项目',
      origin: 'auto',
      brief: { background: automaticRoom.summary },
    })
    expect(createAutoContextRoom(automaticRoom)).not.toHaveProperty('recentSource')
    expect(createAutoContextRoom(automaticRoom)).not.toHaveProperty('crossHint')
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

  it('merges only unknown automatic Rooms and never resurrects a locally deleted Room', () => {
    const active = createContextRoomFixture('room-user', '用户 Room')
    const deleted = createContextRoomFixture(automaticRoom.id, automaticRoom.title)
    expect(mergeAutoKnowledgeRooms([active], [deleted], [automaticRoom])).toEqual([active])

    const merged = mergeAutoKnowledgeRooms([active], [], [automaticRoom])
    expect(merged.map((room) => room.id)).toEqual([automaticRoom.id, active.id])
  })
})
