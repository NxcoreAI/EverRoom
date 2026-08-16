import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentSessions,
  documentOps,
  documentTransactions,
  documentVersions,
  documents,
  roomDocumentLinks,
} from '../src/infrastructure/database/schema.js'
import { eq } from 'drizzle-orm'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentMcpHost } from '../src/modules/documents/mcp-host.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import {
  DocumentService,
  type DocumentCommittedHandler,
} from '../src/modules/documents/service.js'

const temporaryDirectories: string[] = []
const disposables: Array<() => void | Promise<void>> = []

async function createHarness(onDocumentCommitted?: DocumentCommittedHandler) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-documents-test-'))
  temporaryDirectories.push(dataDir)
  const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  db.insert(agentSessions).values({
    id: 'session-1',
    roomId: 'room-1',
    pageLabel: 'Context Room',
    runtimeId: 'test',
  }).run()
  const service = new DocumentService(db, new DocumentEventBroker(), onDocumentCommitted)
  disposables.push(() => {
    service.dispose()
    sqlite.close()
  })
  return { db, service }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
}

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((dispose) => dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('document transactions', () => {
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
    firstService.dispose()
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
          contentJson: savedContent,
        }),
      ])
      expect(second.db.select().from(documentVersions).all()).toHaveLength(2)
    } finally {
      secondService.dispose()
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
    firstService.dispose()
    first.sqlite.close()

    const second = createDatabase(databasePath, resolve('drizzle'))
    const secondService = new DocumentService(second.db, new DocumentEventBroker())
    try {
      expect(secondService.list('room-trash-persisted')).toEqual([])
      expect(secondService.list('room-trash-persisted', true)).toEqual([
        expect.objectContaining({
          id: 'doc-trash-persisted',
          deletedAt: expect.any(String),
          contentJson,
        }),
      ])
      await expect(secondService.restore('doc-trash-persisted')).resolves.toMatchObject({
        deletedAt: null,
        contentJson,
      })
    } finally {
      secondService.dispose()
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
    await expect(service.save(updated.id, {
      baseVersion: 1,
      contentJson: updated.contentJson,
    })).resolves.toMatchObject({ version: 2 })
    expect(db.select().from(documentVersions).all()).toHaveLength(2)
    await expect(service.save(imported.id, {
      baseVersion: 1,
      contentJson: { type: 'doc', content: [] },
    })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
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

    await service.delete(imported.id)
    await service.deletePermanently(imported.id)
    unsubscribe()

    expect(service.get(imported.id)).toBeNull()
    expect(db.select().from(documents).all()).toEqual([])
    expect(db.select().from(roomDocumentLinks).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    const events = frames.map((frame) => JSON.parse(frame))
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: 'document.trashed' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: 'document.restored' }),
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

  it('deletes committed transaction history but refuses an Agent draft in progress', async () => {
    const { db, service } = await createHarness()
    const started = await service.begin({
      title: 'Agent 文档',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-delete',
    })
    await expect(service.delete(started.document.id)).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' })
    expect(service.get(started.document.id)).not.toBeNull()

    const contentJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '已提交' }] }] }
    const append = service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: '已提交',
    })
    await nextTurn()
    await service.acknowledge(started.transactionId, { sequence: 1, contentJson })
    await append
    const commit = service.commit({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      finalSequence: 1,
    })
    await nextTurn()
    await service.acknowledge(started.transactionId, { sequence: 1, contentJson })
    await commit

    await service.delete(started.document.id)
    expect(db.select().from(documentTransactions).all()).toHaveLength(1)
    expect(db.select().from(documentVersions).all()).toHaveLength(1)
    await service.deletePermanently(started.document.id)
    expect(db.select().from(documentTransactions).all()).toEqual([])
    expect(db.select().from(documentOps).all()).toEqual([])
    expect(db.select().from(documentVersions).all()).toEqual([])
    expect(db.select().from(roomDocumentLinks).all()).toEqual([])
  })

  it('persists acknowledged chunks, handles duplicates, and commits atomically', async () => {
    const { service } = await createHarness()
    const started = await service.begin({
      title: 'Agent 周报',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-1',
    })
    expect(service.list('room-1')[0]).toMatchObject({ status: 'draft', version: 0 })

    const content = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1, id: `${started.transactionId}:0` }, content: [{ type: 'text', text: '中文周报' }] }],
    }
    const append = service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: '# 中文周报\n',
    })
    await nextTurn()
    expect(service.replayPending('room-1')).toEqual([
      expect.objectContaining({
        documentId: started.document.id,
        transactionId: started.transactionId,
        type: 'document.appended',
        payload: { sequence: 1, text: '# 中文周报\n' },
      }),
    ])
    await service.acknowledge(started.transactionId, { sequence: 1, contentJson: content })
    await expect(append).resolves.toMatchObject({ duplicate: false, nextSequence: 2 })
    expect(service.list('room-1')[0]?.contentJson).toEqual(content)
    expect(service.replayPending('room-1')).toEqual([])

    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: '# 中文周报\n',
    })).resolves.toMatchObject({ duplicate: true })
    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: '# 不同内容\n',
    })).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' })

    const commit = service.commit({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      finalSequence: 1,
    })
    await nextTurn()
    expect(service.replayPending('room-1')).toEqual([
      expect.objectContaining({
        type: 'document.commit-requested',
        payload: { finalSequence: 1 },
      }),
    ])
    await service.acknowledge(started.transactionId, { sequence: 1, contentJson: content })
    await expect(commit).resolves.toMatchObject({ status: 'active', version: 1, contentJson: content })
  })

  it('captures the final Agent document only after commit', async () => {
    const captured: Parameters<DocumentCommittedHandler>[0][] = []
    const { service } = await createHarness((document) => captured.push(document))
    const started = await service.begin({
      title: '认证服务演进路线',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-memory',
    })
    const firstContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一段' }] }] }
    const finalContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一段第二段' }] }] }

    const firstAppend = service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: '第一段',
    })
    await nextTurn()
    await service.acknowledge(started.transactionId, { sequence: 1, contentJson: firstContent })
    await firstAppend
    const secondAppend = service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 2,
      text: '第二段',
    })
    await nextTurn()
    await service.acknowledge(started.transactionId, { sequence: 2, contentJson: finalContent })
    await secondAppend
    expect(captured).toEqual([])

    const commit = service.commit({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      finalSequence: 2,
    })
    await nextTurn()
    await service.acknowledge(started.transactionId, { sequence: 2, contentJson: finalContent })
    await commit

    expect(captured).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      roomId: 'room-1',
      runId: 'run-memory',
      documentId: started.document.id,
      title: '认证服务演进路线',
      markdown: '第一段第二段',
    })])
  })

  it('enforces sequence, session, and size limits and removes aborted drafts', async () => {
    const { service } = await createHarness()
    const started = await service.begin({
      title: '受限事务',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-2',
    })

    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 2,
      text: '跳号',
    })).rejects.toMatchObject({ code: 'SEQUENCE_GAP' })
    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'another-session',
      sequence: 1,
      text: '越权',
    })).rejects.toMatchObject({ code: 'TRANSACTION_FORBIDDEN' })
    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 1,
      text: 'x'.repeat(64 * 1024 + 1),
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' })

    await service.abort(started.transactionId, 'session-1', 'user-stopped')
    expect(service.list('room-1')).toHaveLength(0)
  })

  it('enforces the 2 MiB transaction limit and expires stale transactions', async () => {
    const { db, service } = await createHarness()
    const started = await service.begin({
      title: '大文档',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-large',
    })
    const contentJson = { type: 'doc', content: [] }
    for (let sequence = 1; sequence <= 32; sequence += 1) {
      const append = service.append({
        transactionId: started.transactionId,
        sessionId: 'session-1',
        sequence,
        text: 'x'.repeat(64 * 1024),
      })
      await nextTurn()
      await service.acknowledge(started.transactionId, { sequence, contentJson })
      await append
    }
    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 33,
      text: 'x',
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' })

    db.update(documentTransactions).set({ expiresAt: new Date(0) })
      .where(eq(documentTransactions.id, started.transactionId)).run()
    await expect(service.append({
      transactionId: started.transactionId,
      sessionId: 'session-1',
      sequence: 33,
      text: '',
    })).rejects.toMatchObject({ code: 'TRANSACTION_EXPIRED' })
    expect(service.list('room-1')).toHaveLength(0)
  })

  it('removes interrupted provisional documents during restart recovery', async () => {
    const { db, service } = await createHarness()
    await service.begin({
      title: '未完成文档',
      roomId: 'room-1',
      agentSessionId: 'session-1',
      runId: 'run-interrupted',
    })
    service.dispose()
    const recovered = new DocumentService(db, new DocumentEventBroker())
    disposables.push(() => recovered.dispose())
    expect(recovered.list('room-1')).toHaveLength(0)
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
    const host = new DocumentMcpHost(service, roomRegistry)
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
    await expect(host.callTool('context_room_write_begin', {
      mode: 'create', title: '服务端学习路径', format: 'markdown',
    }, globalContext)).rejects.toThrow('ROOM_SELECTION_REQUIRED')
    expect(service.list('room-1')).toEqual([])
    expect(service.list('room-2')).toEqual([])

    const started = await host.callTool('context_room_write_begin', {
      mode: 'create', title: '服务端学习路径', format: 'markdown',
    }, { ...globalContext, roomId: 'room-2' })
    expect(started.structuredContent).toMatchObject({ roomId: 'room-2', state: 'open' })
    expect(service.list('room-2')).toEqual([
      expect.objectContaining({ roomId: 'room-2', title: '服务端学习路径', status: 'draft' }),
    ])
  })

  it('publishes exactly the five approved MCP tools', async () => {
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
      'context_room_write_begin',
      'context_room_write_append',
      'context_room_write_commit',
      'context_room_write_abort',
    ])
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('准备写入正文的核心内容、重点或结论')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_begin')?.description)
      .toContain('准确概括正文')
    expect(result.tools?.find((tool) => tool.name === 'context_room_write_append')?.description)
      .toContain('充实、完整的长篇内容')

    await host.exchange('mcp-session', {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reconnect', version: '2' } },
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    const reconnected = await host.exchange('mcp-session', {
      jsonrpc: '2.0', id: 4, method: 'tools/list', params: {},
    }, { agentSessionId: 'session-1', runId: 'run-1', roomId: 'room-1' })
    expect((reconnected[0]?.result as { tools?: unknown[] }).tools).toHaveLength(5)
  })
})
