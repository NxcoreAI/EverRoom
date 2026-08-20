import type { ContextRoomSnapshot } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import {
  createContextRoomSnapshotInput,
  isContextRoomSnapshotEmpty,
  removeDemoContextRoomState,
  restoreContextRoomSnapshot,
} from '../src/renderer/src/components/context-room/ported/contextRoomLocalState'
import { DEMO_CONTEXT_ROOM_IDS } from '../src/renderer/src/components/context-room/ported/demoContextRooms'
import { createContextRoomFixture } from './context-room-fixture'

describe('Context Room backend snapshots', () => {
  it('serializes complete active and deleted Room records in order', () => {
    const active = createContextRoomFixture('room-active', '活跃 Room')
    const deleted = createContextRoomFixture('room-deleted', '已删除 Room')
    const input = createContextRoomSnapshotInput({ rooms: [active], deletedRooms: [deleted] })

    expect(input.rooms[0]).toMatchObject({
      id: active.id,
      title: active.title,
      kind: active.kind,
      data: { id: active.id, brief: active.brief, materials: active.materials },
    })
    expect(input.deletedRooms[0]).toMatchObject({ id: deleted.id, data: { id: deleted.id } })
  })

  it('restores backend order and lets top-level identity fields override data', () => {
    const first = createContextRoomFixture('room-first', '第一个 Room')
    const second = createContextRoomFixture('room-second', '第二个 Room')
    const serialized = createContextRoomSnapshotInput({ rooms: [first], deletedRooms: [second] })
    const snapshot: ContextRoomSnapshot = {
      rooms: [{
        ...serialized.rooms[0],
        id: 'room-server',
        title: '服务端标题',
        kind: '项目',
        data: { ...serialized.rooms[0].data, id: 'wrong', title: 'wrong', kind: '主题' },
      }],
      deletedRooms: serialized.deletedRooms,
      updatedAt: '2026-08-16T08:00:00.000Z',
    }

    const restored = restoreContextRoomSnapshot(snapshot)

    expect(restored?.rooms).toHaveLength(1)
    expect(restored?.rooms[0]).toMatchObject({ id: 'room-server', title: '服务端标题', kind: '项目' })
    expect(restored?.rooms[0].updatedAt).toBe(snapshot.updatedAt)
    expect(restored?.deletedRooms[0].id).toBe(second.id)
  })

  it('migrates generated Room context saved before overview was introduced', () => {
    const room = createContextRoomFixture()
    room.generatedContext = {
      roomId: room.id,
      generatedAt: '2026-08-20T12:00:00.000Z',
      sourceDocuments: [],
      status: '资料已进入评审',
      nextSteps: [],
      entities: [],
      actionItems: [],
      meetings: [],
    } as typeof room.generatedContext
    const snapshot = createContextRoomSnapshotInput({ rooms: [room], deletedRooms: [] })

    expect(restoreContextRoomSnapshot({ ...snapshot, updatedAt: null })?.rooms[0]
      .generatedContext?.overview).toBe('')
  })

  it('recognizes first import and rejects corrupt or duplicate snapshots', () => {
    expect(isContextRoomSnapshotEmpty({ rooms: [], deletedRooms: [], updatedAt: null })).toBe(true)

    const valid = createContextRoomSnapshotInput({ rooms: [createContextRoomFixture()], deletedRooms: [] }).rooms[0]
    expect(restoreContextRoomSnapshot({
      rooms: [{ id: 'broken', title: '损坏', kind: '主题', data: {} }],
      deletedRooms: [],
      updatedAt: null,
    })).toBeNull()
    expect(restoreContextRoomSnapshot({
      rooms: [valid],
      deletedRooms: [valid],
      updatedAt: null,
    })).toBeNull()
  })

  it('removes legacy demo Rooms while preserving user Rooms', () => {
    const userRoom = createContextRoomFixture('room-user', '用户 Room')
    const demoRooms = DEMO_CONTEXT_ROOM_IDS.map((id) => createContextRoomFixture(id, id))

    expect(removeDemoContextRoomState({
      rooms: [demoRooms[0], userRoom],
      deletedRooms: demoRooms.slice(1),
    })).toEqual({ rooms: [userRoom], deletedRooms: [] })

    const snapshot = createContextRoomSnapshotInput({
      rooms: [userRoom, ...demoRooms],
      deletedRooms: [],
    })
    expect(restoreContextRoomSnapshot({ ...snapshot, updatedAt: null })?.rooms).toEqual([userRoom])
  })
})
