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

async function createHarness(enricher?: ConstructorParameters<typeof ContextRoomService>[1]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-rooms-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  return { ...database, service: new ContextRoomService(database.db, enricher) }
}

describe('ContextRoomService', () => {
  it('persists the complete active and deleted Room snapshot in order', async () => {
    const { service, sqlite } = await createHarness()
    const saved = service.saveSnapshot({
      rooms: [
        {
          id: 'room-b',
          title: 'Room B',
          kind: '主题',
          data: {
            id: 'wrong',
            title: '旧标题',
            materials: [],
            brief: { background: '  背景 B  ', goal: '目标 B', status: '进行中' },
          },
        },
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
      {
        id: 'room-b',
        title: 'Room B',
        kind: '主题',
        background: '背景 B',
        goal: '目标 B',
        status: '进行中',
      },
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

  it('creates a complete Room and reuses an existing title on retry', async () => {
    const { service, sqlite } = await createHarness({
      enrich: async () => ({
        kind: '项目',
        overview: '校园生活的学习与活动总览',
        background: '用户正在整理校园活动与学习资料',
        goal: '形成可持续更新的校园生活资料库',
        status: '已有相关记忆，等待补充资料',
        nextSteps: ['整理课程资料'],
        entities: [{ name: '校园社团', kind: '组织', description: '相关活动组织' }],
        facts: [{ content: '用户关注校园活动', type: '偏好' }],
      }),
    })

    const first = await service.createRoom({
      title: ' Campus Life ',
      description: '校园活动与学习资料',
    })
    const retried = await service.createRoom({ title: 'campus life', description: '重复请求' })

    expect(first).toMatchObject({
      created: true,
      room: {
        id: expect.stringMatching(/^room-/),
        title: 'Campus Life',
        kind: '项目',
        background: '用户正在整理校园活动与学习资料',
        goal: '形成可持续更新的校园生活资料库',
      },
    })
    expect(retried).toEqual({ room: first.room, created: false })
    expect(service.getSnapshot().rooms).toHaveLength(1)
    expect(service.getSnapshot().rooms[0]?.data).toMatchObject({
      id: first.room.id,
      title: 'Campus Life',
      kind: '项目',
      materials: [],
      actionItems: [],
      brief: {
        background: '用户正在整理校园活动与学习资料',
        goal: '形成可持续更新的校园生活资料库',
      },
      generatedContext: {
        overview: '校园生活的学习与活动总览',
        nextSteps: ['整理课程资料'],
        entities: [{ name: '校园社团', kind: '组织', description: '相关活动组织' }],
      },
      memoryItems: [{ content: '用户关注校园活动', type: '偏好' }],
      stats: { memories: 1 },
    })
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

  it('coalesces concurrent same-title creation while enrichment is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service, sqlite } = await createHarness({
      enrich: async ({ description }) => {
        await gate
        return {
          kind: '主题',
          overview: description,
          background: description,
          goal: description,
          status: '已创建',
          nextSteps: [],
          entities: [],
          facts: [],
        }
      },
    })

    const firstPromise = service.createRoom({ title: 'Campus Life', description: '校园生活' })
    const retryPromise = service.createRoom({ title: 'campus life', description: '重复请求' })
    release()
    const [first, retry] = await Promise.all([firstPromise, retryPromise])

    expect(first.created).toBe(true)
    expect(retry).toMatchObject({ created: false, room: { id: first.room.id } })
    expect(service.getSnapshot().rooms).toHaveLength(1)
    sqlite.close()
  })
})
