import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentRuns,
  agentSessions,
  contextRooms,
  documents,
  roomDocumentLinks,
  roomDuplicateCandidates,
  roomMemoryAttributions,
  roomRelations,
  roomSourceMemberships,
  rooms,
} from '../src/infrastructure/database/schema.js'
import { DuplicateReviewRequiredError, RoomDuplicateService, type RoomDuplicateServiceOptions } from '../src/modules/context-rooms/duplicate-service.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { eq } from 'drizzle-orm'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness(judgeIdentity?: RoomDuplicateServiceOptions['judgeIdentity']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-room-duplicates-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const duplicates = new RoomDuplicateService(database.db, judgeIdentity ? { judgeIdentity } : {})
  const roomsService = new ContextRoomService(database.db)
  roomsService.setDuplicateService(duplicates)
  return { ...database, duplicates, roomsService }
}

async function seedMembership(
  db: ReturnType<typeof createDatabase>['db'],
  roomId: string,
  sourceId: string,
  role: 'entry' | 'primary' | 'mention' | 'manual' | 'rule',
) {
  const now = new Date()
  db.insert(roomSourceMemberships).values({
    id: `membership-${roomId}-${sourceId}`,
    roomId,
    sourceKind: 'cloud-doc',
    sourceId,
    sourceVersion: 1,
    sourceTitle: `资料-${sourceId}`,
    evidenceGroupKey: `cloud-doc:${sourceId}`,
    role,
    effectiveWeight: 1,
    qualityLevel: 'normal',
    trusted: true,
    entityIndexed: true,
    createdAt: now,
    updatedAt: now,
  }).run()
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


  it('bridges containment-only name pairs (Java vs JAVA Space) into the candidate pool', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    // 零证据空壳对：四条内容通道全零，名字 Dice 0.545——靠包含关系（java ⊂ javaspace）保底 0.75 进池。
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-java', title: 'Java', kind: '主题', data: { id: 'room-java', title: 'Java' } },
        { id: 'room-space', title: 'JAVA Space', kind: '主题', data: { id: 'room-space', title: 'JAVA Space' } },
      ],
      deletedRooms: [],
    })

    expect(await duplicates.rebuildCandidates()).toBe(1)
    const candidate = duplicates.listCandidates('open')[0]
    expect(candidate).toMatchObject({
      roomAId: 'room-java',
      roomBId: 'room-space',
      nameScore: 0.75,
      confidence: 'pending',
    })
    expect(candidate?.reasons.some((reason) => reason.includes('包含关系'))).toBe(true)
    sqlite.close()
  })

  it('does not boost two-character containment (ai vs trainer stays out)', async () => {
    const { duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-ai', title: 'ai', kind: '主题', data: { id: 'room-ai', title: 'ai' } },
        { id: 'room-trainer', title: 'trainer', kind: '主题', data: { id: 'room-trainer', title: 'trainer' } },
      ],
      deletedRooms: [],
    })
    expect(await duplicates.rebuildCandidates()).toBe(0)
    sqlite.close()
  })

  it('keeps LLM-rejected containment pairs as pending for user review (negative cache stays soft)', async () => {
    // JavaScript ⊃ java：包含命中。两个 service 共用同一库：
    // ① LLM 判 different → 降级 pending 入池（不再出局）；
    // ② 换一个判 same 的 LLM rebuild → 负缓存复用旧 different 判定时，仍保持 pending。
    const base = await harness()
    const reject = new RoomDuplicateService(base.db, {
      judgeIdentity: async () => ({ same: false, reason: 'JavaScript 与 Java 是不同技术' }),
    })
    base.roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: 'Java', kind: '主题', data: { id: 'room-a', title: 'Java' } },
        { id: 'room-b', title: 'JavaScript', kind: '主题', data: { id: 'room-b', title: 'JavaScript' } },
      ],
      deletedRooms: [],
    })
    expect(await reject.rebuildCandidates()).toBe(1)
    const rejected = reject.listCandidates('open')[0]
    expect(rejected).toMatchObject({ confidence: 'pending' })
    expect(rejected?.reasons.some((reason) => reason.includes('仍建议人工确认'))).toBe(true)
    const accept = new RoomDuplicateService(base.db, {
      judgeIdentity: async () => ({ same: true, reason: '同一主题' }),
    })
    expect(await accept.rebuildCandidates()).toBe(1)
    expect(accept.listCandidates('open')[0]).toMatchObject({ confidence: 'pending' })
    base.sqlite.close()
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

  it('hides candidates immediately when either room is deleted or merged, without waiting for a rebuild', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '产品发布', kind: '项目', data: { id: 'room-a', title: '产品发布' } },
        { id: 'room-b', title: '产品发布记录', kind: '项目', data: { id: 'room-b', title: '产品发布记录' } },
        { id: 'room-c', title: '产品发布存档', kind: '项目', data: { id: 'room-c', title: '产品发布存档' } },
      ],
      deletedRooms: [],
    })
    const now = new Date()
    for (const roomId of ['room-a', 'room-b', 'room-c']) {
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
    await duplicates.rebuildCandidates()
    expect(duplicates.listCandidates('open')).toHaveLength(3)

    // 软删除 room-b：涉及它的候选立即隐藏（读时过滤，不依赖下次 rebuild 清理）。
    db.update(contextRooms).set({ deletedAt: now }).where(eq(contextRooms.id, 'room-b')).run()
    expect(duplicates.listCandidates('open')).toHaveLength(1)

    // 已合并（lifecycle=merged）同样隐藏；恢复 active 后候选重新可见。
    db.update(contextRooms).set({ deletedAt: null, lifecycle: 'merged', mergedIntoRoomId: 'room-a' }).where(eq(contextRooms.id, 'room-b')).run()
    expect(duplicates.listCandidates('open')).toHaveLength(1)
    db.update(contextRooms).set({ lifecycle: 'active', mergedIntoRoomId: null }).where(eq(contextRooms.id, 'room-b')).run()
    expect(duplicates.listCandidates('open')).toHaveLength(3)
    sqlite.close()
  })

  it('reuses the cached identity verdict while evidence is unchanged and re-judges after it changes', async () => {
    const judge = vi.fn(async () => ({ same: true, reason: '同名且描述同一主题' }))
    const { db, duplicates, roomsService, sqlite } = await harness(judge)
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '校园生活', kind: '主题', data: { id: 'room-a', title: '校园生活' } },
        // 同名不同 kind：进入灰区，依赖同一性判定。
        { id: 'room-b', title: '校园生活', kind: '项目', data: { id: 'room-b', title: '校园生活' } },
      ],
      deletedRooms: [],
    })

    await duplicates.rebuildCandidates()
    expect(judge).toHaveBeenCalledTimes(1)
    const stored = () => db.select().from(roomDuplicateCandidates).get()
    expect(stored()).toMatchObject({ confidence: 'medium', llmVerdict: 'same' })

    // 证据未变：复用判定，不重判（LLM 非确定性重判会让置信度抖动）。
    await duplicates.rebuildCandidates()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(stored()).toMatchObject({ confidence: 'medium', llmVerdict: 'same' })

    // 新增证据改变修订号：重新判定。
    seedMembership(db, 'room-a', 'diary-1', 'primary')
    await duplicates.rebuildCandidates()
    expect(judge).toHaveBeenCalledTimes(2)
    expect(stored()).toMatchObject({ confidence: 'medium', llmVerdict: 'same' })
    sqlite.close()
  })

  it('downgrades mention-only shared evidence so a passing mention no longer creates a candidate', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '晨会纪要', kind: '主题', data: { id: 'room-a', title: '晨会纪要' } },
        { id: 'room-b', title: '产品规划', kind: '主题', data: { id: 'room-b', title: '产品规划' } },
      ],
      deletedRooms: [],
    })
    // room-b 以主力资料持有 S；room-a 只顺带提及 S。标题不相似、无实体/语义信号。
    seedMembership(db, 'room-b', 'shared-doc', 'primary')
    seedMembership(db, 'room-a', 'shared-doc', 'mention')

    expect(await duplicates.rebuildCandidates()).toBe(0)
    expect(duplicates.listCandidates('open')).toHaveLength(0)

    // 提升为双方主力资料后恢复强证据，候选重新出现。
    db.update(roomSourceMemberships).set({ role: 'primary' })
      .where(eq(roomSourceMemberships.id, 'membership-room-a-shared-doc')).run()
    expect(await duplicates.rebuildCandidates()).toBe(1)
    expect(duplicates.listCandidates('open')).toHaveLength(1)
    sqlite.close()
  })

  it('skips pairs the user curated a relation for, whether pinned or manually typed', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '产品发布', kind: '项目', data: { id: 'room-a', title: '产品发布' } },
        { id: 'room-b', title: '产品发布记录', kind: '项目', data: { id: 'room-b', title: '产品发布记录' } },
      ],
      deletedRooms: [],
    })
    seedMembership(db, 'room-a', 'launch-plan', 'primary')
    seedMembership(db, 'room-b', 'launch-plan', 'primary')
    expect(await duplicates.rebuildCandidates()).toBe(1)

    // 用户手动标注关系 = 「相关但不同」：整对退出候选池，open 候选被清理。
    db.insert(roomRelations).values({
      id: 'relation-1', roomAId: 'room-a', roomBId: 'room-b',
      manualType: 'related', manualFromRoomId: 'room-a', manualToRoomId: 'room-b',
    }).run()
    expect(await duplicates.rebuildCandidates()).toBe(0)
    expect(duplicates.listCandidates('open')).toHaveLength(0)

    // pinned 关系同样跳过。
    db.update(roomRelations).set({ manualType: null, pinned: true }).where(eq(roomRelations.id, 'relation-1')).run()
    expect(await duplicates.rebuildCandidates()).toBe(0)

    // 解除人工关系后候选恢复。
    db.update(roomRelations).set({ pinned: false }).where(eq(roomRelations.id, 'relation-1')).run()
    expect(await duplicates.rebuildCandidates()).toBe(1)
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
    // 新建式合并聚合两个来源的影响：localMemories 双方各 1 条。
    expect(preview.impact).toMatchObject({ documents: 1, localMemories: 2, attributedMemories: 1, agentRuns: 1 })
    const settled = await duplicates.startMerge({
      sourceAId: 'room-source',
      sourceBId: 'room-target',
      title: '合并后的校园项目',
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-key',
      wait: true,
    })
    expect(settled).toMatchObject({ status: 'completed', progress: 100, commitReached: true })

    const newRoomId = settled.targetRoomId
    expect(db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.documentId, 'document-source')).get()?.roomId).toBe(newRoomId)
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, 'memory-core-1')).get()?.roomId).toBe(newRoomId)
    expect(db.select().from(agentRuns).where(eq(agentRuns.id, 'run-1')).get()?.roomId).toBe(newRoomId)
    expect(db.select().from(contextRooms).where(eq(contextRooms.id, 'room-source')).get()).toMatchObject({
      lifecycle: 'merged',
      mergedIntoRoomId: newRoomId,
      data: { lifecycle: 'merged', mergedIntoRoomId: newRoomId },
    })
    expect(roomsService.getSnapshot().rooms.map((room) => room.id)).toEqual([newRoomId])
    expect(roomsService.getSnapshot().rooms[0]?.data.memoryItems).toEqual([
      { id: 'memory-source', content: '来源记忆' },
      { id: 'memory-target', content: '主记忆' },
    ])
    expect(roomsService.resolveRoomId('room-source')).toBe(newRoomId)
    sqlite.close()
  })


  it('migrates agent session room bindings and completes the merge when knowledge rebuild fails', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    void db
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-s', title: '来源房', kind: '主题', data: { id: 'room-s', title: '来源房' } },
        { id: 'room-t', title: '目标房', kind: '主题', data: { id: 'room-t', title: '目标房' } },
      ],
      deletedRooms: [],
    })
    const now = new Date()
    // 会话绑在 source Room 上：合并必须迁移，否则成为孤儿（agent 409 同族根因）。
    db.insert(agentSessions).values({
      id: 'session-src', roomId: 'room-s', pageLabel: 'Context Room', runtimeId: 'fake', status: 'idle', createdAt: now, updatedAt: now,
    }).run()
    // 用一个知识重建会抛错的服务实例执行合并（post-commit 失败路径）。
    const failing = new RoomDuplicateService(db, {
      mergeKnowledge: async () => { throw new Error('knowledge rebuild exploded') },
    })
    const preview = await failing.previewMerge('room-s', 'room-t')
    const settled = await failing.startMerge({
      sourceAId: 'room-s',
      sourceBId: 'room-t',
      title: '合并房',
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-session-key',
      wait: true,
    })
    // 数据已搬迁（commit 已达）：失败恢复补完定稿，而非卡在 merging。
    expect(settled).toMatchObject({ status: 'completed', commitReached: true })
    const newRoomId = settled.targetRoomId
    expect(db.select().from(agentSessions).where(eq(agentSessions.id, 'session-src')).get()?.roomId).toBe(newRoomId)
    expect(db.select().from(contextRooms).where(eq(contextRooms.id, 'room-s')).get()?.lifecycle).toBe('merged')
    sqlite.close()
  })


  it('stale renderer flushes no longer hard-delete rooms absent from the snapshot', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    void duplicates
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-keep', title: '幸存者', kind: '主题', data: { id: 'room-keep', title: '幸存者' } },
        { id: 'room-gone', title: '待软删', kind: '主题', data: { id: 'room-gone', title: '待软删' } },
      ],
      deletedRooms: [],
    })
    // 陈旧渲染端回刷：快照完全没提到 room-keep（旧代码会把它物理删除）。
    roomsService.saveSnapshot({
      rooms: [{ id: 'room-gone', title: '待软删', kind: '主题', data: { id: 'room-gone', title: '待软删' } }],
      deletedRooms: [],
    })
    expect(roomsService.getSnapshot().rooms.map((room) => room.id).sort())
      .toEqual(['room-gone', 'room-keep'])
    // 显式删除走 deletedRooms 软删通道，仍然有效且可从回收站语义恢复。
    roomsService.saveSnapshot({
      rooms: [{ id: 'room-keep', title: '幸存者', kind: '主题', data: { id: 'room-keep', title: '幸存者' } }],
      deletedRooms: [{ id: 'room-gone', title: '待软删', kind: '主题', data: { id: 'room-gone', title: '待软删' } }],
    })
    expect(roomsService.getSnapshot().rooms.map((room) => room.id)).toEqual(['room-keep'])
    expect(db.select({ deletedAt: contextRooms.deletedAt }).from(contextRooms)
      .where(eq(contextRooms.id, 'room-gone')).get()?.deletedAt).not.toBeNull()
    sqlite.close()
  })


  it('merges two rooms into a brand-new room and retires both sources', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-x', title: 'Java', kind: '主题', data: { id: 'room-x', title: 'Java', memoryItems: [{ id: 'mx', content: 'X 记忆' }], materials: [] } },
        { id: 'room-y', title: 'Java Space', kind: '主题', data: { id: 'room-y', title: 'Java Space', memoryItems: [{ id: 'my', content: 'Y 记忆' }], materials: [] } },
      ],
      deletedRooms: [],
    })
    const now = new Date()
    for (const [id, title] of [['room-x', 'Java'], ['room-y', 'Java Space']] as const) {
      db.insert(rooms).values({ id, title, kind: '主题', origin: 'user', createdAt: now, updatedAt: now }).run()
    }
    // roomDocumentLinks 有 documents 外键：先插文档行。
    for (const docId of ['doc-x', 'doc-y']) {
      db.insert(documents).values({
        id: docId, title: `文档 ${docId}`, contentJson: { type: 'doc', content: [] },
        version: 1, status: 'active', createdAt: now, updatedAt: now,
      }).run()
    }
    db.insert(roomDocumentLinks).values({ roomId: 'room-x', documentId: 'doc-x', linkedAt: now }).run()
    db.insert(roomDocumentLinks).values({ roomId: 'room-y', documentId: 'doc-y', linkedAt: now }).run()

    const preview = await duplicates.previewMerge('room-x', 'room-y')
    expect(preview.impact.documents).toBe(2)
    expect(preview.recommendedTargetRoomId).toBe('new')
    const settled = await duplicates.startMerge({
      sourceAId: 'room-x', sourceBId: 'room-y', title: 'Java 综合',
      previewHash: preview.previewHash, idempotencyKey: 'merge-new-key', wait: true,
    })
    expect(settled).toMatchObject({ status: 'completed', commitReached: true })
    // 两个旧 Room 都退役，新 Room 收编全部资源。
    const snapshot = roomsService.getSnapshot()
    expect(snapshot.rooms.map((room) => room.title)).toEqual(['Java 综合'])
    expect(db.select().from(contextRooms).where(eq(contextRooms.id, 'room-x')).get()?.lifecycle).toBe('merged')
    expect(db.select().from(contextRooms).where(eq(contextRooms.id, 'room-y')).get()?.lifecycle).toBe('merged')
    const newRoom = snapshot.rooms[0]!
    // brief 为 ContextRoomBrief 对象且 background 非空（渲染端 Boolean(brief) 过滤
    // + OverviewDashboard brief.background.trim() 渲染，二者都必须满足）。
    const brief = (newRoom.data as Record<string, unknown>).brief as Record<string, unknown>
    expect(typeof brief).toBe('object')
    expect(Boolean(String(brief.background ?? '').trim())).toBe(true)
    expect(db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.documentId, 'doc-x')).get()?.roomId).toBe(newRoom.id)
    expect(db.select().from(roomDocumentLinks).where(eq(roomDocumentLinks.documentId, 'doc-y')).get()?.roomId).toBe(newRoom.id)
    expect((newRoom.data.memoryItems as Array<{ id: string }>).map((item) => item.id).sort()).toEqual(['mx', 'my'])
    // 幂等：同 idempotencyKey 重放返回既有终态，不再新建。
    const replay = await duplicates.startMerge({
      sourceAId: 'room-x', sourceBId: 'room-y', title: 'Java 综合',
      previewHash: preview.previewHash, idempotencyKey: 'merge-new-key', wait: true,
    })
    expect(replay.id).toBe(settled.id)
    expect(roomsService.getSnapshot().rooms).toHaveLength(1)
    sqlite.close()
  })

  it('returns the settled operation when startMerge waits', async () => {
    const { duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-w1', title: '等待合并 A', kind: '主题', data: { id: 'room-w1', title: '等待合并 A' } },
        { id: 'room-w2', title: '等待合并 A', kind: '主题', data: { id: 'room-w2', title: '等待合并 A' } },
      ],
      deletedRooms: [],
    })
    const preview = await duplicates.previewMerge('room-w1', 'room-w2')
    const result = await duplicates.startMerge({
      sourceAId: 'room-w1',
      sourceBId: 'room-w2',
      title: '等待合并',
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-wait-key',
      wait: true,
    })
    // wait=true：请求内等待本地事务完成，直接返回终态，调用方无需轮询。
    expect(result).toMatchObject({ status: 'completed', progress: 100, commitReached: true })
    sqlite.close()
  })

  it('demotes a user-rejected pair to pending when evidence changes, and annotates it', async () => {
    const { db, duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '校园生活', kind: '主题', data: { id: 'room-a', title: '校园生活' } },
        { id: 'room-b', title: '校园生活', kind: '主题', data: { id: 'room-b', title: '校园生活' } },
      ],
      deletedRooms: [],
    })
    await duplicates.rebuildCandidates()
    const candidate = duplicates.listCandidates('open')[0]!
    expect(duplicates.updateCandidate(candidate.id, 'distinct')?.status).toBe('distinct')

    // 证据不变：判定保留（preserveDecision 语义不受 M2-C 影响）。
    await duplicates.rebuildCandidates()
    expect(duplicates.listCandidates()[0]?.status).toBe('distinct')

    // 证据变化：重开为 pending（不再高置信静默复活），reason 标注用户曾判定。
    seedMembership(db, 'room-a', 'new-evidence', 'primary')
    await duplicates.rebuildCandidates()
    const reopened = duplicates.listCandidates('open')[0]!
    expect(reopened.status).toBe('open')
    expect(reopened.confidence).toBe('pending')
    expect(reopened.reasons.some((reason) => reason.includes('用户曾'))).toBe(true)
    sqlite.close()
  })

  it('dampens duplicate score for names repeatedly judged distinct across pairs', async () => {
    const { duplicates, roomsService, sqlite } = await harness()
    const room = (id: string, title: string) => ({ id, title, kind: '主题', data: { id, title } })
    roomsService.saveSnapshot({
      rooms: [room('room-p', '重复主题'), room('room-q', '重复主题甲'), room('room-r', '重复主题乙')],
      deletedRooms: [],
    })
    await duplicates.rebuildCandidates()
    const all = duplicates.listCandidates()
    duplicates.updateCandidate(all.find((c) => c.roomAId === 'room-p' && c.roomBId === 'room-q')!.id, 'distinct')
    duplicates.updateCandidate(all.find((c) => c.roomAId === 'room-p' && c.roomBId === 'room-r')!.id, 'distinct')

    // 「重复主题」已跨 2 个配对被判非重复：新配对（room-p vs room-s）应带罚分注记。
    roomsService.saveSnapshot({
      rooms: [room('room-p', '重复主题'), room('room-q', '重复主题甲'), room('room-r', '重复主题乙'), room('room-s', '重复主题丙')],
      deletedRooms: [],
    })
    await duplicates.rebuildCandidates()
    const penalized = duplicates.listCandidates().find((c) =>
      (c.roomAId === 'room-p' && c.roomBId === 'room-s') || (c.roomAId === 'room-s' && c.roomBId === 'room-p'))
    expect(penalized).toBeTruthy()
    expect(penalized!.reasons).toContain('名称历史上多次被判非重复，综合分已下调')
    sqlite.close()
  })

  it('targeted assess reports newly actionable candidates once', async () => {
    const { duplicates, roomsService, sqlite } = await harness()
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-old', title: '定向检查', kind: '主题', data: { id: 'room-old', title: '定向检查' } },
      ],
      deletedRooms: [],
    })
    roomsService.saveSnapshot({
      rooms: [
        { id: 'room-old', title: '定向检查', kind: '主题', data: { id: 'room-old', title: '定向检查' } },
        { id: 'room-new', title: '定向检查', kind: '主题', data: { id: 'room-new', title: '定向检查' } },
      ],
      deletedRooms: [],
    })
    const first = await duplicates.requestTargetedAssess('room-new')
    expect(first).toEqual({ newCandidates: 1 })
    // 已 open 且可操作：再次定向检查不再计为“新浮现”。
    const second = await duplicates.requestTargetedAssess('room-new')
    expect(second).toEqual({ newCandidates: 0 })
    sqlite.close()
  })
})
