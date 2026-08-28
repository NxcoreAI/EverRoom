import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  connectorEmails,
  documents as documentsTable,
  entities,
  ingestEvents,
  jobs,
  roomEntityFacts,
  roomSourceMemberships,
  rooms,
} from '../src/infrastructure/database/schema.js'
import {
  ROOM_RELATION_INDEX_JOB_TYPE,
  RoomRelationRegistry,
  factFingerprint,
} from '../src/modules/knowledge/room-relations.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'nxcore-room-relations-'))
  directories.push(directory)
  const database = createDatabase(join(directory, 'gateway.sqlite'), resolve('drizzle'))
  return { ...database, registry: new RoomRelationRegistry(database.db) }
}

function addRooms(db: Awaited<ReturnType<typeof harness>>['db'], count: number) {
  for (let index = 0; index < count; index += 1) {
    db.insert(rooms).values({
      id: `room-${index}`,
      title: index < 2 ? 'Same title' : `Room ${index}`,
      kind: '项目',
    }).run()
  }
}

function addIngest(
  db: Awaited<ReturnType<typeof harness>>['db'],
  input: {
    id: string
    sourceKind: 'file' | 'mail' | 'cloud-doc'
    filterStatus?: 'passed' | 'filtered' | 'bypassed'
    filterVerdict?: { informative: boolean; reason: string; category: string; confidence: number }
  },
) {
  db.insert(ingestEvents).values({
    id: `ing-${input.id}`,
    sourceKind: input.sourceKind,
    sourceId: input.id,
    sourceVersion: 1,
    dataType: input.sourceKind,
    detectedBy: 'explicit',
    title: input.id,
    contentHash: `hash-${input.id}`,
    parsedId: `parsed-${input.id}`,
    pipelines: { room: true, wiki: false, memory: false },
    filterStatus: input.filterStatus ?? 'passed',
    filterVerdict: input.filterVerdict ?? { informative: true, reason: 'useful', category: 'other', confidence: 0.99 },
  }).run()
}

function addMail(
  db: Awaited<ReturnType<typeof harness>>['db'],
  id: string,
  threadId: string,
  labels: string[] = [],
) {
  db.insert(connectorEmails).values({
    id,
    ownerId: 'owner',
    service: 'gmail',
    connectionName: 'main',
    sourceRecordId: id,
    syncedAt: new Date(),
    schemaVersion: 1,
    promptVersion: 1,
    contentHash: `hash-${id}`,
    messageId: `message-${id}`,
    threadId,
    senderAddress: 'person@example.com',
    recipients: [],
    subject: id,
    bodyText: id,
    labels,
  }).run()
}

