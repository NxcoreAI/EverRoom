import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'
import { rooms } from '../src/infrastructure/database/schema.js'
import { EntityRegistry } from '../src/modules/knowledge/entity-registry.js'
import { KnowledgeService } from '../src/modules/knowledge/service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-recommendation-dedup-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const registry = new EntityRegistry(database.db, { promoteScore: 2.4, promoteSources: 3 })
  const service = new KnowledgeService(database.db, {
    baseUrl: 'http://127.0.0.1:9',
    serviceId: 'everroom',
    teamId: 'everroom',
    dataDir,
    roomWikisEnabled: false,
    ingestDebounceMs: 600_000,
    routerEnabled: true,
    entityPromoteScore: 2.4,
    entityPromoteSources: 3,
    mergeAutoDice: 0.75,
    mergeJudgeDice: 0.6,
    llm: null,
    embeddingLlm: null,
    embeddingModel: '',
  }, { info: () => {}, warn: () => {}, error: () => {} })
  return { ...database, registry, service }
}

describe('Room recommendation duplicate review', () => {
  it('marks an exact existing Room match and prevents creating a second Room', async () => {
    const { db, registry, service, sqlite } = await harness()
    db.insert(rooms).values({ id: 'room-campus', title: '校园生活', kind: '主题' }).run()
    const roomEntity = registry.createEntity({ name: '校园生活', kind: '主题' })
    registry.promoteToRoom(roomEntity.id, 'room-campus')
    const recommendation = registry.createEntity({ name: '校园生活', kind: '主题' })

    expect(service.listCandidateEntities('weak').find((item) => item.id === recommendation.id)?.existingRoomMatch)
      .toMatchObject({ roomId: 'room-campus', entityId: roomEntity.id, confidence: 'high', score: 0.3 })
    expect(service.promoteEntity(recommendation.id)).toEqual({ ok: false, error: 'existing_room_match_high_confidence' })
    expect(service.promoteEntity(recommendation.id, { forceNew: true }))
      .toEqual({ ok: false, error: 'existing_room_match_high_confidence' })

    service.dispose()
    sqlite.close()
  })

  it('reuses the promoted Room entity without waiting for wiki ingestion', async () => {
    const { db, registry, service, sqlite } = await harness()
    db.insert(rooms).values({ id: 'room-campus', title: '校园生活', kind: '主题' }).run()
    const roomEntity = registry.createEntity({ name: '校园生活', kind: '主题' })
    registry.promoteToRoom(roomEntity.id, 'room-campus')
    const recommendation = registry.createEntity({ name: '校园生活', kind: '主题' })

    await expect(service.mergeEntity(recommendation.id, roomEntity.id)).resolves.toEqual({ ok: true })
    expect(registry.getEntity(recommendation.id)?.status).toBe('archived')
    expect(registry.getEntity(roomEntity.id)?.roomId).toBe('room-campus')

    service.dispose()
    sqlite.close()
  })

  it('does not allow the legacy entity endpoint to merge one Room into another', async () => {
    const { db, registry, service, sqlite } = await harness()
    db.insert(rooms).values([
      { id: 'room-a', title: '校园生活', kind: '主题' },
      { id: 'room-b', title: '校园活动', kind: '主题' },
    ]).run()
    const entityA = registry.createEntity({ name: '校园生活', kind: '主题' })
    const entityB = registry.createEntity({ name: '校园活动', kind: '主题' })
    registry.promoteToRoom(entityA.id, 'room-a')
    registry.promoteToRoom(entityB.id, 'room-b')

    await expect(service.mergeEntity(entityA.id, entityB.id)).resolves.toEqual({
      ok: false,
      error: 'room_merge_confirmation_required',
    })
    expect(registry.getEntity(entityA.id)?.roomId).toBe('room-a')
    expect(registry.getEntity(entityB.id)?.roomId).toBe('room-b')

    service.dispose()
    sqlite.close()
  })
})
