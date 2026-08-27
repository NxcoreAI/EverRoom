import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentRuns,
  agentSessions,
  contextRooms,
  documents,
  roomDocumentLinks,
  roomMemoryAttributions,
  roomSourceMemberships,
  rooms,
} from '../src/infrastructure/database/schema.js'
import { DuplicateReviewRequiredError, RoomDuplicateService } from '../src/modules/context-rooms/duplicate-service.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { eq } from 'drizzle-orm'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-room-duplicates-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const duplicates = new RoomDuplicateService(database.db)
  const roomsService = new ContextRoomService(database.db)
  roomsService.setDuplicateService(duplicates)
  return { ...database, duplicates, roomsService }
}

async function waitForMerge(duplicates: RoomDuplicateService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = duplicates.getOperation(operationId)
    if (operation?.status === 'completed' || operation?.status === 'failed') return operation
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error('merge did not settle')
}

describe('RoomDuplicateService', () => {
  it('blocks a similar creation and accepts only the scoped short-lived override token', async () => {
    const { duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [{ id: 'room-campus', title: 'Campus Life', kind: '主题', data: { id: 'room-campus', title: 'Campus Life' } }],
      deletedRooms: [],
    })

    const review = await duplicates.checkCreation({ title: 'Campus Life', description: '重复主题' })
    expect(review.candidates).toHaveLength(1)
    expect(review.candidates[0]).toMatchObject({ roomBId: 'room-campus', confidence: 'pending', nameScore: 1 })
    expect(review.overrideToken).toEqual(expect.any(String))

    await expect(roomsService.createRoom({ title: 'Campus Life', description: '重复主题' }))
      .rejects.toBeInstanceOf(DuplicateReviewRequiredError)
    const created = await roomsService.createRoom({
      title: 'Campus Life',
      description: '重复主题',
      duplicateOverrideToken: review.overrideToken!,
    })
    expect(created.created).toBe(true)
    expect(roomsService.getSnapshot().rooms).toHaveLength(2)
    sqlite.close()
  })

  it('scores trusted evidence overlap and persists a duplicate candidate', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '产品发布', kind: '项目', data: { id: 'room-a', title: '产品发布' } },
        { id: 'room-b', title: '新品上线', kind: '项目', data: { id: 'room-b', title: '新品上线' } },
      ],
      deletedRooms: [],
    })
    const now = new Date()
    for (const roomId of ['room-a', 'room-b']) {
      db.insert(roomSourceMemberships).values({
        id: `membership-${roomId}`,
        roomId,
        sourceKind: 'cloud-doc',
        sourceId: 'launch-plan',
        sourceVersion: 1,
        sourceTitle: '发布计划',
        evidenceGroupKey: 'cloud-doc:launch-plan',
        role: 'primary',
        effectiveWeight: 1,
        qualityLevel: 'normal',
        trusted: true,
        entityIndexed: true,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    expect(await duplicates.rebuildCandidates()).toBe(1)
    expect(duplicates.listCandidates('open')[0]).toMatchObject({
      roomAId: 'room-a',
      roomBId: 'room-b',
      contentOverlap: 1,
    })
    sqlite.close()
  })

  it('preserves a negative match across ordinary snapshot updates until evidence changes', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    const snapshot = {
      rooms: [
        { id: 'room-a', title: '校园生活', kind: '主题', data: { id: 'room-a', title: '校园生活' } },
        { id: 'room-b', title: '校园生活', kind: '主题', data: { id: 'room-b', title: '校园生活' } },
      ],
      deletedRooms: [],
    }
    roomsService.saveSnapshot(snapshot)
    await duplicates.rebuildCandidates()
    const candidate = duplicates.listCandidates('open')[0]!
    expect(duplicates.updateCandidate(candidate.id, 'distinct')?.status).toBe('distinct')

    roomsService.saveSnapshot(snapshot)
    await duplicates.rebuildCandidates()
    expect(duplicates.listCandidates()[0]?.status).toBe('distinct')

    db.insert(roomSourceMemberships).values({
      id: 'new-evidence',
      roomId: 'room-a',
      sourceKind: 'cloud-doc',
      sourceId: 'new-source',
      sourceVersion: 1,
      sourceTitle: '新证据',
      evidenceGroupKey: 'cloud-doc:new-source',
      role: 'primary',
      effectiveWeight: 1,
      qualityLevel: 'normal',
      trusted: true,
      entityIndexed: true,
    }).run()
    await duplicates.rebuildCandidates()
    expect(duplicates.listCandidates()[0]?.status).toBe('open')

    duplicates.dispose()
    sqlite.close()
  })

  it('moves explicitly attributed data and leaves an irreversible source tombstone', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        {
          id: 'room-source',
          title: '校园项目',
          kind: '项目',
          data: { id: 'room-source', title: '校园项目', memoryItems: [{ id: 'memory-source', content: '来源记忆' }], materials: [] },
        },
        {
          id: 'room-target',
          title: '校园生活项目',
          kind: '项目',
          data: { id: 'room-target', title: '校园生活项目', memoryItems: [{ id: 'memory-target', content: '主记忆' }], materials: [] },
        },
      ],
      deletedRooms: [],
    })
    const now = new Date()
    for (const [id, title] of [['room-source', '校园项目'], ['room-target', '校园生活项目']] as const) {
      db.insert(rooms).values({ id, title, kind: '项目', origin: 'user', createdAt: now, updatedAt: now }).run()
    }
    db.insert(documents).values({
      id: 'document-source',
      title: '来源文档',
      contentJson: { type: 'doc', content: [] },
      version: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(roomDocumentLinks).values({ roomId: 'room-source', documentId: 'document-source', linkedAt: now }).run()
    db.insert(roomMemoryAttributions).values({
      id: 'attribution-1', roomId: 'room-source', memoryId: 'memory-core-1', sourceKind: 'agent-run', confidence: 'explicit', createdAt: now, updatedAt: now,
    }).run()
    db.insert(agentSessions).values({
      id: 'session-1', roomId: null, pageLabel: 'Agent', runtimeId: 'fake', status: 'idle', createdAt: now, updatedAt: now,
    }).run()
    db.insert(agentRuns).values({
      id: 'run-1', sessionId: 'session-1', idempotencyKey: 'run-key', roomId: 'room-source', status: 'completed', prompt: '整理资料', lastEventSeq: 0, createdAt: now,
    }).run()

    const preview = await duplicates.previewMerge('room-source', 'room-target')
    expect(preview.impact).toMatchObject({ documents: 1, localMemories: 1, attributedMemories: 1, agentRuns: 1 })
    const queued = await duplicates.startMerge({
      sourceRoomId: 'room-source',
      targetRoomId: 'room-target',
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-key',
    })
    const completed = await waitForMerge(duplicates, queued.id)
    expect(completed).toMatchObject({ status: 'completed', progress: 100, commitReached: true })

    expect(db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.documentId, 'document-source')).get()?.roomId).toBe('room-target')
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, 'memory-core-1')).get()?.roomId).toBe('room-target')
    expect(db.select().from(agentRuns).where(eq(agentRuns.id, 'run-1')).get()?.roomId).toBe('room-target')
    expect(db.select().from(contextRooms).where(eq(contextRooms.id, 'room-source')).get()).toMatchObject({
      lifecycle: 'merged',
      mergedIntoRoomId: 'room-target',
      data: { lifecycle: 'merged', mergedIntoRoomId: 'room-target' },
    })
    expect(roomsService.getSnapshot().rooms.map((room) => room.id)).toEqual(['room-target'])
    expect(roomsService.getSnapshot().rooms[0]?.data.memoryItems).toEqual([
      { id: 'memory-target', content: '主记忆' },
      { id: 'memory-source', content: '来源记忆' },
    ])
    expect(roomsService.resolveRoomId('room-source')).toBe('room-target')
    sqlite.close()
  })
})