describe('RoomRelationRegistry', () => {
  it('returns every live Room including isolated Rooms without heuristic edges', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 26)
    const graph = registry.graph()
    expect(graph.nodes).toHaveLength(26)
    expect(graph.edges).toEqual([])
    expect(graph.nodes.map((node) => node.id)).toContain('room-25')
    sqlite.close()
  })

  it('creates one shared-source edge, deduplicates mail threads, and excludes spam or uncertain evidence', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 2)
    addIngest(db, { id: 'doc-a', sourceKind: 'file' })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'doc-a', sourceVersion: 1, sourceTitle: 'Design brief', roomIds: ['room-0', 'room-1'], mentions: [] })
    expect(registry.graph().edges[0]).toMatchObject({ score: 1.1, sharedSourceCount: 1, type: 'shared_evidence' })

    registry.removeSource('file', 'doc-a')
    addMail(db, 'mail-a', 'thread-a')
    addMail(db, 'mail-b', 'thread-a')
    addIngest(db, { id: 'mail-a', sourceKind: 'mail' })
    addIngest(db, { id: 'mail-b', sourceKind: 'mail' })
    registry.replaceSource({ sourceKind: 'mail', sourceId: 'mail-a', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    registry.replaceSource({ sourceKind: 'mail', sourceId: 'mail-b', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    expect(registry.graph().edges).toEqual([])

    addMail(db, 'mail-spam', 'thread-spam', ['SPAM'])
    addIngest(db, { id: 'mail-spam', sourceKind: 'mail' })
    registry.replaceSource({ sourceKind: 'mail', sourceId: 'mail-spam', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    addIngest(db, {
      id: 'uncertain',
      sourceKind: 'cloud-doc',
      filterStatus: 'bypassed',
      filterVerdict: { informative: false, reason: 'filter unavailable', category: 'other', confidence: 0 },
    })
    registry.replaceSource({ sourceKind: 'cloud-doc', sourceId: 'uncertain', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    expect(registry.graph().edges).toEqual([])
    sqlite.close()
  })

  it('uses independent normalized entity evidence and direct Room-entity mentions', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 2)
    db.insert(entities).values({ id: 'entity-third-party', name: 'Vendor', kind: '人物' }).run()
    db.update(rooms).set({ entityId: 'entity-room-1' }).where(eq(rooms.id, 'room-1')).run()
    db.insert(entities).values({ id: 'entity-room-1', name: 'Room 1', kind: '项目', status: 'room', roomId: 'room-1' }).run()

    addIngest(db, { id: 'left', sourceKind: 'file' })
    addIngest(db, { id: 'right', sourceKind: 'file' })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'left', sourceVersion: 1, roomIds: ['room-0'], mentions: [{ entityId: 'entity-third-party', salience: 0.9 }] })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'right', sourceVersion: 1, roomIds: ['room-1'], mentions: [{ entityId: 'entity-third-party', salience: 0.9 }] })
    expect(registry.graph().edges).toEqual([])

    addIngest(db, { id: 'right-2', sourceKind: 'file' })
    addIngest(db, { id: 'left-2', sourceKind: 'file' })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'right-2', sourceVersion: 1, roomIds: ['room-1'], mentions: [{ entityId: 'entity-third-party', salience: 0.9 }] })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'left-2', sourceVersion: 1, roomIds: ['room-0'], mentions: [{ entityId: 'entity-room-1', salience: 0.8, evidence: 'Room 1 owns the rollout' }] })
    expect(registry.graph().edges[0]).toMatchObject({
      score: 2.25,
      sharedEntityCount: 1,
      directMentionCount: 1,
      type: 'shared_entity',
    })
    sqlite.close()
  })

  it('returns all direct neighbors only, handles stale versions, and rolls back on deletion', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 23)
    for (let index = 1; index < 23; index += 1) {
      const sourceId = `shared-${index}`
      addIngest(db, { id: sourceId, sourceKind: 'file' })
      registry.replaceSource({ sourceKind: 'file', sourceId, sourceVersion: 2, roomIds: ['room-0', `room-${index}`], mentions: [] })
      expect(registry.replaceSource({ sourceKind: 'file', sourceId, sourceVersion: 1, roomIds: ['room-1'], mentions: [] })).toBe(false)
    }
    const detail = registry.relationsOfRoom('room-0')!
    expect(detail.edges).toHaveLength(22)
    expect(detail.nodes).toHaveLength(23)
    expect(detail.edges.every((edge) => edge.sourceRoomId === 'room-0' || edge.targetRoomId === 'room-0')).toBe(true)

    registry.removeSource('file', 'shared-1')
    expect(registry.relationsOfRoom('room-0')!.edges).toHaveLength(21)
    sqlite.close()
  })

  it('applies manual direction, pin, hide, restore, and override removal precedence', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 2)
    const manual = registry.createManual({ fromRoomId: 'room-1', toRoomId: 'room-0', type: 'blocks', directed: true, note: 'Waiting on approval' })!
    expect(manual).toMatchObject({ sourceRoomId: 'room-1', targetRoomId: 'room-0', directed: true, origin: 'manual', pinned: true })
    expect(registry.updateManual(manual.id, { hidden: true })!.hidden).toBe(true)
    expect(registry.graph().edges).toEqual([])
    expect(registry.graph('hidden').edges).toHaveLength(1)
    expect(registry.updateManual(manual.id, { hidden: false })!.hidden).toBe(false)
    expect(registry.removeManual(manual.id)).toBeNull()

    addIngest(db, { id: 'auto-manual', sourceKind: 'file' })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'auto-manual', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    const automatic = registry.graph().edges[0]!
    registry.updateManual(automatic.id, { type: 'supports', pinned: true })
    expect(registry.removeManual(automatic.id)).toMatchObject({ origin: 'auto', type: 'shared_evidence', score: 1.1 })
    sqlite.close()
  })

  it('projects facts per source with replace semantics and reports fact backfill', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 2)
    addIngest(db, { id: 'doc-a', sourceKind: 'file' })
    registry.replaceSource({
      sourceKind: 'file', sourceId: 'doc-a', sourceVersion: 1, sourceTitle: 'Brief',
      roomIds: ['room-0', 'room-1'], mentions: [],
      facts: [
        { content: '林薇负责视觉', type: '属性', entityIds: ['e-1'] },
        { content: '   ', type: '属性', entityIds: [] },
      ],
    })
    const factRows = () => db.select().from(roomEntityFacts).all()
    expect(factRows()).toHaveLength(2)
    for (const row of factRows()) {
      expect(row).toMatchObject({
        factId: factFingerprint('林薇负责视觉'),
        content: '林薇负责视觉',
        type: '属性',
        entityIds: ['e-1'],
        sourceKind: 'file',
        sourceId: 'doc-a',
        sourceVersion: 1,
      })
    }

    // 同源新版本整体替换：旧事实随来源消失。
    registry.replaceSource({
      sourceKind: 'file', sourceId: 'doc-a', sourceVersion: 2, roomIds: ['room-0'], mentions: [],
      facts: [{ content: '新版本事实', type: '关系', entityIds: [] }],
    })
    expect(factRows().map((row) => [row.sourceId, row.content])).toEqual([['doc-a', '新版本事实']])

    // removeSource 同步清理事实投影。
    registry.removeSource('file', 'doc-a')
    expect(factRows()).toHaveLength(0)

    // 存量回填：有成员关系但无事实行的来源报待回填；完成后清零。
    addIngest(db, { id: 'doc-b', sourceKind: 'file' })
    addIngest(db, { id: 'doc-c', sourceKind: 'file' })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'doc-b', sourceVersion: 1, roomIds: ['room-0'], mentions: [], facts: [{ content: '已有事实', type: '属性', entityIds: [] }] })
    registry.replaceSource({ sourceKind: 'file', sourceId: 'doc-c', sourceVersion: 1, roomIds: ['room-0', 'room-1'], mentions: [] })
    expect(registry.pendingFactBackfill()).toEqual([
      { sourceKind: 'file', sourceId: 'doc-c', sourceVersion: 1, roomIds: ['room-0', 'room-1'] },
    ])
    registry.markFactBackfillCompleted()
    expect(registry.pendingFactBackfill()).toEqual([])
    sqlite.close()
  })

  it('skips trashed documents in startup backfill scans and revives them on restore', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 1)
    const now = new Date()
    db.insert(documentsTable).values([
      { id: 'doc-live', title: 'Live doc', contentJson: { type: 'doc' }, version: 1 },
      { id: 'doc-trash', title: 'Trashed doc', contentJson: { type: 'doc' }, version: 1, deletedAt: now },
    ]).run()
    // 两个文档都建了可信成员关系但都没有事实行：回填扫描只报未删的那个。
    registry.replaceSource({ sourceKind: 'everroom-doc', sourceId: 'doc-live', sourceVersion: 1, roomIds: ['room-0'], mentions: [] })
    registry.replaceSource({ sourceKind: 'everroom-doc', sourceId: 'doc-trash', sourceVersion: 1, roomIds: ['room-0'], mentions: [] })
    expect(registry.pendingFactBackfill()).toEqual([
      { sourceKind: 'everroom-doc', sourceId: 'doc-live', sourceVersion: 1, roomIds: ['room-0'] },
    ])

    // 文档索引补建扫描（entityIndexed=false）同样跳过回收站文档。
    db.update(roomSourceMemberships).set({ entityIndexed: false }).run()
    expect(registry.pendingDocumentIndexes()).toEqual([
      { sourceId: 'doc-live', sourceVersion: 1, roomIds: ['room-0'] },
    ])

    // 恢复（清空 deletedAt）后重新进入待回填集合。
    db.update(documentsTable).set({ deletedAt: null }).where(eq(documentsTable.id, 'doc-trash')).run()
    expect(registry.pendingFactBackfill()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'doc-live' }),
      expect.objectContaining({ sourceId: 'doc-trash' }),
    ]))
    sqlite.close()
  })

  it('reports building index state from relation-index jobs', async () => {
    const { db, registry, sqlite } = await harness()
    addRooms(db, 1)
    db.insert(jobs).values({ id: 'job-index', type: ROOM_RELATION_INDEX_JOB_TYPE, status: 'pending', payload: {} }).run()
    expect(registry.graph().indexing).toEqual({ status: 'building', pendingSources: 1 })
    sqlite.close()
  })
})
