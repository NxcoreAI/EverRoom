import type { SubagentInvocation } from '@nxcore/agent-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  entities as entitiesTable,
  roomEntityMentions,
} from '../src/infrastructure/database/schema.js'
import type { RoomAgentDispatcher, RoomAgentDispatchInput } from '../src/modules/context-rooms/room-agent.js'
import { CONTEXT_ROOM_AGENT_ID } from '../src/modules/context-rooms/room-agent.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function completedInvocation(text: string): SubagentInvocation {
  const now = Date.now()
  return {
    id: `invocation-${Math.random().toString(36).slice(2, 8)}`,
    agentDefinitionId: CONTEXT_ROOM_AGENT_ID,
    agentRevisionId: 'revision-1',
    source: 'internal_workflow',
    parentSessionId: null,
    parentRunId: null,
    task: '整理新创建的 Context Room',
    input: null,
    status: 'completed',
    result: { text },
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(now - 5_000).toISOString(),
    startedAt: new Date(now - 4_000).toISOString(),
    completedAt: new Date(now - 3_000).toISOString(),
  }
}

/** 可手工决议的假调度器：dispatch 挂起直到测试侧 resolve/reject。 */
function gatedDispatcher() {
  const calls: Array<{
    input: RoomAgentDispatchInput
    resolve: (invocation: SubagentInvocation) => void
    reject: (error: unknown) => void
  }> = []
  const dispatcher: RoomAgentDispatcher = {
    dispatch: (input) => new Promise((resolve, reject) => {
      calls.push({ input, resolve, reject })
    }),
    dispatchDetached: async () => 'invocation-detached',
  }
  return { dispatcher, calls }
}

async function createHarness(dispatcher?: RoomAgentDispatcher) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-rooms-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const service = new ContextRoomService(database.db)
  if (dispatcher) service.setRoomAgentDispatcher(dispatcher)
  return { ...database, service }
}

