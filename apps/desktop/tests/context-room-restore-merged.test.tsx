import { describe, expect, it } from 'vitest'

import type { ContextRoomSnapshot, ContextRoomSnapshotItem } from '@nxcore/agent-contract'
import { restoreContextRoomSnapshot } from '../src/renderer/src/components/context-room/ported/contextRoomLocalState'
import type { ContextRoomRecord } from '../src/renderer/src/components/context-room/ported/adapters'

function healthyRoom(id: string, title: string): ContextRoomSnapshotItem {
  return {
    id,
    title,
    kind: '主题',
    data: {
      id,
      title,
      kind: '主题',
      brief: `${title}的简介`,
      stats: { memories: 1, tasks: 0, docs: 2 },
      materials: [{ id: `${id}-doc`, type: '文档', title: '资料', addedAt: '2026-08-31T00:00:00.000Z' }],
      memoryItems: [{ id: `${id}-mem`, content: '记忆' }],
      actionItems: [],
      timeline: [],
      people: [],
      fileItems: [],
      pendingMemoryItems: [],
      graphEdges: [],
    },
    lifecycle: 'active',
  } as ContextRoomSnapshotItem
}

/** 合并残留形态：lifecycle=merged 且 data 只剩两个标记字段（合并事务的真实写回形态）。 */
function mergedRemnantRoom(id: string): ContextRoomSnapshotItem {
  return {
    id,
    title: '已合并的旧 Room',
    kind: undefined,
    data: { lifecycle: 'merged', mergedIntoRoomId: 'room-kept' },
    lifecycle: 'merged',
  } as unknown as ContextRoomSnapshotItem
}

describe('restoreContextRoomSnapshot（合并残骸收紧）', () => {
  it('快照混入合并残留时逐条丢弃，其余 room 正常恢复（不再整包拒绝）', () => {
    const snapshot: ContextRoomSnapshot = {
      rooms: [mergedRemnantRoom('room-gone'), healthyRoom('room-kept', '保留的 Room')],
      deletedRooms: [],
      updatedAt: '2026-08-31T00:00:00.000Z',
    }
    const restored = restoreContextRoomSnapshot(snapshot)
    expect(restored).not.toBeNull()
    expect((restored!.rooms as ContextRoomRecord[]).map((room) => room.id)).toEqual(['room-kept'])
  })

  it('deletedRooms 里的残留同样被丢弃', () => {
    const snapshot: ContextRoomSnapshot = {
      rooms: [healthyRoom('room-kept', '保留的 Room')],
      deletedRooms: [mergedRemnantRoom('room-gone')],
      updatedAt: '2026-08-31T00:00:00.000Z',
    }
    const restored = restoreContextRoomSnapshot(snapshot)
    expect(restored!.deletedRooms).toHaveLength(0)
    expect(restored!.rooms).toHaveLength(1)
  })

  it('全部为残留时恢复为空工作区而非 null（同步不被瘫痪）', () => {
    const snapshot: ContextRoomSnapshot = {
      rooms: [mergedRemnantRoom('room-gone-1'), mergedRemnantRoom('room-gone-2')],
      deletedRooms: [],
      updatedAt: null,
    }
    const restored = restoreContextRoomSnapshot(snapshot)
    expect(restored).not.toBeNull()
    expect(restored!.rooms).toHaveLength(0)
  })
})
