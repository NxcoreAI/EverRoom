import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_DOCUMENT_CHANNEL, type TiptapJsonContent } from '@nxcore/agent-contract'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentSessions,
  documentBlocks,
  documentBlockReferences,
  documentVersions,
  documentYjsUpdates,
  documents,
  jobs,
} from '../src/infrastructure/database/schema.js'
import { eq } from 'drizzle-orm'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { normalizeDocumentContent, targetsOverlap } from '../src/modules/documents/content-model.js'
import { DocumentMcpHost } from '../src/modules/documents/mcp-host.js'
import { DocumentOperationService } from '../src/modules/documents/operations/service.js'
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

describe('document import origin', () => {
  const contentJson: TiptapJsonContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'V1' }] }] }

  it('未传 origin 默认按外部导入落库；传 native 归 EverOffice 创建（产物库只列 native）', async () => {
    const { service } = await createHarness()
    const external = await service.import({ id: 'doc-origin-default', roomId: 'room-1', title: '外部导入', contentJson })
    const created = await service.import({ id: 'doc-origin-native', roomId: 'room-1', title: '新建产物', contentJson, origin: 'native' })

    expect(external.origin).toBe('import')
    expect(created.origin).toBe('native')
    expect(service.list(false, 'native').map((document) => document.id)).toEqual(['doc-origin-native'])
  })
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
      expect(secondService.list()).toEqual([
        expect.objectContaining({
          id: 'doc-persisted',
          roomId: null,
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
      expect(secondService.list()).toEqual([])
      expect(secondService.list(true)).toEqual([
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
    // Phase 2i：文档库只剩工作区级列表，roomId 过滤维度已删除。
    expect(service.list()).toHaveLength(1)
    const renamed = await service.save(updated.id, {
      baseVersion: 2,
      title: '  新项目标题  ',
      contentJson: updated.contentJson,
    })
    expect(renamed).toMatchObject({ title: '新项目标题', version: 3 })
    expect(service.list()[0]).toMatchObject({ title: '新项目标题', version: 3 })
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
    expect(service.list()[0]?.title).toBe('显式新标题')
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
    const unsubscribe = service.broker.subscribe(null, {
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
    expect(service.list()).toEqual([])
    expect(service.list(true)).toEqual([
      expect.objectContaining({ id: imported.id, deletedAt: expect.any(String) }),
    ])
    expect(service.get(imported.id)).toMatchObject({ id: imported.id, deletedAt: expect.any(String) })
    expect(db.select().from(documents).all()).toHaveLength(1)
    expect(db.select().from(documentVersions).all()).toHaveLength(1)
    await expect(service.save(imported.id, {
      baseVersion: 1,
      contentJson: imported.contentJson,
    })).rejects.toMatchObject({ code: 'DOCUMENT_TRASHED' })

    await service.restore(imported.id)
    expect(service.list()).toEqual([
      expect.objectContaining({ id: imported.id, deletedAt: null }),
    ])
    expect(service.list(true)).toEqual([])

    service.retryYjsHistoryBackfill(imported.id)
    await service.delete(imported.id)
    await service.deletePermanently(imported.id)
    unsubscribe()

    expect(service.get(imported.id)).toBeNull()
    expect(db.select().from(documents).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    // Phase 2：删除不再入队 document.delete（理解引擎已退役），只清历史回填作业。
    expect(db.select().from(jobs).all().filter((job) => job.type === 'document.delete')).toEqual([])
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
        roomId: null,
        documentId: imported.id,
        type: 'document.deleted',
        payload: { documentId: imported.id },
      }),
    }))
    await expect(service.deletePermanently(imported.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })


  it('empties the workspace recycle bin and cascades document history', async () => {
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

    await service.emptyTrash()

    expect(service.list(true)).toEqual([])
    expect(db.select().from(documents).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    expect(db.select().from(jobs).all().filter((job) => job.type === 'document.delete')).toHaveLength(0)
  })


  it('assigns stable IDs recursively and resolves block references without Room gates', async () => {
    const { db, service } = await createHarness()
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
    // Phase 2i：引用元数据里的 roomId 不再参与校验，跨 Room 标签也照常可用。
    expect(service.resolveBlockReferences({
      sourceRoomId: 'room-1',
      references: [{ roomId: 'room-2', documentId: target.id, blockId: item.blockId }],
    })).toEqual([expect.objectContaining({ status: 'available', textPreview: '第一项' })])

    // Phase 2i：正文里存量引用的 targetRoomId 只作元数据，不再阻断导入。
    const referencing = await service.import({
      id: 'doc-cross-room-reference',
      roomId: 'room-2',
      title: '存量引用',
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
    })
    expect(referencing.id).toBe('doc-cross-room-reference')
    expect(service.listBlockBacklinks(target.id, item.blockId)).toEqual([
      expect.objectContaining({ sourceDocumentId: 'doc-cross-room-reference' }),
    ])
  })

  it('treats block identity as document-local and rebuilds reference backlinks', async () => {
    const { db, service } = await createHarness()
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
            href: `everroom://room/${WORKSPACE_DOCUMENT_CHANNEL}/${target.id}/${targetBlockId}`,
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
      documentId: document.id, title: '不可信标题', version: 1,
      defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 3, affinity: 'after' },
    })).toMatchObject({
      title: '活动文档', defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 3 },
    })
    expect(() => service.validateActiveDocumentContext({
      documentId: document.id, title: document.title, version: 0, defaultAnchor: 'end',
    })).toThrow(expect.objectContaining({ code: 'DOCUMENT_CONFLICT' }))
    expect(() => service.validateActiveDocumentContext({
      documentId: document.id, title: document.title, version: 1,
      defaultAnchor: 'end', cursorAnchorCandidate: { blockId, offset: 5, affinity: 'after' },
    })).toThrow(expect.objectContaining({ code: 'ANCHOR_INVALID' }))
  })









})