const enrichedPayload = JSON.stringify({
  kind: '项目',
  overview: '校园生活的学习与活动总览',
  background: '用户正在整理校园活动与学习资料',
  goal: '形成可持续更新的校园生活资料库',
  status: '已有相关记忆，等待补充资料',
  nextSteps: ['整理课程资料'],
  entities: [{ name: '校园社团', kind: '组织', description: '相关活动组织' }],
  facts: [{ content: '用户关注校园活动', type: '偏好' }],
})

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

  it('creates the Room immediately with fallback content and applies the async enrichment', async () => {
    const { dispatcher, calls } = gatedDispatcher()
    const { service, sqlite } = await createHarness(dispatcher)

    const first = await service.createRoom({
      title: ' Campus Life ',
      description: '校园活动与学习资料',
    })

    // 异步整理：创建立即返回 fallback 内容，不等待子 Agent。
    expect(first).toMatchObject({
      created: true,
      room: {
        id: expect.stringMatching(/^room-/),
        title: 'Campus Life',
        kind: '主题',
        background: '校园活动与学习资料',
      },
    })
    expect(first.room.data).toMatchObject({
      brief: { background: '校园活动与学习资料', status: '已创建，等待补充资料' },
      roomAgentTask: 'room-enrich',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({
      task: 'room-enrich',
      idempotencyKey: `room-enrich:${first.room.id}`,
      taskInput: { roomId: first.room.id, title: 'Campus Life', description: '校园活动与学习资料' },
    })

    calls[0]?.resolve(completedInvocation(enrichedPayload))
    await vi.waitFor(() => {
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
    })
    // 回写完成后清除标记，快照不再携带内部任务字段。
    expect(service.getSnapshot().rooms[0]?.data).not.toHaveProperty('roomAgentTask')
    expect(service.getSnapshot().rooms[0]?.data.timeline).toEqual([
      expect.objectContaining({ title: 'Room 已创建', kind: 'info', generated: true }),
      expect.objectContaining({ title: 'Room 创建整理完成', kind: 'done', generated: true }),
    ])

    const retried = await service.createRoom({ title: 'campus life', description: '重复请求' })
    expect(retried).toEqual({ room: service.getSnapshot().rooms[0], created: false })
    expect(service.getSnapshot().rooms).toHaveLength(1)
    sqlite.close()
  })

  it('keeps the fallback content and clears the marker when enrichment fails', async () => {
    const { dispatcher, calls } = gatedDispatcher()
    const { service, sqlite } = await createHarness(dispatcher)

    const created = await service.createRoom({ title: 'Campus Life', description: '校园活动与学习资料' })
    calls[0]?.reject(new Error('subagent unavailable'))
    await vi.waitFor(() => {
      expect(service.getSnapshot().rooms[0]?.data).not.toHaveProperty('roomAgentTask')
    })
    expect(service.getSnapshot().rooms[0]?.data).toMatchObject({
      kind: '主题',
      brief: { background: '校园活动与学习资料', status: '已创建，等待补充资料' },
    })
    // 标记清除后，迟到的整理结果不再回写。
    expect(service.applyAgentEnrichment(created.room.id, {
      kind: '项目',
      overview: '迟到',
      background: '迟到',
      goal: '迟到',
      status: '迟到',
      nextSteps: [],
      entities: [],
      facts: [],
    })).toBe(false)
    sqlite.close()
  })

  it('coalesces concurrent same-title creation while enrichment is running', async () => {
    const { dispatcher } = gatedDispatcher()
    const { service, sqlite } = await createHarness(dispatcher)

    const firstPromise = service.createRoom({ title: 'Campus Life', description: '校园生活' })
    const retryPromise = service.createRoom({ title: 'campus life', description: '重复请求' })
    const [first, retry] = await Promise.all([firstPromise, retryPromise])

    expect(first.created).toBe(true)
    expect(retry).toMatchObject({ created: false, room: { id: first.room.id } })
    expect(service.getSnapshot().rooms).toHaveLength(1)
    sqlite.close()
  })

  it('refreshes the brief through the room agent and keeps unspecified fields', async () => {
    const { dispatcher, calls } = gatedDispatcher()
    const { service, sqlite } = await createHarness(dispatcher)
    const created = await service.createRoom({ title: 'Campus Life', description: '校园活动与学习资料' })
    calls[0]?.resolve(completedInvocation(enrichedPayload))
    await vi.waitFor(() => {
      expect(service.getSnapshot().rooms[0]?.data).not.toHaveProperty('roomAgentTask')
    })

    const refresh = service.refreshBrief(created.room.id)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.input).toMatchObject({
      task: 'brief-refresh',
      taskInput: {
        roomId: created.room.id,
        roomTitle: 'Campus Life',
        currentBrief: {
          background: '用户正在整理校园活动与学习资料',
          goal: '形成可持续更新的校园生活资料库',
          status: '已有相关记忆，等待补充资料',
        },
      },
    })
    calls[1]?.resolve(completedInvocation(JSON.stringify({
      background: '更新后的背景',
      goal: '更新后的目标',
      status: '收尾中',
      risks: ['资料尚不完整'],
      decisions: ['先整理课程资料'],
    })))
    const refreshed = await refresh

    expect(refreshed.data.brief).toMatchObject({
      background: '更新后的背景',
      goal: '更新后的目标',
      status: '收尾中',
      risks: ['资料尚不完整'],
      decisions: ['先整理课程资料'],
    })
    expect(service.getSnapshot().rooms[0]?.data.brief).toMatchObject({ status: '收尾中' })
    sqlite.close()
  })

  it('rejects refreshBrief and keeps the stored brief when parsing fails', async () => {
    const { dispatcher, calls } = gatedDispatcher()
    const { service, sqlite } = await createHarness(dispatcher)
    const created = await service.createRoom({ title: 'Campus Life', description: '校园活动与学习资料' })
    calls[0]?.resolve(completedInvocation(enrichedPayload))
    await vi.waitFor(() => {
      expect(service.getSnapshot().rooms[0]?.data).not.toHaveProperty('roomAgentTask')
    })

    const refresh = service.refreshBrief(created.room.id)
    calls[1]?.resolve(completedInvocation('不是 JSON'))
    await expect(refresh).rejects.toThrow('invalid JSON')
    expect(service.getSnapshot().rooms[0]?.data.brief).toMatchObject({
      background: '用户正在整理校园活动与学习资料',
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

  it('aggregates applied entities from mentions with live entity status', async () => {
    const { db, service, sqlite } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-1', title: 'Room 1', data: { id: 'room-1', title: 'Room 1' } }],
      deletedRooms: [],
    })
    db.insert(entitiesTable).values([
      { id: 'entity-a', name: '林薇', kind: '人物', status: 'room', summary: '设计负责人', roomId: 'room-1', aliases: ['薇薇'] },
      { id: 'entity-b', name: 'NexOS V1', kind: '项目', status: 'weak' },
      { id: 'entity-c', name: '孤儿实体', kind: '主题', status: 'ready' },
    ]).run()
    const now = new Date()
    const later = new Date(now.getTime() + 1_000)
    db.insert(roomEntityMentions).values([
      { id: 'm1', roomId: 'room-1', entityId: 'entity-a', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', salience: 0.6, evidence: '林薇负责设计', createdAt: now, updatedAt: now },
      { id: 'm2', roomId: 'room-1', entityId: 'entity-a', sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', salience: 0.4, createdAt: now, updatedAt: now },
      { id: 'm3', roomId: 'room-1', entityId: 'entity-b', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', salience: 0.9, evidence: 'V1 发布计划', createdAt: later, updatedAt: later },
      { id: 'm4', roomId: 'room-other', entityId: 'entity-c', sourceKind: 'mail', sourceId: 'mail-9', sourceVersion: 1, evidenceGroupKey: 'g3', salience: 0.8, createdAt: now, updatedAt: now },
    ]).run()

    const result = service.roomAppliedEntities('room-1')
    expect(result.roomId).toBe('room-1')
    expect(result.entities).toHaveLength(2)
    // mentionCount 降序：entity-a（2 个来源）在前，entity-b（1 个）在后。
    expect(result.entities[0]).toMatchObject({
      entityId: 'entity-a',
      name: '林薇',
      kind: '人物',
      status: 'room',
      summary: '设计负责人',
      linkedRoomId: 'room-1',
      mentionCount: 2,
      salience: 0.6,
      evidence: '林薇负责设计',
    })
    expect(result.entities[0]?.aliases).toEqual(['薇薇'])
    expect(result.entities[0]?.sourceKinds).toEqual(['everroom-doc', 'mail'])
    expect(result.entities[0]?.lastMentionAt).toBe(now.toISOString())
    expect(result.entities[1]).toMatchObject({
      entityId: 'entity-b',
      status: 'weak',
      mentionCount: 1,
      salience: 0.9,
      evidence: 'V1 发布计划',
      lastMentionAt: later.toISOString(),
    })
    expect(result.updatedAt).toBeTruthy()
    sqlite.close()
  })

  it('returns empty applied entities without mentions and rejects unknown rooms', async () => {
    const { service, sqlite } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-1', title: 'Room 1', data: { id: 'room-1', title: 'Room 1' } }],
      deletedRooms: [],
    })
    expect(service.roomAppliedEntities('room-1')).toMatchObject({ roomId: 'room-1', entities: [] })
    expect(() => service.roomAppliedEntities('missing-room')).toThrow('context_room_not_found')
    sqlite.close()
  })
})
