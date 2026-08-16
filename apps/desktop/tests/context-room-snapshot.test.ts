import type { ContextRoomSnapshot } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import {
  createContextRoomSnapshotInput,
  isContextRoomSnapshotEmpty,
  restoreContextRoomSnapshot,
} from '../src/renderer/src/components/context-room/ported/contextRoomLocalState'
import { CONTEXT_ROOMS } from '../src/renderer/src/components/context-room/ported/data'

describe('Context Room backend snapshots', () => {
  it('serializes complete active and deleted Room records in order', () => {
    const active = structuredClone(CONTEXT_ROOMS[0])
    const deleted = structuredClone(CONTEXT_ROOMS[1])
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
    const first = structuredClone(CONTEXT_ROOMS[0])
    const second = structuredClone(CONTEXT_ROOMS[1])
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
    expect(restored?.deletedRooms[0].id).toBe(second.id)
  })

  it('recognizes first import and rejects corrupt or duplicate snapshots', () => {
    expect(isContextRoomSnapshotEmpty({ rooms: [], deletedRooms: [], updatedAt: null })).toBe(true)

    const valid = createContextRoomSnapshotInput({ rooms: [CONTEXT_ROOMS[0]], deletedRooms: [] }).rooms[0]
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
})