describe('document version change summary', () => {
  it('important change (title + blocks) generates summary at commit time and persists', async () => {
    const harness = await createHarness()
    const roomId = `room-s-${Math.random().toString(36).slice(2, 8)}`
    const document = await harness.service.import({
      id: `doc-s-${Math.random().toString(36).slice(2, 10)}`,
      roomId,
      title: '初始标题',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一段正文内容' }] }] } as never,
    })
    // v1 重要（首版）→ 保存时自动生成
    const committed = await harness.service.maybeGenerateSummaryOnCommit(document.id, 1)
    expect(committed.generated).toBe(true)
    expect(committed.summary).toContain('初始版本')
    // 已有 AI 概览时懒加载端点直接返回缓存；无 runtime 时为本地摘要，
    // 走升级路径重算但结果一致
    const cached = await harness.service.versionChangeSummary(document.id, 1)
    expect(cached.summary).toBe(committed.summary)
    // 重要变更：改标题 + 加两个块
    await harness.service.save(document.id, {
      baseVersion: 1,
      title: '新标题',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段正文内容' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '新增小节' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '小节下的内容' }] },
      ] } as never,
    })
    const important = await harness.service.maybeGenerateSummaryOnCommit(document.id, 2)
    expect(important.generated).toBe(true)
    expect(important.summary).toContain('新标题')
    // listVersions 带上概览
    const versions = harness.service.listVersions(document.id, { limit: 10 })
    expect(versions[0]!.changeSummary).toBe(important.summary)
    expect(versions[1]!.changeSummary).toBe(committed.summary)
  })

  it('minor change skips save-time generation and backfills lazily', async () => {
    const harness = await createHarness()
    const roomId = `room-m-${Math.random().toString(36).slice(2, 8)}`
    const document = await harness.service.import({
      id: `doc-m-${Math.random().toString(36).slice(2, 10)}`,
      roomId,
      title: '标题',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '乙' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '丙' }] },
      ] } as never,
    })
    await harness.service.maybeGenerateSummaryOnCommit(document.id, 1)
    // 仅改一段 → 不重要：保存时不生成
    await harness.service.save(document.id, {
      baseVersion: 1,
      title: '标题',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '乙改' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '丙' }] },
      ] } as never,
    })
    const prefilled = await harness.service.maybeGenerateSummaryOnCommit(document.id, 2)
    expect(prefilled.generated).toBe(false)
    // 不重要：保存时不调 AI，但先把本地规则摘要落库占位（面板立即展示）
    const stored = harness.service.listVersions(document.id, { limit: 10 })[0]!
    expect(stored.changeSummary).toBe(prefilled.summary)
    expect(stored.changeSummary).toContain('新增/修改 1 段')
    expect(stored.changeSummarySource).toBe('local')
    // 用户打开面板 → 懒加载升级（无 AI runtime 时仍为本地摘要并回填）
    const lazy = await harness.service.versionChangeSummary(document.id, 2)
    expect(lazy.summary.length).toBeGreaterThan(0)
    expect(harness.service.listVersions(document.id, { limit: 10 })[0]!.changeSummary).toBe(lazy.summary)
  })
})
