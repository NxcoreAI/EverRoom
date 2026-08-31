import type { SubagentInvocation } from '@nxcore/agent-contract'
import { Ajv } from 'ajv'
import { eq } from 'drizzle-orm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundledAgentDefinitionsDir } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  connectorCalendarEvents,
  connectorEmails,
  connectorTodos,
  contextRooms,
  documents as documentsTable,
  entities as entitiesTable,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  roomSourceMemberships,
  routeDecisions,
} from '../src/infrastructure/database/schema.js'
import type { RoomAgentDispatcher, RoomAgentDispatchInput } from '../src/modules/context-rooms/room-agent.js'
import { CONTEXT_ROOM_AGENT_ID } from '../src/modules/context-rooms/room-agent.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { RoomOverviewService } from '../src/modules/context-rooms/overview-service.js'

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
    const claimedEntities: Array<{ roomId: string; entities: Array<{ name: string; kind: string }> }> = []
    service.setRoomEntityClaimer((roomId, entities) => { claimedEntities.push({ roomId, entities }) })

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
    // enrich 抽出的实体同步触发认领（路由目标化）；kind 原样透传，由认领侧解析。
    expect(claimedEntities).toEqual([
      { roomId: first.room.id, entities: [{ name: '校园社团', kind: '组织' }] },
    ])
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
    db.insert(roomSourceMemberships).values([
      { id: 's1', roomId: 'room-1', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', role: 'primary', sourceTitle: 'V1 项目结论' },
    ]).run()
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
    // 来源明细：标题取 room_source_memberships（mail-1 无 membership → null），
    // 同时刻插入按稳定排序保持插入顺序。
    expect(result.entities[0]?.sources).toEqual([
      { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: 'V1 项目结论', evidence: '林薇负责设计', mentionedAt: now.toISOString() },
      { sourceKind: 'mail', sourceId: 'mail-1', sourceTitle: null, evidence: null, mentionedAt: now.toISOString() },
    ])
    expect(result.entities[1]).toMatchObject({
      entityId: 'entity-b',
      status: 'weak',
      mentionCount: 1,
      salience: 0.9,
      evidence: 'V1 发布计划',
      lastMentionAt: later.toISOString(),
    })
    expect(result.entities[1]?.sources).toEqual([
      { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: 'V1 项目结论', evidence: 'V1 发布计划', mentionedAt: later.toISOString() },
    ])
    expect(result.updatedAt).toBeTruthy()
    sqlite.close()
  })

  it('aggregates applied facts by content fingerprint across sources', async () => {
    const { service, db, sqlite } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-1', title: 'Room 1', data: { id: 'room-1', title: 'Room 1' } }],
      deletedRooms: [],
    })
    db.insert(entitiesTable).values([
      { id: 'entity-a', name: '林薇', kind: '人物', status: 'room' },
    ]).run()
    const now = new Date()
    const later = new Date(now.getTime() + 1_000)
    db.insert(roomSourceMemberships).values([
      { id: 's1', roomId: 'room-1', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', role: 'primary', sourceTitle: 'V1 项目结论' },
      { id: 's2', roomId: 'room-1', sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', role: 'mention', sourceTitle: '设计周报' },
    ]).run()
    db.insert(roomEntityFacts).values([
      { id: 'f1', roomId: 'room-1', factId: 'fact-x', content: '林薇负责 V1 视觉设计', type: '属性', entityIds: ['entity-a', 'entity-gone'], sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', createdAt: now, updatedAt: now },
      { id: 'f2', roomId: 'room-1', factId: 'fact-x', content: '林薇负责 V1 视觉设计', type: '属性', entityIds: ['entity-a'], sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', createdAt: now, updatedAt: later },
      { id: 'f3', roomId: 'room-1', factId: 'fact-y', content: 'V1 目标 7-30 交付', type: '关系', entityIds: [], sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', createdAt: now, updatedAt: now },
      { id: 'f4', roomId: 'room-other', factId: 'fact-z', content: '别的 Room 的事实', type: '属性', entityIds: [], sourceKind: 'mail', sourceId: 'mail-2', sourceVersion: 1, evidenceGroupKey: 'g3', createdAt: now, updatedAt: now },
    ]).run()

    const result = service.roomAppliedEntities('room-1')
    expect(result.facts).toHaveLength(2)
    // sourceCount 降序：fact-x（2 来源）在前；被清理实体（entity-gone）剔除，id/name 对齐。
    expect(result.facts[0]).toMatchObject({
      factId: 'fact-x',
      content: '林薇负责 V1 视觉设计',
      type: '属性',
      entityIds: ['entity-a'],
      entityNames: ['林薇'],
      sourceCount: 2,
      lastMentionAt: later.toISOString(),
    })
    expect(result.facts[0]?.sources).toEqual([
      { sourceKind: 'mail', sourceId: 'mail-1', sourceTitle: '设计周报', evidence: '林薇负责 V1 视觉设计', mentionedAt: later.toISOString() },
      { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: 'V1 项目结论', evidence: '林薇负责 V1 视觉设计', mentionedAt: now.toISOString() },
    ])
    expect(result.facts[1]).toMatchObject({ factId: 'fact-y', entityIds: [], entityNames: [], sourceCount: 1 })
    sqlite.close()
  })

  it('hides projections of trashed documents and restores them on revive', async () => {
    const { service, db, sqlite } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-1', title: 'Room 1', data: { id: 'room-1', title: 'Room 1' } }],
      deletedRooms: [],
    })
    db.insert(entitiesTable).values([
      { id: 'entity-ts', name: 'TypeScript', kind: '主题', status: 'weak' },
      { id: 'entity-lin', name: '林薇', kind: '人物', status: 'room' },
    ]).run()
    const now = new Date()
    db.insert(documentsTable).values({
      id: 'doc-1', title: 'TypeScript 入门指南', contentJson: { type: 'doc' }, version: 1, deletedAt: now,
    }).run()
    db.insert(roomSourceMemberships).values([
      { id: 's1', roomId: 'room-1', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', role: 'primary', sourceTitle: 'TypeScript 入门指南' },
      { id: 's2', roomId: 'room-1', sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', role: 'mention', sourceTitle: '设计周报' },
    ]).run()
    db.insert(roomEntityMentions).values([
      { id: 'm1', roomId: 'room-1', entityId: 'entity-ts', sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', salience: 0.8, createdAt: now, updatedAt: now },
      { id: 'm2', roomId: 'room-1', entityId: 'entity-lin', sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', salience: 0.8, createdAt: now, updatedAt: now },
    ]).run()
    db.insert(roomEntityFacts).values([
      { id: 'f1', roomId: 'room-1', factId: 'fact-ts', content: 'TypeScript 是 JavaScript 的超集', type: '属性', entityIds: ['entity-ts'], sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceVersion: 1, evidenceGroupKey: 'g1', createdAt: now, updatedAt: now },
      { id: 'f2', roomId: 'room-1', factId: 'fact-mail', content: '林薇负责 V1 视觉设计', type: '属性', entityIds: ['entity-lin'], sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'g2', createdAt: now, updatedAt: now },
    ]).run()

    // 回收站文档的实体与事实读侧剔除；投影像保留（恢复即回，不重抽）。
    const trashed = service.roomAppliedEntities('room-1')
    expect(trashed.entities.map((entity) => entity.name)).toEqual(['林薇'])
    expect(trashed.facts.map((fact) => fact.factId)).toEqual(['fact-mail'])

    db.update(documentsTable).set({ deletedAt: null }).where(eq(documentsTable.id, 'doc-1')).run()
    const restored = service.roomAppliedEntities('room-1')
    // sort() 按码点：ASCII 的 TypeScript 排在中文名之前。
    expect(restored.entities.map((entity) => entity.name).sort()).toEqual(['TypeScript', '林薇'])
    expect(restored.facts.map((fact) => fact.factId).sort()).toEqual(['fact-mail', 'fact-ts'])
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

describe('RoomOverviewService', () => {
  it('builds typed, evidence-backed claims for every overview section', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-structured',
        title: 'Structured Room',
        data: {
          id: 'room-structured',
          title: 'Structured Room',
          brief: {
            background: '准备 V1 交付', goal: '九月发布', status: '正在联调',
            risks: ['法务审批可能延期'], decisions: ['先发布桌面版'],
          },
          generatedContext: {
            nextSteps: ['整理发布说明'],
            actionItems: [
              { id: 'task-1', title: '完成验收', owner: '林薇', dueDate: '2026-09-01T09:00:00.000Z', status: '进行中', priority: '高', source: { type: 'task', name: '项目任务', objectId: 'task-1' } },
              { id: 'task-done', title: '已完成事项', status: '已完成' },
            ],
            meetings: [{ id: 'meeting-1', title: '发布评审', when: '2026-08-30T02:00:00.000Z', sourceTitle: '团队日历' }],
          },
          timeline: [{ time: '2026-08-15T10:00:00.000Z', title: 'Agent 初步判断', description: '可能进入验收', generated: true }],
        },
      }],
      deletedRooms: [],
    })
    db.insert(entitiesTable).values({
      id: 'entity-owner', name: '林薇', kind: '人物', status: 'ready', summary: 'V1 负责人',
    }).run()
    const observedAt = new Date('2026-08-14T10:00:00.000Z')
    db.insert(roomSourceMemberships).values({
      id: 'source-structured', roomId: 'room-structured', sourceKind: 'mail', sourceId: 'mail-1',
      sourceVersion: 3, evidenceGroupKey: 'group-1', role: 'primary', sourceTitle: '交付周报',
    }).run()
    db.insert(roomEntityMentions).values({
      id: 'mention-owner', roomId: 'room-structured', entityId: 'entity-owner', sourceKind: 'mail',
      sourceId: 'mail-1', sourceVersion: 3, evidenceGroupKey: 'group-1', salience: 0.9,
      evidence: '林薇负责 V1', createdAt: observedAt, updatedAt: observedAt,
    }).run()
    db.insert(roomEntityFacts).values({
      id: 'fact-row-1', roomId: 'room-structured', factId: 'fact-release', content: 'V1 已进入联调', type: '属性',
      entityIds: ['entity-owner'], sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 3,
      evidenceGroupKey: 'group-1', createdAt: observedAt, updatedAt: observedAt,
    }).run()

    const projection = new RoomOverviewService(db, service).refresh('room-structured')
    expect(projection.overview.map((item) => item.data)).toEqual([
      { kind: 'overview', aspect: 'summary' },
      { kind: 'overview', aspect: 'goal' },
    ])
    expect(projection.status.map((item) => item.data)).toEqual([
      { kind: 'status', category: 'conclusion', state: 'active' },
      { kind: 'status', category: 'problem', state: 'active' },
      { kind: 'status', category: 'conclusion', state: 'active' },
    ])
    expect(projection.nextSteps.map((item) => [item.text, item.data?.kind === 'next_step' ? item.data.itemType : null]))
      .toEqual([['发布评审', 'schedule'], ['完成验收', 'task'], ['整理发布说明', 'suggestion']])
    expect(projection.nextSteps[1]?.data).toMatchObject({
      actionId: 'task-1', owner: '林薇', dueAt: '2026-09-01T09:00:00.000Z', priority: 'high',
    })
    expect(projection.entities[0]).toMatchObject({
      id: expect.stringMatching(/^entities:/),
      evidence: [{ sourceKind: 'mail', sourceId: 'mail-1', sourceTitle: '交付周报', excerpt: '林薇负责 V1' }],
      data: { kind: 'entity', entityId: 'entity-owner', entityKind: '人物', entityStatus: 'ready', salience: 0.9, mentionCount: 1 },
    })
    expect(projection.timeline.map((item) => item.text)).toEqual(['Agent 初步判断：可能进入验收', 'V1 已进入联调'])
    expect(projection.timeline[0]?.data).toMatchObject({ kind: 'timeline', certainty: 'inference' })
    expect(projection.timeline[1]).toMatchObject({
      id: expect.stringMatching(/^timeline:/),
      data: { kind: 'timeline', eventType: 'fact', certainty: 'fact' },
      evidence: [{ sourceKind: 'mail', sourceId: 'mail-1', excerpt: 'V1 已进入联调' }],
    })
    expect(projection.freshness).toMatchObject({ state: 'fresh', staleSince: null })
  })

  it('derives timeline events from linked documents and routed calendar sources', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-events', title: 'Events Room', data: { id: 'room-events', title: 'Events Room' } }],
      deletedRooms: [],
    })
    const createdAt = new Date('2026-08-10T08:00:00.000Z')
    const updatedAt = new Date('2026-08-20T08:00:00.000Z')
    db.insert(documentsTable).values([
      { id: 'doc-created', title: '需求说明', contentJson: { type: 'doc' }, version: 1, status: 'active', createdAt, updatedAt: createdAt },
      { id: 'doc-updated', title: '评审纪要', contentJson: { type: 'doc' }, version: 2, status: 'active', createdAt: new Date('2026-08-05T08:00:00.000Z'), updatedAt },
      { id: 'doc-draft', title: '草稿文档', contentJson: { type: 'doc' }, version: 1, status: 'draft', createdAt, updatedAt: createdAt },
      { id: 'doc-deleted', title: '已删文档', contentJson: { type: 'doc' }, version: 1, status: 'active', deletedAt: createdAt, createdAt, updatedAt: createdAt },
    ]).run()
    db.insert(roomDocumentLinks).values([
      { roomId: 'room-events', documentId: 'doc-created' },
      { roomId: 'room-events', documentId: 'doc-updated' },
      { roomId: 'room-events', documentId: 'doc-draft' },
      { roomId: 'room-events', documentId: 'doc-deleted' },
    ]).run()
    db.insert(roomSourceMemberships).values([
      { id: 'cal-source', roomId: 'room-events', sourceKind: 'calendar-event', sourceId: 'cal-1', sourceVersion: 2, evidenceGroupKey: 'cal', role: 'primary', sourceTitle: '发布评审' },
      { id: 'cal-plain', roomId: 'room-events', sourceKind: 'calendar-event', sourceId: 'cal-2', sourceVersion: 1, evidenceGroupKey: 'cal2', role: 'mention', sourceTitle: '明天对齐会' },
    ]).run()
    db.insert(routeDecisions).values([
      {
        id: 'decision-cal-1-old', sourceKind: 'calendar-event', sourceId: 'cal-1', sourceVersion: 1,
        sourceTitle: '发布评审（旧）', sourceMarkdown: '# 发布评审（旧）\n\n时间：2026-08-01T02:00:00.000Z → 2026-08-01T03:00:00.000Z',
        confidence: 0.9, status: 'confirmed',
      },
      {
        id: 'decision-cal-1', sourceKind: 'calendar-event', sourceId: 'cal-1', sourceVersion: 2,
        sourceTitle: '发布评审', sourceMarkdown: '# 发布评审\n\n时间：2026-08-18T02:00:00.000Z → 2026-08-18T03:00:00.000Z（Asia/Shanghai）',
        confidence: 0.9, status: 'confirmed',
      },
      {
        id: 'decision-cal-2', sourceKind: 'calendar-event', sourceId: 'cal-2', sourceVersion: 1,
        sourceTitle: '明天对齐会', sourceMarkdown: '# 明天对齐会\n\n时间：明天 10:00 → 明天 11:00',
        confidence: 0.8, status: 'confirmed',
      },
    ]).run()

    const projection = new RoomOverviewService(db, service).refresh('room-events')
    expect(projection.timeline.map((item) => item.text)).toEqual([
      '《评审纪要》更新至第 2 版：文档内容已保存新版本。',
      '发布评审',
      '《需求说明》已收录于 Room：已作为资料归入本 Room，参与后续上下文生成。',
      '明天对齐会',
    ])
    expect(projection.timeline[0]).toMatchObject({
      occurredAt: updatedAt.toISOString(),
      evidence: [{ sourceKind: 'everroom-doc', sourceId: 'doc-updated', sourceTitle: '评审纪要' }],
      data: { kind: 'timeline', eventType: 'update' },
    })
    expect(projection.timeline[1]).toMatchObject({
      occurredAt: '2026-08-18T02:00:00.000Z',
      evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' }],
      data: { kind: 'timeline', eventType: 'meeting' },
    })
    expect(projection.timeline[2]).toMatchObject({
      occurredAt: createdAt.toISOString(),
      data: { kind: 'timeline', eventType: 'source' },
    })
    // 自然语言时间解析不到：无日期，沉底但不丢事件。
    expect(projection.timeline[3]).toMatchObject({ occurredAt: null })
  })

  it('parses the provider from connector refs on the snapshot fallback path', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-ref', title: 'Ref Room', data: { id: 'room-ref', title: 'Ref Room' } }],
      deletedRooms: [],
    })
    // 域表未回填时日程走路由快照回退：membership sourceId 是 connector ref
    // （connector:google-calendar:…），provider 从 ref 解析供桌面打品牌图标。
    db.insert(roomSourceMemberships).values({
      id: 'cal-ref', roomId: 'room-ref', sourceKind: 'calendar-event',
      sourceId: 'connector:google-calendar:04361d8a:calendar:evt-1',
      sourceVersion: 1, evidenceGroupKey: 'ref', role: 'primary', sourceTitle: '开学典礼',
    }).run()
    db.insert(routeDecisions).values({
      id: 'decision-ref', sourceKind: 'calendar-event',
      sourceId: 'connector:google-calendar:04361d8a:calendar:evt-1', sourceVersion: 1,
      sourceTitle: '开学典礼', sourceMarkdown: '# 开学典礼\n\n时间：2026-09-01T02:00:00.000Z → 2026-09-01T03:00:00.000Z',
      confidence: 0.9, status: 'confirmed',
    }).run()

    const projection = new RoomOverviewService(db, service).refresh('room-ref')
    expect(projection.timeline[0]).toMatchObject({
      text: '开学典礼',
      data: { kind: 'timeline', eventType: 'meeting', provider: 'google-calendar' },
    })
  })

  it('keeps junk calendar titles and low-importance facts out of the timeline', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-curate', title: 'Curate Room', data: { id: 'room-curate', title: 'Curate Room' } }],
      deletedRooms: [],
    })
    // 占位/纯数字标题的流水日程没有信息量，不进时间轴；正常标题保留。
    db.insert(roomSourceMemberships).values([
      { id: 'cal-ok', roomId: 'room-curate', sourceKind: 'calendar-event', sourceId: 'cal-ok', sourceVersion: 1, evidenceGroupKey: 'cal-ok', role: 'primary', sourceTitle: '季度评审' },
      { id: 'cal-num', roomId: 'room-curate', sourceKind: 'calendar-event', sourceId: 'cal-num', sourceVersion: 1, evidenceGroupKey: 'cal-num', role: 'primary', sourceTitle: '111' },
      { id: 'cal-blank', roomId: 'room-curate', sourceKind: 'calendar-event', sourceId: 'cal-blank', sourceVersion: 1, evidenceGroupKey: 'cal-blank', role: 'primary', sourceTitle: '(无标题)' },
    ]).run()
    db.insert(routeDecisions).values([
      { id: 'decision-cal-ok', sourceKind: 'calendar-event', sourceId: 'cal-ok', sourceVersion: 1, sourceTitle: '季度评审', sourceMarkdown: '# 季度评审\n\n时间：2026-08-12T02:00:00.000Z → 2026-08-12T03:00:00.000Z', confidence: 0.9, status: 'confirmed' },
      { id: 'decision-cal-num', sourceKind: 'calendar-event', sourceId: 'cal-num', sourceVersion: 1, sourceTitle: '111', sourceMarkdown: '# 111\n\n时间：2026-08-13T02:00:00.000Z → 2026-08-13T03:00:00.000Z', confidence: 0.9, status: 'confirmed' },
      { id: 'decision-cal-blank', sourceKind: 'calendar-event', sourceId: 'cal-blank', sourceVersion: 1, sourceTitle: '(无标题)', sourceMarkdown: '# (无标题)\n\n时间：2026-08-14T02:00:00.000Z → 2026-08-14T03:00:00.000Z', confidence: 0.9, status: 'confirmed' },
    ]).run()
    // 7 条事实：跨来源交叉确认 1 条 + 单来源 6 条。时间轴只留重要度前 5——
    // 交叉确认（sourceCount 2）+ 涉及实体显著度（0.9）最高，最旧的两条单来源事实被挤掉。
    db.insert(roomSourceMemberships).values([
      { id: 'src-doc-9', roomId: 'room-curate', sourceKind: 'everroom-doc', sourceId: 'doc-9', sourceVersion: 1, evidenceGroupKey: 'src-doc-9', role: 'primary', sourceTitle: 'V1 项目结论' },
      { id: 'src-mail-9', roomId: 'room-curate', sourceKind: 'mail', sourceId: 'mail-9', sourceVersion: 1, evidenceGroupKey: 'src-mail-9', role: 'mention', sourceTitle: '设计周报' },
      { id: 'src-mail-10', roomId: 'room-curate', sourceKind: 'mail', sourceId: 'mail-10', sourceVersion: 1, evidenceGroupKey: 'src-mail-10', role: 'mention', sourceTitle: '杂项邮件' },
    ]).run()
    db.insert(entitiesTable).values({
      id: 'entity-lin', name: '林薇', kind: '人物', status: 'ready', summary: 'V1 负责人',
    }).run()
    const mentioned = (day: number) => new Date(`2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`)
    db.insert(roomEntityMentions).values({
      id: 'mention-lin', roomId: 'room-curate', entityId: 'entity-lin', sourceKind: 'mail',
      sourceId: 'mail-9', sourceVersion: 1, evidenceGroupKey: 'src-mail-9', salience: 0.9,
      evidence: '林薇负责 V1', createdAt: mentioned(10), updatedAt: mentioned(10),
    }).run()
    const factRow = (id: string, factId: string, content: string, entityIds: string[], sourceId: string, day: number) => ({
      id, roomId: 'room-curate', factId, content, type: '属性' as const, entityIds,
      sourceKind: 'mail' as const, sourceId, sourceVersion: 1, evidenceGroupKey: `src-${sourceId}`,
      createdAt: mentioned(day), updatedAt: mentioned(day),
    })
    db.insert(roomEntityFacts).values([
      { id: 'fx-1', roomId: 'room-curate', factId: 'fact-cross', content: '林薇负责 V1 视觉设计', type: '属性', entityIds: ['entity-lin'], sourceKind: 'everroom-doc', sourceId: 'doc-9', sourceVersion: 1, evidenceGroupKey: 'src-doc-9', createdAt: mentioned(10), updatedAt: mentioned(10) },
      { id: 'fx-2', roomId: 'room-curate', factId: 'fact-cross', content: '林薇负责 V1 视觉设计', type: '属性', entityIds: ['entity-lin'], sourceKind: 'mail', sourceId: 'mail-9', sourceVersion: 1, evidenceGroupKey: 'src-mail-9', createdAt: mentioned(10), updatedAt: mentioned(10) },
      factRow('fn-1', 'fact-n1', '新事实一', [], 'mail-10', 9),
      factRow('fn-2', 'fact-n2', '新事实二', ['entity-lin'], 'mail-10', 8),
      factRow('fn-3', 'fact-n3', '新事实三', [], 'mail-10', 7),
      factRow('fn-4', 'fact-n4', '新事实四', [], 'mail-10', 6),
      factRow('fo-2', 'fact-old2', '四月旧事实二', [], 'mail-10', 2),
      factRow('fo-1', 'fact-old1', '四月旧事实一', [], 'mail-10', 1),
    ]).run()

    const projection = new RoomOverviewService(db, service).refresh('room-curate')
    const texts = projection.timeline.map((item) => item.text)
    expect(texts).toContain('季度评审')
    expect(texts).not.toContain('111')
    expect(texts).not.toContain('(无标题)')
    const factTexts = projection.timeline
      .map((item) => item.data?.kind === 'timeline' && item.data.eventType === 'fact' ? item.text : null)
      .filter(Boolean)
    expect(factTexts).toHaveLength(5)
    // 交叉确认 + 高显著度实体的事实排最前；最旧的两条单来源事实被挤掉。
    expect(factTexts[0]).toBe('林薇负责 V1 视觉设计')
    expect(factTexts).toContain('新事实二')
    expect(factTexts).not.toContain('四月旧事实一')
    expect(factTexts).not.toContain('四月旧事实二')
  })

  it('projects connector calendar rows and todos deterministically into nextSteps and timeline', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-connector',
        title: 'Connector Room',
        data: {
          id: 'room-connector',
          title: 'Connector Room',
          // LLM 生成的 meeting：一条与连接器日历同 sourceId（应被确定性 claim 取代），一条非连接器来源（保留）。
          generatedContext: {
            meetings: [
              { id: 'cal-conn-1', title: '发射协调会', when: '2026-12-01T02:00:00.000Z', sourceTitle: '发射协调会' },
              { id: 'legacy-meet', title: '旧周会', when: '2026-11-01T02:00:00.000Z', sourceTitle: '旧周会' },
            ],
          },
        },
      }],
      deletedRooms: [],
    })
    const syncedAt = new Date('2026-08-20T08:00:00.000Z')
    db.insert(connectorCalendarEvents).values({
      id: 'cal-conn-1', ownerId: 'local-user', service: 'google_calendar', connectionName: 'default',
      sourceRecordId: 'event-source-1', sourceUpdatedAt: syncedAt, syncedAt, schemaVersion: 1, promptVersion: 1,
      contentHash: 'cal-hash', extensionPayload: null,
      eventId: 'event-1', title: '发射协调会', description: '对齐发射窗口',
      organizer: null, attendees: [], startAt: new Date('2026-12-01T02:00:00.000Z'),
      endAt: new Date('2026-12-01T03:00:00.000Z'), allDay: false, status: 'confirmed', location: '发射场',
    }).run()
    db.insert(connectorTodos).values([
      {
        id: 'todo-1', ownerId: 'local-user', service: 'google_tasks', connectionName: 'default',
        sourceRecordId: 'task-source-1', sourceUpdatedAt: syncedAt, syncedAt, schemaVersion: 1, promptVersion: 1,
        contentHash: 'todo-hash-1', extensionPayload: null,
        todoId: 'task-1', title: '补充天线参数', notes: '', status: 'needsAction',
        dueAt: new Date('2026-09-05T01:00:00.000Z'), completedAt: null, priority: 'high',
        listId: 'list-1', listName: '卫星项目',
      },
      {
        id: 'todo-done', ownerId: 'local-user', service: 'google_tasks', connectionName: 'default',
        sourceRecordId: 'task-source-2', sourceUpdatedAt: syncedAt, syncedAt, schemaVersion: 1, promptVersion: 1,
        contentHash: 'todo-hash-2', extensionPayload: null,
        todoId: 'task-2', title: '已完成待办', notes: '', status: 'completed',
        dueAt: new Date('2026-08-01T01:00:00.000Z'), completedAt: new Date('2026-08-02T01:00:00.000Z'), priority: null,
        listId: 'list-1', listName: '卫星项目',
      },
    ]).run()
    db.insert(roomSourceMemberships).values([
      { id: 'conn-cal', roomId: 'room-connector', sourceKind: 'calendar-event', sourceId: 'cal-conn-1', sourceVersion: 1, evidenceGroupKey: 'cal', role: 'primary', sourceTitle: '发射协调会', updatedAt: new Date('2026-08-21T08:00:00.000Z') },
      { id: 'conn-todo-1', roomId: 'room-connector', sourceKind: 'todo', sourceId: 'todo-1', sourceVersion: 1, evidenceGroupKey: 't1', role: 'primary', sourceTitle: '补充天线参数', updatedAt: new Date('2026-08-20T09:00:00.000Z') },
      { id: 'conn-todo-done', roomId: 'room-connector', sourceKind: 'todo', sourceId: 'todo-done', sourceVersion: 1, evidenceGroupKey: 't2', role: 'primary', sourceTitle: '已完成待办', updatedAt: new Date('2026-08-20T09:00:00.000Z') },
    ]).run()

    // 房间行刚被 saveSnapshot 写成 now：回拨，让连接器路由时间成为水位最大者。
    db.update(contextRooms).set({ updatedAt: new Date('2026-08-19T08:00:00.000Z') }).where(eq(contextRooms.id, 'room-connector')).run()

    const projection = new RoomOverviewService(db, service).refresh('room-connector')
    // 确定性 schedule claim：来自 connector 域表的精确开始时间；同 sourceId 的 LLM meeting 不再重复。
    const schedules = projection.nextSteps.filter((item) => item.data?.kind === 'next_step' && item.data.itemType === 'schedule')
    // 按 dueAt 升序：旧周会（11 月）在前，发射协调会（12 月）在后；同 sourceId 的 LLM claim 只保留确定性一条。
    expect(schedules.map((item) => item.text)).toEqual(['旧周会', '发射协调会'])
    expect(schedules[1]).toMatchObject({
      evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-conn-1', sourceTitle: '发射协调会' }],
      data: { kind: 'next_step', itemType: 'schedule', dueAt: '2026-12-01T02:00:00.000Z', status: 'scheduled', provider: 'google_calendar' },
    })
    expect(projection.nextSteps.filter((item) => item.text === '发射协调会')).toHaveLength(1)
    // 确定性 task claim：未完成待办进入 nextSteps；已完成的不进。
    const tasks = projection.nextSteps.filter((item) => item.data?.kind === 'next_step' && item.data.itemType === 'task')
    expect(tasks.map((item) => item.text)).toEqual(['补充天线参数'])
    expect(tasks[0]).toMatchObject({
      evidence: [{ sourceKind: 'todo', sourceId: 'todo-1', sourceTitle: '补充天线参数' }],
      data: { kind: 'next_step', itemType: 'task', dueAt: '2026-09-05T01:00:00.000Z', status: 'needsAction', priority: 'high' },
    })
    // 时间轴：待办任务事件（未完成取 dueAt、已完成取 completedAt）与日历会议事件（域表精确时间）。
    const timelineByTitle = new Map(projection.timeline.map((item) => [item.text, item]))
    expect(timelineByTitle.get('补充天线参数')).toMatchObject({
      occurredAt: '2026-09-05T01:00:00.000Z',
      evidence: [{ sourceKind: 'todo', sourceId: 'todo-1' }],
      data: { kind: 'timeline', eventType: 'task', certainty: 'fact' },
    })
    expect(timelineByTitle.get('已完成待办')).toMatchObject({ occurredAt: '2026-08-02T01:00:00.000Z' })
    expect(timelineByTitle.get('发射协调会')).toMatchObject({
      occurredAt: '2026-12-01T02:00:00.000Z',
      // 域表 service 透传为 claim data.provider——桌面据此打服务商品牌图标。
      data: { kind: 'timeline', eventType: 'meeting', provider: 'google_calendar' },
    })
    // freshness 水位用连接器源的路由进房时间（membership.updatedAt）：
    // 事件 startedAt/dueAt 不参与——历史回填也能推进水位，未来日程不会把水位顶到未来。
    expect(projection.freshness).toMatchObject({ sourceUpdatedAt: '2026-08-21T08:00:00.000Z' })
  })

  it('keeps upcoming schedules visible when the room holds many past calendar events', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-many', title: 'Many Events', data: { id: 'room-many', title: 'Many Events' } }],
      deletedRooms: [],
    })
    const syncedAt = new Date('2026-08-20T08:00:00.000Z')
    const pastEvents: Array<typeof connectorCalendarEvents.$inferInsert> = Array.from({ length: 24 }, (_, index) => ({
      id: `cal-past-${index}`, ownerId: 'local-user', service: 'google_calendar', connectionName: 'default',
      sourceRecordId: `past-${index}`, sourceUpdatedAt: syncedAt, syncedAt, schemaVersion: 1, promptVersion: 1,
      contentHash: `hash-past-${index}`, extensionPayload: null,
      eventId: `past-${index}`, title: `历史事件${index}`, description: '',
      organizer: null, attendees: [], startAt: new Date(Date.UTC(2020, 0, index + 1)),
      endAt: null, allDay: true, status: 'confirmed', location: null,
    }))
    const upcoming = ([
      // 今天本地 00:30 已开始：仍要进日程 claim（桌面「今日日程」显示当天已开始的日程）
      { daysAhead: 0, title: '今天已开始的晨会', startAt: new Date(new Date().setHours(0, 30, 0, 0)) },
      { daysAhead: 3, title: '即将到来的开学典礼' },
      { daysAhead: 10, title: '较远的家长会' },
    ] as Array<{ daysAhead: number; title: string; startAt?: Date }>).map((event, index): typeof connectorCalendarEvents.$inferInsert => ({
      id: `cal-future-${index}`, ownerId: 'local-user', service: 'google_calendar', connectionName: 'default',
      sourceRecordId: `future-${index}`, sourceUpdatedAt: syncedAt, syncedAt, schemaVersion: 1, promptVersion: 1,
      contentHash: `hash-future-${index}`, extensionPayload: null,
      eventId: `future-${index}`, title: event.title, description: '',
      organizer: null, attendees: [], startAt: event.startAt ?? new Date(Date.now() + event.daysAhead * 86_400_000),
      endAt: null, allDay: false, status: 'confirmed', location: null,
    }))
    db.insert(connectorCalendarEvents).values([...pastEvents, ...upcoming]).run()
    db.insert(roomSourceMemberships).values([...pastEvents, ...upcoming].map((event): typeof roomSourceMemberships.$inferInsert => ({
      id: `mem-${event.id}`, roomId: 'room-many', sourceKind: 'calendar-event', sourceId: event.id,
      sourceVersion: 1, evidenceGroupKey: event.id, role: 'primary', sourceTitle: event.title,
    }))).run()

    const projection = new RoomOverviewService(db, service).refresh('room-many')
    // 日程 claim 先过滤「今天日界起」再截断：27 条里 24 条历史不会挤掉未来日程，按时间升序；
    // 今天已开始（00:30）的日程保留——桌面「今日日程」靠它显示当天已过开始时间的日程。
    const schedules = projection.nextSteps.filter((item) => item.data?.kind === 'next_step' && item.data.itemType === 'schedule')
    expect(schedules.map((item) => item.text)).toEqual(['今天已开始的晨会', '即将到来的开学典礼', '较远的家长会'])
    // 时间轴取最新 20 条：最老的历史事件被挤出，未来事件保留。
    const timelineTitles = projection.timeline.map((item) => item.text)
    expect(timelineTitles).not.toContain('历史事件0')
    expect(timelineTitles).toContain('今天已开始的晨会')
    expect(timelineTitles).toContain('即将到来的开学典礼')
    expect(timelineTitles).toContain('较远的家长会')
  })

  it('pins fact timeline entries to their first mention instead of the latest', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-facts', title: 'Facts Room', data: { id: 'room-facts', title: 'Facts Room' } }],
      deletedRooms: [],
    })
    const firstMentionAt = new Date('2026-07-01T08:00:00.000Z')
    const latestMentionAt = new Date('2026-08-25T08:00:00.000Z')
    db.insert(roomSourceMemberships).values([
      { id: 'fact-source-a', roomId: 'room-facts', sourceKind: 'mail', sourceId: 'mail-a', sourceVersion: 1, evidenceGroupKey: 'a', role: 'primary', sourceTitle: '七月周报' },
      { id: 'fact-source-b', roomId: 'room-facts', sourceKind: 'mail', sourceId: 'mail-b', sourceVersion: 1, evidenceGroupKey: 'b', role: 'mention', sourceTitle: '八月周报' },
    ]).run()
    db.insert(roomEntityFacts).values([
      { id: 'fact-row-a', roomId: 'room-facts', factId: 'fact-pin', content: 'V1 已进入联调', type: '属性', entityIds: [], sourceKind: 'mail', sourceId: 'mail-a', sourceVersion: 1, evidenceGroupKey: 'a', createdAt: firstMentionAt, updatedAt: firstMentionAt },
      { id: 'fact-row-b', roomId: 'room-facts', factId: 'fact-pin', content: 'V1 已进入联调', type: '属性', entityIds: [], sourceKind: 'mail', sourceId: 'mail-b', sourceVersion: 1, evidenceGroupKey: 'b', createdAt: latestMentionAt, updatedAt: latestMentionAt },
    ]).run()

    const projection = new RoomOverviewService(db, service).refresh('room-facts')
    expect(projection.timeline).toHaveLength(1)
    expect(projection.timeline[0]).toMatchObject({
      occurredAt: firstMentionAt.toISOString(),
      evidence: [
        { sourceKind: 'mail', sourceId: 'mail-b', sourceTitle: '八月周报' },
        { sourceKind: 'mail', sourceId: 'mail-a', sourceTitle: '七月周报' },
      ],
    })
  })

  it('keeps a multi-source fact when a correction removes only one source', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-evidence', title: 'Evidence Room', data: { id: 'room-evidence', title: 'Evidence Room' } }],
      deletedRooms: [],
    })
    const now = new Date()
    db.insert(roomSourceMemberships).values([
      { id: 'source-a', roomId: 'room-evidence', sourceKind: 'mail', sourceId: 'mail-a', sourceVersion: 1, evidenceGroupKey: 'a', role: 'primary', sourceTitle: '邮件 A' },
      { id: 'source-b', roomId: 'room-evidence', sourceKind: 'calendar-event', sourceId: 'meeting-b', sourceVersion: 1, evidenceGroupKey: 'b', role: 'primary', sourceTitle: '会议 B' },
    ]).run()
    db.insert(roomEntityFacts).values([
      { id: 'fact-a', roomId: 'room-evidence', factId: 'shared-fact', content: '发布日期为九月一日', type: '属性', entityIds: [], sourceKind: 'mail', sourceId: 'mail-a', sourceVersion: 1, evidenceGroupKey: 'a', createdAt: now, updatedAt: now },
      { id: 'fact-b', roomId: 'room-evidence', factId: 'shared-fact', content: '发布日期为九月一日', type: '属性', entityIds: [], sourceKind: 'calendar-event', sourceId: 'meeting-b', sourceVersion: 1, evidenceGroupKey: 'b', createdAt: now, updatedAt: now },
    ]).run()
    const overviews = new RoomOverviewService(db, service)
    const original = overviews.refresh('room-evidence')
    const proposal = overviews.propose('room-evidence', {
      operation: 'source_remove', section: 'timeline',
      targetSource: { sourceKind: 'mail', sourceId: 'mail-a', sourceTitle: '邮件 A' },
      rationale: '邮件被错误归入本 Room', entryPoint: 'overview',
    })
    const applied = overviews.apply('room-evidence', proposal.id).overview
    expect(original.timeline[0]?.evidence).toHaveLength(2)
    expect(applied.timeline).toHaveLength(1)
    expect(applied.timeline[0]).toMatchObject({
      corrected: true,
      evidence: [{ sourceKind: 'calendar-event', sourceId: 'meeting-b', sourceTitle: '会议 B' }],
    })
  })

  it('incrementally refreshes fact sections and marks semantic sections stale', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-incremental', title: 'Incremental Room',
        data: { id: 'room-incremental', title: 'Incremental Room', generatedContext: { overview: '保留的概览', status: '保留的状态', nextSteps: ['保留的建议'] } },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    const initial = overviews.refresh('room-incremental')
    const observedAt = new Date(Date.now() + 60_000)
    db.insert(roomSourceMemberships).values({
      id: 'incremental-source', roomId: 'room-incremental', sourceKind: 'mail', sourceId: 'mail-new',
      sourceVersion: 1, evidenceGroupKey: 'incremental', role: 'primary', sourceTitle: '最新周报',
    }).run()
    db.insert(roomEntityFacts).values({
      id: 'incremental-fact-row', roomId: 'room-incremental', factId: 'incremental-fact',
      content: '联调已经完成', type: '属性', entityIds: [], sourceKind: 'mail', sourceId: 'mail-new',
      sourceVersion: 1, evidenceGroupKey: 'incremental', createdAt: observedAt, updatedAt: observedAt,
    }).run()

    const updated = overviews.get('room-incremental')
    expect(updated.revision).toBe(initial.revision + 1)
    expect(updated.overview[0]?.text).toBe('保留的概览')
    expect(updated.status[0]?.text).toBe('保留的状态')
    expect(updated.nextSteps.map((item) => item.text)).toContain('保留的建议')
    expect(updated.timeline[0]).toMatchObject({ text: '联调已经完成', origin: 'fact' })
    expect(updated).toMatchObject({
      stale: true,
      freshness: {
        state: 'stale',
        sourceUpdatedAt: observedAt.toISOString(),
        staleSections: ['overview', 'status', 'next_steps'],
      },
    })
    expect(overviews.get('room-incremental').revision).toBe(updated.revision)
  })

  it('persists confirmed corrections outside the Room snapshot and restores content after revoke', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-overview',
        title: 'Overview Room',
        data: {
          id: 'room-overview',
          title: 'Overview Room',
          brief: { background: 'Original overview', goal: 'Ship', status: 'Blocked by budget' },
          generatedContext: { overview: 'Original overview', status: 'Blocked by budget', nextSteps: ['Wait'] },
          timeline: [],
        },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    const original = overviews.get('room-overview')
    const proposal = overviews.propose('room-overview', {
      operation: 'content_replace',
      section: 'status',
      targetClaimId: original.status[0]!.id,
      originalText: 'Blocked by budget',
      replacementText: 'Waiting for legal approval',
      rationale: 'User clarified the actual blocker',
      entryPoint: 'overview',
    })

    expect(overviews.get('room-overview').status[0]?.text).toBe('Blocked by budget')
    const applied = overviews.apply('room-overview', proposal.id)
    expect(applied.overview.status).toMatchObject([{ text: 'Waiting for legal approval', origin: 'user', corrected: true }])
    expect(service.getSnapshot().rooms[0]?.data).toMatchObject({
      generatedContext: { status: 'Blocked by budget' },
    })

    const reloaded = new RoomOverviewService(db, service)
    expect(reloaded.get('room-overview').status[0]?.text).toBe('Waiting for legal approval')
    expect(reloaded.revoke('room-overview', proposal.id).overview.status[0]?.text).toBe('Blocked by budget')
  })

  it('applies a same-session proposal immediately but still rejects cross-session applies', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-agent-correction',
        title: 'Agent Room',
        data: { id: 'room-agent-correction', title: 'Agent Room', brief: { status: 'Old status' }, timeline: [] },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    const proposal = overviews.propose('room-agent-correction', {
      operation: 'content_replace',
      section: 'status',
      originalText: 'Old status',
      replacementText: 'Confirmed status',
      rationale: 'User clarification',
      entryPoint: 'agent',
    }, { sessionId: 'session-1', runId: 'run-propose' })

    // 用户明确请求的修改：同轮同 run 直接应用
    expect(overviews.apply('room-agent-correction', proposal.id, {
      sessionId: 'session-1', runId: 'run-propose',
    }).overview.status[0]?.text).toBe('Confirmed status')

    // 后续确认场景仍受会话边界保护：跨会话拒绝，同会话稍后 run 允许
    const followUp = overviews.propose('room-agent-correction', {
      operation: 'content_replace',
      section: 'status',
      originalText: 'Confirmed status',
      replacementText: 'Final status',
      rationale: 'Second clarification',
      entryPoint: 'agent',
    }, { sessionId: 'session-1', runId: 'run-propose-2' })
    expect(() => overviews.apply('room-agent-correction', followUp.id, {
      sessionId: 'session-2', runId: 'run-confirm',
    })).toThrow('room_correction_confirmation_required')
    expect(overviews.apply('room-agent-correction', followUp.id, {
      sessionId: 'session-1', runId: 'run-confirm',
    }).overview.status[0]?.text).toBe('Final status')
  })

  it('applies a citation-backed correction immediately and validates the current projection', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-citation-correction',
        title: 'Citation Room',
        data: {
          id: 'room-citation-correction',
          title: 'Citation Room',
          generatedContext: { overview: 'This overview is much too long for the Room.' },
        },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    const result = overviews.applyCitation('room-citation-correction', {
      operation: 'content_replace',
      section: 'overview',
      originalText: 'much too long',
      replacementText: 'Short overview.',
      rationale: 'User asked to shorten the cited text',
      entryPoint: 'agent',
    }, { sessionId: 'session-citation', runId: 'run-citation' })

    expect(result.correction).toMatchObject({
      status: 'applied',
      sessionId: 'session-citation',
      originalText: 'much too long',
      replacementText: 'Short overview.',
    })
    expect(result.overview.overview[0]).toMatchObject({ text: 'Short overview.', corrected: true })
    expect(() => overviews.applyCitation('room-citation-correction', {
      operation: 'content_replace',
      section: 'overview',
      originalText: 'text no longer present',
      replacementText: 'Should not apply',
      rationale: 'Stale citation',
      entryPoint: 'agent',
    }, { sessionId: 'session-citation', runId: 'run-stale' }))
      .toThrow('room_correction_citation_not_found')
  })

  it('validates every citation before atomically applying a cross-claim batch', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-citation-batch',
        title: 'Citation Batch Room',
        data: {
          id: 'room-citation-batch',
          title: 'Citation Batch Room',
          brief: { background: 'First overview claim', goal: 'Second overview claim' },
          generatedContext: { overview: 'First overview claim' },
        },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    const original = overviews.get('room-citation-batch')
    expect(original.overview.length).toBeGreaterThanOrEqual(2)
    const [first, second] = original.overview
    const edit = (claim: typeof first, replacementText: string) => ({
      operation: 'content_replace' as const,
      section: 'overview' as const,
      targetClaimId: claim!.id,
      originalText: claim!.text,
      replacementText,
      rationale: 'User shortened a cross-claim selection',
      entryPoint: 'agent' as const,
    })

    expect(() => overviews.applyCitations('room-citation-batch', [
      edit(first, 'Short first claim'),
      { ...edit(second, 'Short second claim'), originalText: 'stale second claim' },
    ], { sessionId: 'session-batch', runId: 'run-invalid-batch' }))
      .toThrow('room_correction_citation_mismatch')
    expect(overviews.list('room-citation-batch')).toHaveLength(0)

    const applied = overviews.applyCitations('room-citation-batch', [
      edit(first, 'Short first claim'),
      edit(second, 'Short second claim'),
    ], { sessionId: 'session-batch', runId: 'run-valid-batch' })
    expect(applied.corrections).toHaveLength(2)
    expect(applied.corrections.every((item) => item.status === 'applied')).toBe(true)
    expect(applied.overview.overview.map((item) => item.text)).toEqual([
      'Short first claim',
      'Short second claim',
    ])
  })

  it('keeps applied corrections on top of a newly generated overview base', async () => {
    let generation = 0
    const dispatchInputs: RoomAgentDispatchInput[] = []
    const dispatcher: RoomAgentDispatcher = {
      dispatch: async (input) => {
        dispatchInputs.push(input)
        generation += 1
        return completedInvocation(JSON.stringify({
          overview: [{ key: 'summary', text: 'Fresh generated overview', aspect: 'summary', evidenceRefs: [] }],
          status: [{
            key: 'primary-blocker',
            text: generation === 1 ? 'Generated old blocker' : 'Rephrased generated blocker',
            category: 'blocker', state: 'active', evidenceRefs: [],
          }],
          nextSteps: [{ key: 'next-release', text: 'Generated next step', evidenceRefs: [] }],
        }))
      },
      dispatchDetached: async () => 'detached',
    }
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{
        id: 'room-regenerate',
        title: 'Regenerate Room',
        data: { id: 'room-regenerate', title: 'Regenerate Room', brief: { status: 'Initial' }, timeline: [] },
      }],
      deletedRooms: [],
    })
    const overviews = new RoomOverviewService(db, service)
    overviews.setRoomAgentDispatcher(dispatcher)
    const firstGenerated = await overviews.regenerate('room-regenerate')
    const proposal = overviews.propose('room-regenerate', {
      operation: 'content_replace',
      section: 'status',
      targetClaimId: firstGenerated.status[0]!.id,
      originalText: firstGenerated.status[0]!.text,
      replacementText: 'User-confirmed blocker',
      rationale: 'The user clarified the blocker',
      entryPoint: 'agent',
    })
    overviews.apply('room-regenerate', proposal.id)

    const regenerated = await overviews.regenerate('room-regenerate')
    expect(regenerated.overview[0]?.text).toBe('Fresh generated overview')
    expect(regenerated.status[0]?.text).toBe('User-confirmed blocker')
    expect(regenerated.status[0]?.id).toBe(firstGenerated.status[0]?.id)
    expect(regenerated.status[0]?.data).toMatchObject({ kind: 'status', category: 'blocker', state: 'active' })
    expect(regenerated.nextSteps[0]?.text).toBe('Generated next step')

    const schema = JSON.parse(await readFile(
      join(bundledAgentDefinitionsDir(), 'context-room/schemas/input.schema.json'),
      'utf8',
    )) as Record<string, unknown>
    const validate = new Ajv({ allErrors: true }).compile(schema)
    for (const input of dispatchInputs) {
      const accepted = validate({ task: input.task, ...input.taskInput })
      expect(accepted, JSON.stringify(validate.errors)).toBe(true)
    }
  })

  it('lists routed mails from connector_emails domain rows, newest first', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-mail', title: 'Mail Room', data: { id: 'room-mail', title: 'Mail Room' } }],
      deletedRooms: [],
    })
    const syncedAt = new Date('2026-08-20T08:00:00.000Z')
    const mailRow = (id: string, subject: string, sentAt: Date, mailService = 'gmail'): typeof connectorEmails.$inferInsert => ({
      id, ownerId: 'local-user', service: mailService, connectionName: 'default',
      sourceRecordId: `rec-${id}`, syncedAt, schemaVersion: 1, promptVersion: 1,
      contentHash: `hash-${id}`, extensionPayload: null,
      messageId: `msg-${id}`, threadId: null, senderName: '张三', senderAddress: 'zhang@example.com',
      recipients: [{ address: 'me@example.com' }], subject, sentAt,
      bodyText: '第一行正文\n\n第二段', labels: [], hasAttachments: id === 'mail-1',
    })
    db.insert(connectorEmails).values([
      mailRow('mail-1', '发布评审通知', new Date('2026-08-21T02:00:00.000Z')),
      mailRow('mail-2', '周报', new Date('2026-08-22T02:00:00.000Z'), 'outlook'),
    ]).run()
    db.insert(roomSourceMemberships).values([
      { id: 'mail-m-1', roomId: 'room-mail', sourceKind: 'mail', sourceId: 'mail-1', sourceVersion: 1, evidenceGroupKey: 'm1', role: 'primary', sourceTitle: '发布评审通知' },
      { id: 'mail-m-2', roomId: 'room-mail', sourceKind: 'mail', sourceId: 'mail-2', sourceVersion: 1, evidenceGroupKey: 'm2', role: 'primary', sourceTitle: '周报' },
    ]).run()

    const mails = new RoomOverviewService(db, service).listRoomMails('room-mail')
    expect(mails.map((mail) => mail.subject)).toEqual(['周报', '发布评审通知'])
    // provider 透传 service 列（outlook 行点亮 Outlook 图标）
    expect(mails[0]?.provider).toBe('outlook')
    expect(mails[1]).toMatchObject({
      sourceId: 'mail-1',
      senderName: '张三',
      senderAddress: 'zhang@example.com',
      sentAt: '2026-08-21T02:00:00.000Z',
      snippet: '第一行正文 第二段',
      hasAttachments: true,
      provider: 'gmail',
    })
  })

  it('falls back to route snapshots for connector-ref mails, parsing sender and time from markdown', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [{ id: 'room-mail', title: 'Mail Room', data: { id: 'room-mail', title: 'Mail Room' } }],
      deletedRooms: [],
    })
    const refSourceId = 'connector:gmail:abc:mail:msg-9'
    db.insert(roomSourceMemberships).values([
      { id: 'mail-ref', roomId: 'room-mail', sourceKind: 'mail', sourceId: refSourceId, sourceVersion: 2, evidenceGroupKey: 'm9', role: 'primary', sourceTitle: '发射窗口确认' },
    ]).run()
    db.insert(routeDecisions).values([
      {
        id: 'decision-mail-old', sourceKind: 'mail', sourceId: refSourceId, sourceVersion: 1,
        sourceTitle: '旧主题', sourceMarkdown: '# 旧主题\n\n发件人：旧 <old@example.com>\n\n时间：2026-08-01T01:00:00.000Z\n\n旧正文',
        confidence: 0.8, status: 'confirmed',
      },
      {
        id: 'decision-mail-new', sourceKind: 'mail', sourceId: refSourceId, sourceVersion: 2,
        sourceTitle: '发射窗口确认', sourceMarkdown: '# 发射窗口确认\n\n发件人：李四 <li@example.com>\n\n时间：2026-08-23T09:30:00.000Z\n\n请确认 9 月 5 日的发射窗口。',
        confidence: 0.9, status: 'confirmed',
      },
    ]).run()

    const mails = new RoomOverviewService(db, service).listRoomMails('room-mail')
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({
      sourceId: refSourceId,
      subject: '发射窗口确认',
      senderName: '李四 <li@example.com>',
      sentAt: '2026-08-23T09:30:00.000Z',
      snippet: '请确认 9 月 5 日的发射窗口。',
      provider: 'gmail',
    })
  })

  it('skips soft-deleted domain rows and never leaks mails routed to another room', async () => {
    const { service, db } = await createHarness()
    service.saveSnapshot({
      rooms: [
        { id: 'room-mail', title: 'Mail Room', data: { id: 'room-mail', title: 'Mail Room' } },
        { id: 'room-other', title: 'Other Room', data: { id: 'room-other', title: 'Other Room' } },
      ],
      deletedRooms: [],
    })
    const syncedAt = new Date('2026-08-20T08:00:00.000Z')
    const mailRow = (id: string): typeof connectorEmails.$inferInsert => ({
      id, ownerId: 'local-user', service: 'gmail', connectionName: 'default',
      sourceRecordId: `rec-${id}`, syncedAt, schemaVersion: 1, promptVersion: 1,
      contentHash: `hash-${id}`, extensionPayload: null,
      messageId: `msg-${id}`, threadId: null, senderName: null, senderAddress: 'noreply@example.com',
      recipients: [], subject: `邮件${id}`, sentAt: new Date('2026-08-22T02:00:00.000Z'),
      bodyText: '正文', labels: [], hasAttachments: false,
    })
    db.insert(connectorEmails).values([
      { ...mailRow('mail-live'), id: 'mail-live' },
      // 软删除行：域表不可见,且无路由快照可回退 → 整条不进清单
      { ...mailRow('mail-del'), id: 'mail-del', deletedAt: syncedAt },
    ]).run()
    db.insert(roomSourceMemberships).values([
      { id: 'mail-live-m', roomId: 'room-mail', sourceKind: 'mail', sourceId: 'mail-live', sourceVersion: 1, evidenceGroupKey: 'lv', role: 'primary', sourceTitle: '邮件mail-live' },
      { id: 'mail-del-m', roomId: 'room-mail', sourceKind: 'mail', sourceId: 'mail-del', sourceVersion: 1, evidenceGroupKey: 'dl', role: 'primary', sourceTitle: '邮件mail-del' },
      { id: 'mail-other-m', roomId: 'room-other', sourceKind: 'mail', sourceId: 'mail-live', sourceVersion: 1, evidenceGroupKey: 'ot', role: 'mention', sourceTitle: '邮件mail-live' },
    ]).run()

    const overviews = new RoomOverviewService(db, service)
    expect(overviews.listRoomMails('room-mail').map((mail) => mail.sourceId)).toEqual(['mail-live'])
    expect(overviews.listRoomMails('room-other').map((mail) => mail.sourceId)).toEqual(['mail-live'])
    // 未知 Room 报 404 级错误，与其他概览读取一致
    expect(() => overviews.listRoomMails('room-mail-not-exist')).toThrowError('context_room_not_found')
  })
})
