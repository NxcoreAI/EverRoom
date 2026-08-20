import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-rooms-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  return { ...database, service: new ContextRoomService(database.db) }
}

describe('ContextRoomService', () => {
  it('persists the complete active and deleted Room snapshot in order', async () => {
    const { service, sqlite } = await createHarness()
    const saved = service.saveSnapshot({
      rooms: [
        { id: 'room-b', title: 'Room B', kind: '主题', data: { id: 'wrong', title: '旧标题', materials: [] } },
        { id: 'room-a', title: 'Room A', kind: '项目', data: { id: 'room-a', title: 'Room A', materials: [1] } },
      ],
      deletedRooms: [
        { id: 'room-deleted', title: '已删除 Room', kind: '议题', data: { id: 'room-deleted', title: '已删除 Room' } },
      ],
    })

    expect(saved.rooms.map((room) => room.id)).toEqual(['room-b', 'room-a'])
    expect(saved.deletedRooms.map((room) => room.id)).toEqual(['room-deleted'])
    expect(saved.rooms[0]?.data).toMatchObject({ id: 'room-b', title: 'Room B', kind: '主题', materials: [] })
    expect(saved.updatedAt).not.toBeNull()
    expect(service.listReferences()).toEqual([
      { id: 'room-b', title: 'Room B', kind: '主题' },
      { id: 'room-a', title: 'Room A', kind: '项目' },
    ])
    expect(service.isActive('room-deleted')).toBe(false)
    sqlite.close()
  })

  it('restores a deleted Room and rejects duplicate snapshot ids', async () => {
    const { service, sqlite } = await createHarness()
    const room = { id: 'room-1', title: 'Room 1', data: { id: 'room-1', title: 'Room 1' } }
    service.saveSnapshot({ rooms: [], deletedRooms: [room] })
    expect(service.isActive(room.id)).toBe(false)

    service.saveSnapshot({ rooms: [room], deletedRooms: [] })
    expect(service.isActive(room.id)).toBe(true)
    expect(service.getSnapshot().deletedRooms).toEqual([])
    expect(() => service.saveSnapshot({ rooms: [room], deletedRooms: [room] }))
      .toThrow('context_room_snapshot_has_duplicate_ids')
    sqlite.close()
  })

  it('removes Rooms omitted from the next complete snapshot', async () => {
    const { service, sqlite } = await createHarness()
    const keep = { id: 'room-keep', title: '保留 Room', data: { id: 'room-keep', title: '保留 Room' } }
    const remove = { id: 'room-remove', title: '移除 Room', data: { id: 'room-remove', title: '移除 Room' } }
    service.saveSnapshot({ rooms: [keep, remove], deletedRooms: [] })

    expect(service.saveSnapshot({ rooms: [keep], deletedRooms: [] }).rooms).toEqual([keep])
    expect(service.isActive(remove.id)).toBe(false)

    expect(service.saveSnapshot({ rooms: [], deletedRooms: [] }))
      .toMatchObject({ rooms: [], deletedRooms: [] })
    sqlite.close()
  })
})
