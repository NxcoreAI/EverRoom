import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentSessions,
  contextRooms,
  documentBlocks,
  documentBlockReferences,
  documentVersions,
  documentYjsUpdates,
  documents,
  jobs,
  roomDocumentLinks,
} from '../src/infrastructure/database/schema.js'
import { eq } from 'drizzle-orm'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { normalizeDocumentContent, targetsOverlap } from '../src/modules/documents/content-model.js'
import { DocumentMcpHost } from '../src/modules/documents/mcp-host.js'
import { DocumentOperationService } from '../src/modules/documents/operations/service.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { DocumentService } from '../src/modules/documents/service.js'

const temporaryDirectories: string[] = []
const disposables: Array<() => void | Promise<void>> = []

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-documents-test-'))
  temporaryDirectories.push(dataDir)
  const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  db.insert(agentSessions).values({
    id: 'session-1',
    roomId: 'room-1',
    pageLabel: 'Context Room',
    runtimeId: 'test',
  }).run()
  const service = new DocumentService(db, new DocumentEventBroker())
  disposables.push(() => {
    sqlite.close()
  })
  return { db, service }
}

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((dispose) => dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('document transactions', () => {
  it('rejects diffs that reference a missing history version', async () => {
    const { service } = await createHarness()
    const document = await service.import({
      id: 'doc-diff-validation',
      roomId: 'room-1',
      title: 'Diff 校验',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V1' }] }] },
    })

    expect(() => service.diff(document.id, 999, document.version)).toThrowError(
      expect.objectContaining({ code: 'VERSION_NOT_FOUND', statusCode: 404 }),
    )
    expect(() => service.diff(document.id, null, 999)).toThrowError(
      expect.objectContaining({ code: 'VERSION_NOT_FOUND', statusCode: 404 }),
    )
  })

  it('rejects reverse or identical diff version ranges', async () => {
    const { service } = await createHarness()
    const document = await service.import({
      id: 'doc-diff-range-validation',
      roomId: 'room-1',
      title: 'Diff 范围校验',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V1' }] }] },
    })
    const saved = await service.save(document.id, {
      baseVersion: document.version,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V2' }] }] },
    })

    expect(() => service.diff(document.id, saved.version, saved.version)).toThrowError(
      expect.objectContaining({ code: 'INVALID_VERSION_RANGE', statusCode: 400 }),
    )
    expect(() => service.diff(document.id, saved.version, document.version)).toThrowError(
      expect.objectContaining({ code: 'INVALID_VERSION_RANGE', statusCode: 400 }),
    )
    expect(service.diff(document.id, document.version, saved.version)).toBeTruthy()
  })

  it('requeues a failed history backfill with a clean attempt counter', async () => {
    const { db, service } = await createHarness()
    const document = await service.import({
      id: 'doc-history-retry-route',
      roomId: 'room-1',
      title: '历史回填',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V1' }] }] },
    })

    service.retryYjsHistoryBackfill(document.id)
    db.update(jobs).set({
      status: 'failed',
      payload: { documentId: document.id, attempts: 5 },
    }).where(eq(jobs.id, `document-history-backfill:${document.id}`)).run()
    service.retryYjsHistoryBackfill(document.id)

    expect(db.select().from(jobs).where(eq(jobs.id, `document-history-backfill:${document.id}`)).get())
      .toMatchObject({ status: 'pending', payload: { documentId: document.id, attempts: 0 } })
  })

  it('keeps Room mappings, content, and versions after the SQLite database is reopened', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-documents-persistence-test-'))
    temporaryDirectories.push(dataDir)
    const databasePath = join(dataDir, 'gateway.sqlite')
    const first = createDatabase(databasePath, resolve('drizzle'))
    const firstService = new DocumentService(first.db, new DocumentEventBroker())
    const initialContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一版' }] }] }
    const savedContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '重启后仍存在' }] }] }

    const imported = await firstService.import({
      id: 'doc-persisted',
      roomId: 'room-persisted',
      title: '持久化文档',
      contentJson: initialContent,
    })
    await firstService.save(imported.id, { baseVersion: imported.version, contentJson: savedContent })
    first.sqlite.close()

    const second = createDatabase(databasePath, resolve('drizzle'))
    const secondService = new DocumentService(second.db, new DocumentEventBroker())
    try {
      expect(secondService.list('room-persisted')).toEqual([
        expect.objectContaining({
          id: 'doc-persisted',
          roomId: 'room-persisted',
          title: '持久化文档',
          version: 2,
          status: 'active',
          contentJson: expect.objectContaining({
            type: 'doc',
            content: [expect.objectContaining({ type: 'paragraph', attrs: { id: expect.any(String) } })],
          }),
        }),
      ])
      expect(second.db.select().from(documentVersions).all()).toHaveLength(2)
    } finally {
      second.sqlite.close()
    }
  })

  it('keeps trashed documents recoverable after the SQLite database is reopened', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-documents-trash-persistence-test-'))
    temporaryDirectories.push(dataDir)
    const databasePath = join(dataDir, 'gateway.sqlite')
    const first = createDatabase(databasePath, resolve('drizzle'))
    const firstService = new DocumentService(first.db, new DocumentEventBroker())
    const contentJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '可恢复正文' }] }],
    }
    await firstService.import({
      id: 'doc-trash-persisted',
      roomId: 'room-trash-persisted',
      title: '回收站持久化文档',
      contentJson,
    })
    await firstService.delete('doc-trash-persisted')
    first.sqlite.close()

    const second = createDatabase(databasePath, resolve('drizzle'))
    const secondService = new DocumentService(second.db, new DocumentEventBroker())
    try {
      expect(secondService.list('room-trash-persisted')).toEqual([])
      expect(secondService.list('room-trash-persisted', true)).toEqual([
        expect.objectContaining({
          id: 'doc-trash-persisted',
          deletedAt: expect.any(String),
          contentJson: expect.objectContaining({
            type: 'doc',
            content: [expect.objectContaining({ type: 'paragraph', attrs: { id: expect.any(String) } })],
          }),
        }),
      ])
      await expect(secondService.restore('doc-trash-persisted')).resolves.toMatchObject({
        deletedAt: null,
        contentJson: expect.objectContaining({ type: 'doc' }),
      })
    } finally {
      second.sqlite.close()
    }
  })

  it('imports, version-saves, and rejects stale saves', async () => {
    const { db, service } = await createHarness()
    const imported = await service.import({
      id: 'doc-1',
      roomId: 'room-1',
      title: '项目文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '初稿' }] }] },
    })
    const updated = await service.save(imported.id, {
      baseVersion: 1,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二版' }] }] },
    })

    expect(updated.version).toBe(2)
    expect(service.list('room-1')).toHaveLength(1)
    expect(service.list('room-2')).toHaveLength(0)
    const renamed = await service.save(updated.id, {
      baseVersion: 2,
      title: '  新项目标题  ',
      contentJson: updated.contentJson,
    })
    expect(renamed).toMatchObject({ title: '新项目标题', version: 3 })
    expect(service.list('room-1')[0]).toMatchObject({ title: '新项目标题', version: 3 })
    expect(db.select().from(documentVersions).all()).toHaveLength(3)
    await expect(service.save(renamed.id, {
      baseVersion: 3,
      title: '   ',
      contentJson: renamed.contentJson,
    })).rejects.toMatchObject({ code: 'INVALID_TITLE' })
    await expect(service.save(updated.id, {
      baseVersion: 1,
      contentJson: updated.contentJson,
    })).resolves.toMatchObject({ title: '新项目标题', version: 3 })
    await expect(service.save(imported.id, {
      baseVersion: 1,
      contentJson: { type: 'doc', content: [] },
    })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
  })

  it('does not report a committed save as failed when an after-commit observer throws', async () => {
    const { db, service } = await createHarness()
    const observerService = new DocumentService(
      db,
      service.broker,
      undefined,
      undefined,
      () => ({
        mutate: () => undefined,
        afterCommit: () => { throw new Error('observer failed') },
      }),
    )
    const document = await observerService.import({
      id: 'doc-after-commit-observer',
      roomId: 'room-1',
      title: 'After commit observer',
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    })

    await expect(observerService.save(document.id, {
      baseVersion: document.version,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved' }] }] },
    })).resolves.toMatchObject({ version: 2 })
    expect(observerService.get(document.id)).toMatchObject({ version: 2 })
  })

  it('keeps documents.title authoritative and strips retired title nodes', async () => {
    const { db, service } = await createHarness()
    const imported = await service.import({
      id: 'doc-title-node',
      roomId: 'room-1',
      title: '旧标题',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] },
    })

    expect(imported.title).toBe('旧标题')
    expect(imported.contentJson.content?.some((node) => node.type === 'documentTitle')).toBe(false)
    const ignoredNodeTitle = await service.save(imported.id, {
      baseVersion: imported.version,
      contentJson: {
        ...imported.contentJson,
        content: [
          { type: 'documentTitle', content: [{ type: 'text', text: '节点中的新标题' }] },
          ...(imported.contentJson.content ?? []),
        ],
      },
    })
    expect(ignoredNodeTitle.title).toBe('旧标题')
    expect(ignoredNodeTitle.contentJson.content?.some((node) => node.type === 'documentTitle')).toBe(false)
    const updated = await service.save(imported.id, {
      baseVersion: ignoredNodeTitle.version,
      title: '显式新标题',
      contentJson: ignoredNodeTitle.contentJson,
    })

    expect(updated.title).toBe('显式新标题')
    expect(service.list('room-1')[0]?.title).toBe('显式新标题')
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, imported.id)).all()
      .map((row) => row.title)).toEqual(['旧标题', '显式新标题'])
  })

  it('migrates a persisted body whose shallowest headings start below H2', async () => {
    const { db, service } = await createHarness()
    const imported = await service.import({
      id: 'doc-duplicate-heading', roomId: 'room-1', title: 'Java 学习指南',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] },
    })
    const legacyContent = {
      type: 'doc' as const,
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '2. 基本语法' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: '2.1 类型注解' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
      ],
    }
    db.update(documents).set({ contentJson: legacyContent }).where(eq(documents.id, imported.id)).run()
    db.update(documentVersions).set({ contentJson: legacyContent })
      .where(eq(documentVersions.documentId, imported.id)).run()

    const reopened = new DocumentService(db, service.broker)
    expect(reopened.get(imported.id)?.contentJson.content).toEqual([
      expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 2 }) }),
      expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 3 }) }),
      expect.objectContaining({ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }),
    ])
    expect((db.select().from(documentVersions).where(eq(documentVersions.documentId, imported.id)).get()
      ?.contentJson as TiptapJsonContent).content).toEqual([
      expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 2 }) }),
      expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 3 }) }),
      expect.objectContaining({ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }),
    ])
  })

  it('isolates an unavailable history during startup repair', async () => {
    const { db, service } = await createHarness()
    const broken = await service.import({
      id: 'doc-broken-startup-history', roomId: 'room-1', title: '损坏历史',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V1' }] }] },
    })
    const second = await service.save(broken.id, {
      baseVersion: broken.version,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V2' }] }] },
    })
    const third = await service.save(broken.id, {
      baseVersion: second.version,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V3' }] }] },
    })
    const healthy = await service.import({
      id: 'doc-healthy-startup-history', roomId: 'room-1', title: '健康文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正常正文' }] }] },
    })
    const legacyContent = {
      type: 'doc' as const,
      content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '旧标题' }] }],
    }
    db.update(documents).set({ contentJson: legacyContent }).where(eq(documents.id, broken.id)).run()
    db.update(documentVersions).set({ contentJson: legacyContent })
      .where(eq(documentVersions.documentId, broken.id)).run()
    db.update(documentVersions).set({ contentJson: null })
      .where(eq(documentVersions.version, second.version)).run()
    db.update(documentYjsUpdates).set({ contentHash: 'corrupt' })
      .where(eq(documentYjsUpdates.version, second.version)).run()

    const repairErrors: Array<{ documentId: string; version: number }> = []
    const reopened = new DocumentService(
      db,
      service.broker,
      undefined,
      undefined,
      undefined,
      (_error, documentId, version) => repairErrors.push({ documentId, version }),
    )

    expect(repairErrors).toEqual([{ documentId: broken.id, version: third.version }])
    expect(reopened.get(healthy.id)?.contentJson).toMatchObject({
      content: [{ content: [{ text: '正常正文' }] }],
    })
    expect((db.select().from(documents).where(eq(documents.id, broken.id)).get()
      ?.contentJson as TiptapJsonContent).content?.[0]?.attrs?.level).toBe(3)
  })

  it('moves a document to trash, restores it, and only removes stored content permanently', async () => {
    const { db, service } = await createHarness()
    const frames: string[] = []
    const unsubscribe = service.broker.subscribe('room-1', {
      readyState: 1,
      send: (frame) => frames.push(frame),
    })
    const imported = await service.import({
      id: 'doc-delete',
      roomId: 'room-1',
      title: '待删除文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] },
    })

    await service.delete(imported.id)
    expect(service.list('room-1')).toEqual([])
    expect(service.list('room-1', true)).toEqual([
      expect.objectContaining({ id: imported.id, deletedAt: expect.any(String) }),
    ])
    expect(service.get(imported.id)).toMatchObject({ id: imported.id, deletedAt: expect.any(String) })
    expect(db.select().from(documents).all()).toHaveLength(1)
    expect(db.select().from(roomDocumentLinks).all()).toHaveLength(1)
    expect(db.select().from(documentVersions).all()).toHaveLength(1)
    await expect(service.save(imported.id, {
      baseVersion: 1,
      contentJson: imported.contentJson,
    })).rejects.toMatchObject({ code: 'DOCUMENT_TRASHED' })

    await service.restore(imported.id)
    expect(service.list('room-1')).toEqual([
      expect.objectContaining({ id: imported.id, deletedAt: null }),
    ])
    expect(service.list('room-1', true)).toEqual([])

    service.retryYjsHistoryBackfill(imported.id)
    await service.delete(imported.id)
    await service.deletePermanently(imported.id)
    unsubscribe()

    expect(service.get(imported.id)).toBeNull()
    expect(db.select().from(documents).all()).toEqual([])
    expect(db.select().from(roomDocumentLinks).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    expect(db.select().from(jobs).all().filter((job) => job.type === 'document.delete')).toEqual([
      expect.objectContaining({ status: 'pending', payload: expect.objectContaining({ documentId: imported.id }) }),
    ])
    expect(db.select().from(jobs).all().some((job) => job.id === `document-history-backfill:${imported.id}`)).toBe(false)
    const events = frames.map((frame) => JSON.parse(frame))
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: 'document.changed' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: 'document.changed' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        roomId: 'room-1',
        documentId: imported.id,
        type: 'document.deleted',
        payload: { documentId: imported.id },
      }),
    }))
    await expect(service.deletePermanently(imported.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })


  it('empties a Room recycle bin and cascades document history', async () => {
    const { db, service } = await createHarness()
    for (const id of ['doc-trash-a', 'doc-trash-b']) {
      const imported = await service.import({
        id,
        roomId: 'room-1',
        title: id,
        contentJson: { type: 'doc', content: [] },
      })
      await service.delete(imported.id)
    }

    await service.emptyTrash('room-1')

    expect(service.list('room-1', true)).toEqual([])
    expect(db.select().from(documents).all()).toEqual([])
    expect(db.select().from(roomDocumentLinks).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    expect(db.select().from(jobs).all().filter((job) => job.type === 'document.delete')).toHaveLength(2)
  })

  it('lists available Rooms and refuses to create a draft before the user selects one', async () => {
    const { db, service } = await createHarness()
    const roomRegistry = new ContextRoomService(db)
    roomRegistry.saveSnapshot({
      rooms: [
        { id: 'room-1', title: '产品规划', kind: '项目', data: { id: 'room-1', title: '产品规划' } },
        { id: 'room-2', title: '后端进阶', kind: '主题', data: { id: 'room-2', title: '后端进阶' } },
      ],
      deletedRooms: [],
    })
    const operations = new DocumentOperationService(db, service.broker)
    const host = new DocumentMcpHost(service, roomRegistry, undefined, operations)
    disposables.push(() => host.close())
    const globalContext = {
      agentSessionId: 'session-1',
      runId: 'run-global',
      roomId: null,
      availableRooms: [{ id: 'forged-room', title: '前端伪造 Room' }],
    }

    const listed = await host.callTool('context_room_list', {}, globalContext)
    expect(listed.structuredContent).toEqual({
      rooms: [
        { id: 'room-1', title: '产品规划', kind: '项目' },
        { id: 'room-2', title: '后端进阶', kind: '主题' },
      ],
      selectionRequired: true,
      selectedRoomId: null,
    })
    const candidates = await host.callTool('context_room_list', {
      candidateRoomIds: ['room-2'],
    }, globalContext)
    expect(candidates.structuredContent).toEqual({
      rooms: [{ id: 'room-2', title: '后端进阶', kind: '主题' }],
      selectionRequired: true,
      selectedRoomId: null,
    })
    const created = await host.callTool('context_room_create', {
      title: 'Campus Life',
      description: 'Campus activities and study notes',
    }, globalContext)
    const createdRoom = created.structuredContent.room as { id: string; title: string; kind: string }
    expect(created.structuredContent).toMatchObject({
      created: true,
      room: { title: 'Campus Life', kind: '主题' },
      navigation: {
        pageId: 'rooms',
        title: 'Campus Life',
        action: 'created',
        objectType: 'room',
      },
    })
    expect(createdRoom.id).toMatch(/^room-/)
    expect(created.structuredContent.room).not.toHaveProperty('data')
    expect((await host.callTool('context_room_create', {
      title: 'campus life',
      description: 'Campus activities and study notes',
    }, globalContext)).structuredContent).toMatchObject({
      created: false,
      room: { id: createdRoom.id, title: 'Campus Life' },
      navigation: { action: 'opened', roomId: createdRoom.id },
    })
    await expect(host.callTool('context_room_write_begin', {
      mode: 'create', title: '服务端学习路径', format: 'markdown',
    }, globalContext)).rejects.toThrow('ROOM_SELECTION_REQUIRED')
    expect(service.list('room-1')).toEqual([])
    expect(service.list('room-2')).toEqual([])

    const started = await host.callTool('context_room_write_begin', {
      mode: 'create', title: '服务端学习路径', format: 'markdown',
    }, { ...globalContext, roomId: 'room-2' })
    expect(started.structuredContent).toMatchObject({ roomId: 'room-2', state: 'running' })
    const operationId = String(started.structuredContent.operationId)
    const documentId = String(started.structuredContent.docId)
    expect(service.list('room-2')).toEqual([
      expect.objectContaining({
        id: documentId,
        title: '服务端学习路径',
        status: 'draft',
        version: 0,
        activeTransactionId: operationId,
      }),
    ])
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).all()).toEqual([])
    expect(operations.list({ roomId: 'room-2', statuses: ['running'] })).toHaveLength(1)
  })

  it('assigns stable IDs recursively and resolves only same-Room block references', async () => {
    const { db, service } = await createHarness()
    db.insert(contextRooms).values([
      { id: 'room-1', title: 'Room 1', data: {}, position: 0 },
      { id: 'room-2', title: 'Room 2', data: {}, position: 1 },
    ]).run()
    const target = await service.import({
      id: 'doc-block-target',
      roomId: 'room-1',
      title: '块目标',
      contentJson: {
        type: 'doc',
        content: [{
          type: 'taskList',
          content: [{
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一项' }] }],
          }],
        }],
      },
    })
    const blocks = service.listBlocks(target.id)
    expect(blocks.map((block) => block.type)).toEqual(['taskList', 'taskItem', 'paragraph'])
    expect(new Set(blocks.map((block) => block.blockId))).toHaveLength(3)
    expect(db.select().from(documentBlocks).all()).toHaveLength(3)

    const item = blocks.find((block) => block.type === 'taskItem')!
    expect(service.resolveBlockReferences({
      sourceRoomId: 'room-1',
      references: [{ roomId: 'room-1', documentId: target.id, blockId: item.blockId }],
    })).toEqual([expect.objectContaining({ status: 'available', textPreview: '第一项' })])
    expect(() => service.resolveBlockReferences({
      sourceRoomId: 'room-1',
      references: [{ roomId: 'room-2', documentId: target.id, blockId: item.blockId }],
    })).toThrow(expect.objectContaining({ code: 'CROSS_ROOM_REFERENCE' }))

    await expect(service.import({
      id: 'doc-cross-room-reference',
      roomId: 'room-2',
      title: '非法引用',
      contentJson: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'documentBlockReference',
            attrs: { targetRoomId: 'room-1', targetDocumentId: target.id, targetBlockId: item.blockId },
          }],
        }],
      },
    })).rejects.toMatchObject({ code: 'CROSS_ROOM_REFERENCE' })
  })

  it('treats block identity as document-local and rebuilds reference backlinks', async () => {
    const { db, service } = await createHarness()
    db.insert(contextRooms).values({ id: 'room-1', title: 'Room 1', data: {}, position: 0 }).run()
    const target = await service.import({
      id: 'doc-target-local-id', roomId: 'room-1', title: '目标文档',
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: 'shared-block-id' }, content: [{ type: 'text', text: '目标内容' }],
      }] },
    })
    const targetBlockId = service.listBlocks(target.id)[0]!.blockId
    const source = await service.import({
      id: 'doc-source-local-id', roomId: 'room-1', title: '来源文档',
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: 'shared-block-id' }, content: [{
          type: 'text', text: '引用', marks: [{ type: 'link', attrs: {
            href: `everroom://room/room-1/${target.id}/${targetBlockId}`,
          } }],
        }],
      }] },
    })

    const sourceBlockId = service.listBlocks(source.id)[0]!.blockId
    expect(targetBlockId).not.toBe('shared-block-id')
    expect(sourceBlockId).not.toBe('shared-block-id')
    expect(sourceBlockId).not.toBe(targetBlockId)
    expect(db.select().from(documentBlockReferences).all()).toEqual([
      expect.objectContaining({
        sourceDocumentId: source.id,
        sourceBlockId,
        targetDocumentId: target.id,
        targetBlockId,
      }),
    ])
    expect(service.listBlockBacklinks(target.id, targetBlockId)).toEqual([
      expect.objectContaining({
        sourceDocumentId: source.id,
        sourceDocumentTitle: '来源文档',
        sourceTextPreview: '引用',
      }),
    ])
  })

  it('repairs a stale derived projection from canonical content before resolving a reference', async () => {
    const { db, service } = await createHarness()
    db.insert(contextRooms).values({ id: 'room-1', title: 'Room 1', data: {}, position: 0 }).run()
    const target = await service.import({
      id: 'doc-stale-projection', roomId: 'room-1', title: '投影修复',
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: 'authoritative-block' }, content: [{ type: 'text', text: '权威正文' }],
      }] },
    })
    const authoritativeBlockId = service.listBlocks(target.id)[0]!.blockId
    db.update(documentBlocks).set({ indexedVersion: 0 }).where(eq(documentBlocks.documentId, target.id)).run()

    expect(service.resolveBlockReferences({
      sourceRoomId: 'room-1',
      references: [{ roomId: 'room-1', documentId: target.id, blockId: authoritativeBlockId }],
    })).toEqual([expect.objectContaining({ status: 'available', version: 1 })])
    expect(db.select().from(documentBlocks).where(eq(documentBlocks.documentId, target.id)).get()?.indexedVersion)
      .toBe(1)
  })

  it('restores historical content as a new authoritative version', async () => {
    const { service } = await createHarness()
    const imported = await service.import({
      id: 'doc-version-restore', roomId: 'room-1', title: '版本恢复',
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: 'kept-history-id' }, content: [{ type: 'text', text: '第一版' }],
      }] },
    })
    const importedBlockId = service.listBlocks(imported.id)[0]!.blockId
    const saved = await service.save(imported.id, {
      baseVersion: imported.version,
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: importedBlockId }, content: [{ type: 'text', text: '第二版' }],
      }] },
    })
    const restored = await service.restoreVersion(imported.id, 1, saved.version)

    expect(restored.version).toBe(3)
    expect(restored.contentJson).toMatchObject({
      content: [{ attrs: { id: importedBlockId }, content: [{ text: '第一版' }] }],
    })
    expect(service.listVersions(imported.id).map((item) => item.version)).toEqual([3, 2, 1])
    expect(service.listBlocks(imported.id)[0]).toMatchObject({
      blockId: importedBlockId,
      indexedVersion: 3,
    })
  })

  it('restores a compacted intermediate version from Yjs history', async () => {
    const { db, service } = await createHarness()
    const imported = await service.import({
      id: 'doc-compacted-version-restore', roomId: 'room-1', title: '压缩版本恢复',
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', content: [{ type: 'text', text: '第一版' }],
      }] },
    })
    const blockId = service.listBlocks(imported.id)[0]!.blockId
    const second = await service.save(imported.id, {
      baseVersion: imported.version,
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: blockId }, content: [{ type: 'text', text: '第二版' }],
      }] },
    })
    const third = await service.save(imported.id, {
      baseVersion: second.version,
      contentJson: { type: 'doc', content: [{
        type: 'paragraph', attrs: { id: blockId }, content: [{ type: 'text', text: '第三版' }],
      }] },
    })

    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, imported.id)).all()
      .find((version) => version.version === second.version)?.contentJson)
      .toBeNull()

    const restored = await service.restoreVersion(imported.id, second.version, third.version)
    expect(restored).toMatchObject({
      version: 4,
      contentJson: { content: [{ content: [{ text: '第二版' }] }] },
    })
  })

  it('does not let inserted or duplicated blocks steal existing stable IDs', () => {
    const incoming = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'inserted' }] },
        { type: 'paragraph', attrs: { id: 'block-a' }, content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', attrs: { id: 'block-a' }, content: [{ type: 'text', text: 'copy' }] },
        { type: 'paragraph', attrs: { id: 'block-b' }, content: [{ type: 'text', text: 'B' }] },
      ],
    }

    const normalized = normalizeDocumentContent(incoming, 'doc-stable', 'room-1')
    const ids = normalized.content.content!.map((node) => node.attrs?.id)

    expect(ids[1]).toBe('block-a')
    expect(ids[3]).toBe('block-b')
    expect(ids[0]).not.toBe('block-a')
    expect(ids[0]).not.toBe('block-b')
    expect(ids[2]).not.toBe('block-a')
    expect(new Set(ids)).toHaveLength(ids.length)
  })

  it('detects range, descendant, and insertion-point hunk overlap from the base document', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'a' } },
        {
          type: 'bulletList',
          attrs: { id: 'list' },
          content: [{
            type: 'listItem',
            attrs: { id: 'item' },
            content: [{ type: 'paragraph', attrs: { id: 'nested' } }],
          }],
        },
        { type: 'paragraph', attrs: { id: 'c' } },
      ],
    }

    expect(targetsOverlap(content, { fromBlockId: 'a', toBlockId: 'c' }, { blockId: 'list' })).toBe(true)
    expect(targetsOverlap(content, { blockId: 'item' }, { blockId: 'nested' })).toBe(true)
    expect(targetsOverlap(content, { blockId: 'a', edge: 'after' }, { blockId: 'list', edge: 'before' })).toBe(true)
    expect(targetsOverlap(content, { at: 'end' }, { at: 'end' })).toBe(true)
    expect(targetsOverlap(content, { blockId: 'a' }, { blockId: 'c' })).toBe(false)
  })


  it('validates active document versions and UTF-16 cursor anchors before an Agent run', async () => {
    const { service } = await createHarness()
    const document = await service.import({
      id: 'doc-active-context', roomId: 'room-1', title: '活动文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A😀B' }] }] },
    })
    const blockId = service.listBlocks(document.id)[0]!.blockId
    expect(service.validateActiveDocumentContext({
      roomId: 'room-1', documentId: document.id, title: '不可信标题', version: 1,
      defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 3, affinity: 'after' },
    }, 'room-1')).toMatchObject({
      title: '活动文档', defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 3 },
    })
    expect(() => service.validateActiveDocumentContext({
      roomId: 'room-1', documentId: document.id, title: document.title, version: 0, defaultAnchor: 'end',
    }, 'room-1')).toThrow(expect.objectContaining({ code: 'DOCUMENT_CONFLICT' }))
    expect(() => service.validateActiveDocumentContext({
      roomId: 'room-1', documentId: document.id, title: document.title, version: 1,
      defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 5, affinity: 'after' },
    }, 'room-1')).toThrow(expect.objectContaining({ code: 'ANCHOR_INVALID' }))
  })

  it('prepares a continuation through Agent tools without exposing apply', async () => {
    const { db, service } = await createHarness()
    const document = await service.import({
      id: 'doc-agent-patch', roomId: 'room-1', title: 'Agent 续写目标',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '已有正文' }] }] },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-agent-patch', roomId: 'room-1' }
    const listed = await host.callTool('context_room_document_list', {}, context)
    expect(listed.structuredContent).toMatchObject({
      documents: [expect.objectContaining({ id: document.id, version: 1 })],
      selectionRequired: true,
    })
    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    expect(read.structuredContent).toMatchObject({
      documentId: document.id, version: 1, readReceipt: expect.any(String),
    })
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id,
      baseVersion: 1,
      readReceipt: String(read.structuredContent.readReceipt),
      kind: 'continue',
      summary: '补充结尾',
    }, context)
    const operationId = String(begun.structuredContent.operationId)
    expect(service.get(document.id)?.activeTransactionId).toBe(operationId)
    await expect(service.save(document.id, {
      baseVersion: document.version,
      contentJson: { type: 'doc', content: [] },
    })).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' })
    const firstBatch = await host.callTool('context_room_patch_hunk', {
      operationId, sequence: 1, operation: 'insert', target: { at: 'end' }, markdown: '续写正文',
    }, context)
    const secondBatch = await host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 2,
      operation: 'insert',
      target: { at: 'end' },
      markdown: '## 新增编程语言学习资料\n\n### Python\nPython 是一种广泛使用的高级编程语言。\n\n#### 学习资源\n- [Python 官方文档](https://docs.python.org/3/)\n- [Python 教程](https://www.w3schools.com/python/)',
    }, context)
    const duplicateBatch = await host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 2,
      operation: 'insert',
      target: { at: 'end' },
      markdown: '## 新增编程语言学习资料\n\n### Python\nPython 是一种广泛使用的高级编程语言。\n\n#### 学习资源\n- [Python 官方文档](https://docs.python.org/3/)\n- [Python 教程](https://www.w3schools.com/python/)',
    }, context)
    expect(firstBatch.structuredContent).toMatchObject({ acceptedSequence: 1, nextSequence: 2 })
    expect(secondBatch.structuredContent).toMatchObject({ acceptedSequence: 2, nextSequence: 3 })
    expect(duplicateBatch.structuredContent).toMatchObject({ acceptedSequence: 2, nextSequence: 3, duplicate: true })
    await expect(host.callTool('context_room_patch_hunk', {
      operationId, sequence: 2, operation: 'insert', target: { at: 'end' }, markdown: '不同的第二批内容',
    }, context)).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT', statusCode: 409 })
    const committed = await host.callTool('context_room_patch_commit', {
      operationId, finalSequence: 2,
    }, context)
    expect(committed.structuredContent).toMatchObject({
      state: 'awaiting_review',
      applied: false,
      documentChanged: false,
      documentVersion: 1,
      nextAction: 'user_review_required',
      patch: { id: operationId, status: 'pending', documentId: document.id },
      navigation: { action: 'opened' },
    })
    expect(service.get(document.id)?.activeTransactionId).toBeNull()
    await host.finishAgentRun(context.agentSessionId, 'completed', context.runId)
    const prepared = operations.get(operationId)
    expect(prepared).toMatchObject({
      status: 'awaiting_review',
      capabilityId: 'document.continue',
      input: { nextSequence: 3 },
    })
    expect(prepared?.items.map((item) => item.sequence)).toEqual(
      prepared?.items.map((_, index) => index + 1),
    )
    expect(prepared?.items.length).toBeGreaterThan(2)
    expect(prepared?.items[1]?.target).toEqual({ blockId: prepared?.items[0]?.id, edge: 'after' })
    expect(prepared?.items.some((item) => item.markdown.includes('## 新增编程语言学习资料'))).toBe(true)
    expect(prepared?.items.some((item) => item.markdown.includes('[Python 官方文档](https://docs.python.org/3/)'))).toBe(true)
    expect(service.get(document.id)).toMatchObject({ version: 1 })
    expect(host.listTools().some((tool) => tool.name.includes('apply'))).toBe(false)
  })

  it('rejects a continuation that substantially repeats the existing document', async () => {
    const { db, service } = await createHarness()
    const paragraphs = [
      'Java 学习应先建立语言基础与运行时心智模型，再进入工程实践和性能分析。'.repeat(2),
      '理解类型系统、异常处理、集合框架和并发模型，是形成稳定编码能力的关键。'.repeat(2),
      '进入项目阶段后应结合构建工具、自动化测试、日志与可观测性完成闭环。'.repeat(2),
      '最后通过真实服务的设计、部署和复盘，把零散知识沉淀为可迁移的方法。'.repeat(2),
    ]
    const document = await service.import({
      id: 'doc-repeated-continuation', roomId: 'room-1', title: 'Java 学习文档',
      contentJson: { type: 'doc', content: paragraphs.map((text) => ({
        type: 'paragraph', content: [{ type: 'text', text }],
      })) },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-repeated-continuation', roomId: 'room-1' }
    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id,
      baseVersion: document.version,
      readReceipt: String(read.structuredContent.readReceipt),
      kind: 'continue',
      summary: '重写 Java 学习文档的开头部分，使其更加详细',
    }, context)
    const operationId = String(begun.structuredContent.operationId)

    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'insert',
      target: { at: 'end' },
      markdown: [`改写后的开头，增加更清晰的学习目标和阶段说明。`, ...paragraphs].join('\n\n'),
    }, context)).rejects.toMatchObject({
      code: 'CONTINUATION_REPEATS_DOCUMENT',
      statusCode: 409,
    })
    expect(operations.get(operationId)).toMatchObject({ status: 'running', items: [] })
    expect(service.get(document.id)).toMatchObject({ version: 1, activeTransactionId: operationId })
    await host.finishAgentRun(context.agentSessionId, 'completed', context.runId)
    expect(service.get(document.id)).toMatchObject({ version: 1, activeTransactionId: null })
  })

  it('normalizes an Agent replace target that incorrectly includes a block edge', async () => {
    const { db, service } = await createHarness()
    const document = await service.import({
      id: 'doc-agent-edit-target', roomId: 'room-1', title: 'Agent 修改目标',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始段落' }] }] },
    })
    const blockId = service.listBlocks(document.id)[0]!.blockId
    const operations = new DocumentOperationService(db, service.broker)
    const diagnostics: Array<Record<string, unknown>> = []
    const host = new DocumentMcpHost(
      service,
      undefined,
      undefined,
      operations,
      (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    )
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-agent-edit-target', roomId: 'room-1' }
    await expect(host.callTool('context_room_patch_begin', {
      documentId: document.id, baseVersion: 1,
      kind: 'edit', summary: '缺少读取凭证',
    }, context)).rejects.toMatchObject({
      code: 'DOCUMENT_READ_REQUIRED',
      details: { nextAction: 'context_room_document_read', retryable: true },
    })
    expect(diagnostics.find((item) =>
      item.event === 'document.tool.failed' && item.toolName === 'context_room_patch_begin')).toMatchObject({
      toolName: 'context_room_patch_begin',
      input: { documentId: document.id, baseVersion: 1, kind: 'edit' },
      error: { code: 'DOCUMENT_READ_REQUIRED', nextAction: 'context_room_document_read', retryable: true },
    })
    const previousRead = await host.callTool('context_room_document_read', { documentId: document.id }, {
      ...context,
      runId: 'previous-run',
    })
    await expect(host.callTool('context_room_patch_begin', {
      documentId: document.id,
      baseVersion: 1,
      readReceipt: String(previousRead.structuredContent.readReceipt),
      kind: 'edit', summary: '替换原始段落',
    }, context)).rejects.toMatchObject({
      code: 'DOCUMENT_READ_REQUIRED',
      details: { nextAction: 'context_room_document_read' },
    })
    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id, baseVersion: 1,
      kind: 'edit', summary: '替换原始段落',
    }, context)
    expect(read.structuredContent.readReceipt).toEqual(expect.any(String))
    expect(begun.structuredContent).toMatchObject({ readReceiptResolved: true })
    const operationId = String(begun.structuredContent.operationId)
    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId: 'previous-operation-id' },
      markdown: '不会被接受的替换内容',
    }, context)).rejects.toMatchObject({
      code: 'PATCH_TARGET_NOT_IN_READ_SNAPSHOT',
      details: { nextAction: 'context_room_document_read' },
    })
    const failedDiagnostic = diagnostics.find((item) =>
      item.event === 'document.tool.failed' && item.toolName === 'context_room_patch_hunk')
    expect(failedDiagnostic).toMatchObject({
      toolName: 'context_room_patch_hunk',
      input: { operationId, sequence: 1, markdownBytes: expect.any(Number) },
      error: { code: 'PATCH_TARGET_NOT_IN_READ_SNAPSHOT', nextAction: 'context_room_document_read' },
    })
    expect(JSON.stringify(failedDiagnostic)).not.toContain('不会被接受的替换内容')
    const appended = await host.callTool('context_room_patch_hunk', {
      operationId: '725555bb-8699-47fd-adb4-1f72a91562bc',
      sequence: 1,
      operation: 'replace',
      target: { blockId, edge: 'after' },
      markdown: '替换后的段落',
    }, context)
    expect(appended.structuredContent).toMatchObject({
      acceptedSequence: 1,
      nextSequence: 2,
      operationId,
      operationIdCorrected: true,
      target: { blockId },
      targetCorrected: true,
    })
    expect(operations.get(operationId)?.items[0]).toMatchObject({
      operation: 'replace',
      target: { blockId },
    })
    const duplicate = await host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId, edge: 'after' },
      markdown: '替换后的段落',
    }, context)
    expect(duplicate.structuredContent).toMatchObject({ acceptedSequence: 1, duplicate: true })
    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId },
      markdown: '不同的替换内容',
    }, context)).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT', statusCode: 409 })
    const committed = await host.callTool('context_room_patch_commit', {
      finalSequence: 1,
    }, context)
    expect(committed.structuredContent).toMatchObject({
      operationId,
      operationIdCorrected: true,
      state: 'awaiting_review',
      applied: false,
      documentChanged: false,
    })
  })

  it('reduces an unambiguous full-document edit to the changed target fragment', async () => {
    const { db, service } = await createHarness()
    const paragraphs = [
      '第一部分介绍语言基础、类型系统与程序执行模型，并给出循序渐进的学习目标。'.repeat(2),
      '第二部分讲解工程结构、依赖管理、自动化测试与持续集成实践。'.repeat(2),
      '第三部分覆盖并发编程、性能分析、故障诊断和可观测性建设。'.repeat(2),
      '第四部分通过完整项目串联设计、实现、部署、复盘和后续演进。'.repeat(2),
    ]
    const document = await service.import({
      id: 'doc-repeated-edit', roomId: 'room-1', title: '编程学习文档',
      contentJson: { type: 'doc', content: paragraphs.map((text) => ({
        type: 'paragraph', content: [{ type: 'text', text }],
      })) },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-repeated-edit', roomId: 'room-1' }
    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id,
      baseVersion: document.version,
      readReceipt: String(read.structuredContent.readReceipt),
      kind: 'edit',
      summary: '只重写正文开头',
    }, context)
    const operationId = String(begun.structuredContent.operationId)
    const firstBlockId = service.listBlocks(document.id)[0]!.blockId

    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId: firstBlockId },
      markdown: ['重写后的详细开头。', ...paragraphs.slice(1)].join('\n\n'),
    }, context)).resolves.toMatchObject({
      structuredContent: {
        operationId,
        acceptedSequence: 1,
        nextSequence: 2,
        fragmentReduced: true,
      },
    })
    expect(operations.get(operationId)).toMatchObject({
      status: 'running',
      items: [expect.objectContaining({ markdown: '重写后的详细开头。' })],
    })
    await host.finishAgentRun(context.agentSessionId, 'completed', context.runId)
    expect(service.get(document.id)).toMatchObject({ version: 1, activeTransactionId: null })
  })

  it('rejects a repeated full-document edit when the changed range does not match the target', async () => {
    const { db, service } = await createHarness()
    const paragraphs = [
      '第一部分介绍语言基础、类型系统与程序执行模型，并给出循序渐进的学习目标。'.repeat(2),
      '第二部分讲解工程结构、依赖管理、自动化测试与持续集成实践。'.repeat(2),
      '第三部分覆盖并发编程、性能分析、故障诊断和可观测性建设。'.repeat(2),
      '第四部分通过完整项目串联设计、实现、部署、复盘和后续演进。'.repeat(2),
    ]
    const document = await service.import({
      id: 'doc-ambiguous-repeated-edit', roomId: 'room-1', title: '编程学习文档',
      contentJson: { type: 'doc', content: paragraphs.map((text) => ({
        type: 'paragraph', content: [{ type: 'text', text }],
      })) },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const diagnostics: Array<Record<string, unknown>> = []
    const host = new DocumentMcpHost(
      service,
      undefined,
      undefined,
      operations,
      (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    )
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-ambiguous-repeated-edit', roomId: 'room-1' }
    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id,
      baseVersion: document.version,
      readReceipt: String(read.structuredContent.readReceipt),
      kind: 'edit',
      summary: '只重写正文开头',
    }, context)
    const operationId = String(begun.structuredContent.operationId)
    const secondBlockId = service.listBlocks(document.id)[1]!.blockId

    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId: secondBlockId },
      markdown: ['重写后的详细开头。', ...paragraphs.slice(1)].join('\n\n'),
    }, context)).rejects.toMatchObject({
      code: 'EDIT_REPEATS_DOCUMENT',
      details: {
        operationId,
        nextAction: 'context_room_patch_hunk',
        expectedSequence: 1,
        doNotRepeatPreviousArguments: true,
      },
    })
    expect(operations.get(operationId)).toMatchObject({ status: 'running', items: [] })
    await expect(host.callTool('context_room_patch_hunk', {
      operationId,
      sequence: 1,
      operation: 'replace',
      target: { blockId: secondBlockId },
      markdown: '重写后的第二部分，聚焦工程结构、依赖管理和自动化测试。',
    }, context)).resolves.toMatchObject({
      structuredContent: { operationId, acceptedSequence: 1, nextSequence: 2 },
    })
    expect(diagnostics.filter((item) => item.toolName === 'context_room_patch_hunk')).toEqual([
      expect.objectContaining({
        level: 'warn', event: 'document.tool.failed', attempt: 1,
        error: expect.objectContaining({ code: 'EDIT_REPEATS_DOCUMENT' }),
      }),
      expect.objectContaining({
        level: 'info', event: 'document.tool.completed', attempt: 2,
        recovered: true, recoveredFromErrorCode: 'EDIT_REPEATS_DOCUMENT',
        output: expect.objectContaining({ acceptedSequence: 1 }),
      }),
    ])
    await host.finishAgentRun(context.agentSessionId, 'completed', context.runId)
  })

  it('infers omitted edit parameters and rejects an unchanged fragment wrapped in adjacent context', async () => {
    const { db, service } = await createHarness()
    const original = 'Java is a high-level, class-based, object-oriented programming language designed to have minimal implementation dependencies. It allows developers to write once, run anywhere.'
    const document = await service.import({
      id: 'doc-edit-no-change', roomId: 'room-1', title: 'Java Guide',
      contentJson: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Java Introduction' }] },
        { type: 'paragraph', content: [{ type: 'text', text: original }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Why Learn Java?' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Java is widely used for backend services, Android applications, development tools, and enterprise systems.' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Getting Started' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Install a JDK, choose an editor, learn the language syntax, and practice with small programs before building larger projects.' }] },
      ] },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const diagnostics: Array<Record<string, unknown>> = []
    const host = new DocumentMcpHost(
      service, undefined, undefined, operations,
      (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    )
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-edit-no-change', roomId: 'room-1' }
    await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id, baseVersion: document.version, kind: 'edit',
      summary: '把当前文档的开头介绍写短一点',
    }, context)
    const operationId = String(begun.structuredContent.operationId)
    const paragraphId = service.listBlocks(document.id)
      .find((block) => block.type === 'paragraph' && block.textPreview.startsWith('Java is a high-level'))!.blockId

    await expect(host.callTool('context_room_patch_hunk', {
      operationId, sequence: 1, target: { blockId: paragraphId, edge: 'after' },
      markdown: `## Java Introduction\n\n${original}`,
    }, context)).rejects.toMatchObject({
      code: 'EDIT_NO_CHANGE',
      details: { expectedSequence: 1, retryable: true, doNotRepeatPreviousArguments: true },
    })
    expect(operations.get(operationId)).toMatchObject({ status: 'running', items: [] })

    const accepted = await host.callTool('context_room_patch_hunk', {
      operationId, sequence: 1, target: { blockId: paragraphId, edge: 'after' },
      markdown: 'Java is a portable, object-oriented language used across many platforms.',
    }, context)
    expect(accepted.structuredContent).toMatchObject({
      operationId,
      acceptedSequence: 1,
      operationInferred: true,
      targetCorrected: true,
    })
    expect(diagnostics.find((item) => item.event === 'document.tool.completed'
      && item.toolName === 'context_room_patch_hunk')).toMatchObject({
      level: 'info', attempt: 2, recovered: true, recoveredFromErrorCode: 'EDIT_NO_CHANGE',
    })

    const committed = await host.callTool('context_room_patch_commit', {
      operationId, finalSequence: 2,
    }, context)
    expect(committed.structuredContent).toMatchObject({
      state: 'awaiting_review',
      finalSequence: 1,
      finalSequenceCorrected: true,
      applied: false,
      documentChanged: false,
    })
    expect(host.resolveCompletedMessage({
      sessionId: context.agentSessionId,
      runId: context.runId,
      content: '文档已成功修改。',
    })).toMatchObject({
      operationId,
      operationStatus: 'awaiting_review',
      itemCount: 1,
      content: '已为《Java Guide》准备好修改建议，正文尚未更改。请在文档中审阅并接受后应用。',
    })
  })

  it('returns a compact top-level block map for document editing', async () => {
    const { db, service } = await createHarness()
    const document = await service.import({
      id: 'doc-compact-agent-read', roomId: 'room-1', title: 'Compact Read',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Opening paragraph' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'First nested item' }] },
          ] },
          { type: 'listItem', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Second nested item' }] },
          ] },
        ] },
      ] },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-compact-read', roomId: 'room-1' }

    const read = await host.callTool('context_room_document_read', { documentId: document.id }, context)
    expect(read.structuredContent).toMatchObject({
      blockScope: 'top_level',
      blockCount: 2,
      indexedBlockCount: 6,
      blocks: [
        { type: 'paragraph', textPreview: 'Opening paragraph' },
        { type: 'bulletList', textPreview: 'First nested itemSecond nested item' },
      ],
    })
    expect((read.structuredContent.blocks as Array<Record<string, unknown>>)
      .every((block) => !('parentBlockId' in block) && !('depth' in block))).toBe(true)
  })

  it('cancels a patch after identical invalid retries and reports that the document is unchanged', async () => {
    const { db, service } = await createHarness()
    const original = 'TypeScript adds static types to JavaScript.'
    const document = await service.import({
      id: 'doc-identical-retry', roomId: 'room-1', title: 'TypeScript Guide',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: original }] },
      ] },
    })
    const operations = new DocumentOperationService(db, service.broker)
    const diagnostics: Array<Record<string, unknown>> = []
    const host = new DocumentMcpHost(
      service, undefined, undefined, operations,
      (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    )
    disposables.push(() => host.close())
    const context = { agentSessionId: 'session-1', runId: 'run-identical-retry', roomId: 'room-1' }
    await host.callTool('context_room_document_read', { documentId: document.id }, context)
    const begun = await host.callTool('context_room_patch_begin', {
      documentId: document.id, baseVersion: document.version, kind: 'edit',
      summary: 'Rewrite the opening paragraph',
    }, context)
    const operationId = String(begun.structuredContent.operationId)
    const paragraphId = service.listBlocks(document.id).find((block) => block.depth === 0)!.blockId
    const repeated = {
      operationId, sequence: 1, target: { blockId: paragraphId }, markdown: original,
    }

    await expect(host.callTool('context_room_patch_hunk', repeated, context)).rejects.toMatchObject({
      code: 'EDIT_NO_CHANGE',
    })
    await expect(host.callTool('context_room_patch_hunk', repeated, context)).rejects.toMatchObject({
      code: 'DOCUMENT_TOOL_RETRY_EXHAUSTED',
      details: {
        originalCode: 'EDIT_NO_CHANGE', state: 'cancelled', retryable: false,
        nextAction: 'respond_document_unchanged', repeatedAttempts: 2, documentChanged: false,
      },
    })
    expect(operations.get(operationId)).toMatchObject({ status: 'cancelled', items: [] })
    expect(host.resolveCompletedMessage({
      sessionId: context.agentSessionId,
      runId: context.runId,
      content: '文档已成功修改。',
    })).toMatchObject({
      operationId,
      operationStatus: 'cancelled',
      itemCount: 0,
      content: '未能为《TypeScript Guide》生成有效的修改建议，文档未发生变化。请给出更具体的修改要求后重试。',
    })
    expect(diagnostics.filter((item) => item.toolName === 'context_room_patch_hunk').at(-1))
      .toMatchObject({
        attempt: 2,
        error: expect.objectContaining({
          code: 'DOCUMENT_TOOL_RETRY_EXHAUSTED', retryable: false, state: 'cancelled',
        }),
      })
  })

  it('publishes all approved document and patch MCP tools', async () => {
    const { service } = await createHarness()
    const host = new DocumentMcpHost(service)
    disposables.push(() => host.close())
    await host.exchange('mcp-session', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    const messages = await host.exchange('mcp-session', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    const result = messages[0]?.result as { tools?: Array<{ name: string; description: string }> }
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      'context_room_list',
      'context_room_create',
      'context_room_document_list',
      'context_room_document_read',
      'context_room_patch_begin',
      'context_room_patch_hunk',
      'context_room_patch_commit',
      'context_room_patch_abort',
      'context_room_write_begin',
      'context_room_write_append',
      'context_room_write_commit',
      'context_room_write_abort',
    ])
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('正文内容与标题必须来自 document_draft 的返回值')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('用户已经明确要求在工作区创建、保存或写入文档')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('只要求分析、总结、整理、写方案、起草、润色，都不代表要创建文档')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('句子的创建对象是 Room、Context Room 或房间')
    expect(result.tools?.find((tool) => tool.name === 'context_room_list')?.description)
      .toContain('无法可靠确定唯一目标时调用')
    expect(result.tools?.find((tool) => tool.name === 'context_room_list')?.description)
      .toContain('最可能相关的 2 至 5 个 Room')
    expect(result.tools?.find((tool) => tool.name === 'context_room_create')?.description)
      .toContain('用户明确要求创建')
    expect(result.tools?.find((tool) => tool.name === 'context_room_create')?.description)
      .toContain('创建一个管理项目文档的 Context Room')
    // 写作规则已迁往 doc-writer skill；append 描述只保留机械契约与引用转交纪律（M3/V2）。
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_append')?.description)
      .toContain('document_draft 返回的 invocationId 与 chunkIndex')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_append')?.description)
      .toContain('参数中不携带正文')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_append')?.description)
      .toContain('title 由界面单独渲染为页面顶部 H1')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_append')?.description)
      .toContain('主章节从 ## 开始')
    expect(result.tools?.find((tool) => tool.name === 'context_room_patch_commit')?.description)
      .toContain('state/applied/documentChanged')
    expect(host.instructions()).toContain('最终回复以最后一次工具结果为准')
    expect(host.instructions()).toContain('awaiting_review')
    expect(host.instructions()).toContain('用途从句中的“文档/文件/项目”只是 Room 管理的内容')
    expect(host.instructions()).toContain('在 Context Room 里创建一份项目文档')

    await host.exchange('mcp-session', {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reconnect', version: '2' } },
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    const reconnected = await host.exchange('mcp-session', {
      jsonrpc: '2.0', id: 4, method: 'tools/list', params: {},
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    expect((reconnected[0]?.result as { tools?: unknown[] }).tools).toHaveLength(12)
  })
})
