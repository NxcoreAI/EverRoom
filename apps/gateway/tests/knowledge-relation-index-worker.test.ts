import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'
import { jobs, rooms } from '../src/infrastructure/database/schema.js'
import { ROOM_RELATION_INDEX_JOB_TYPE } from '../src/modules/knowledge/room-relations.js'
import { KnowledgeService } from '../src/modules/knowledge/service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

describe('knowledge relation index worker', () => {
  it('consumes a pending relation-index job and builds the automatic relation projection', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-relation-worker-'))
    temporaryDirectories.push(dataDir)
    const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    const service = new KnowledgeService(db, {
      baseUrl: 'http://127.0.0.1:9',
      serviceId: 'everroom',
      teamId: 'everroom',
      dataDir,
      roomWikisEnabled: true,
      ingestDebounceMs: 600_000,
      routerEnabled: true,
      entityPromoteScore: 2,
      entityPromoteSources: 2,
      mergeAutoDice: 0.75,
      mergeJudgeDice: 0.6,
      llm: null,
      embeddingLlm: null,
      embeddingModel: '',
    }, { info: () => {}, warn: () => {}, error: () => {} })

    db.insert(rooms).values([
      { id: 'room-a', title: 'Room A', kind: '项目' },
      { id: 'room-b', title: 'Room B', kind: '项目' },
    ]).run()
    db.insert(jobs).values({
      id: 'relation-index-job',
      type: ROOM_RELATION_INDEX_JOB_TYPE,
      status: 'pending',
      payload: {
        sourceKind: 'everroom-doc',
        sourceId: 'shared-document',
        sourceVersion: 1,
        roomIds: ['room-a', 'room-b'],
      },
    }).run()

    service.start()
    await vi.waitFor(() => {
      expect(sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get('relation-index-job'))
        .toEqual({ status: 'completed' })
    })
    expect(service.roomGraph().edges).toEqual([
      expect.objectContaining({
        sourceRoomId: 'room-a',
        targetRoomId: 'room-b',
        origin: 'auto',
        type: 'shared_evidence',
        score: 1.2,
      }),
    ])

    service.dispose()
    sqlite.close()
  })
})
