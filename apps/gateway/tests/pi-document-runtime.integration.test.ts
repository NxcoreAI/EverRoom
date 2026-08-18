import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PiAgentRuntime } from '@nxcore/agent-runtime-pi'
import type { RuntimeEvent, StartRuntimeRunInput } from '@nxcore/agent-runtime'
import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { agentSessions, documentOperationItems, documentOperations } from '../src/infrastructure/database/schema.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentMcpHost } from '../src/modules/documents/mcp-host.js'
import { createDocumentPiTools } from '../src/modules/documents/pi-tools.js'
import { DocumentService } from '../src/modules/documents/service.js'
import { DocumentOperationService } from '../src/modules/documents/operations/service.js'

const temporaryDirectories: string[] = []
const disposables: Array<() => void | Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposables.splice(0).reverse().map((dispose) => dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function findOperationId(value: unknown): string | null {
  if (typeof value === 'string') {
    if (!value.includes('operationId')) return null
    try {
      return findOperationId(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const operationId = findOperationId(item)
      if (operationId) return operationId
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.operationId === 'string') return record.operationId
  for (const item of Object.values(record).reverse()) {
    const operationId = findOperationId(item)
    if (operationId) return operationId
  }
  return null
}

function findStringProperty(value: unknown, property: string): string | null {
  if (typeof value === 'string') {
    if (!value.includes(property)) return null
    try {
      return findStringProperty(JSON.parse(value) as unknown, property)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const result = findStringProperty(item, property)
      if (result) return result
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record[property] === 'string') return record[property]
  for (const item of Object.values(record).reverse()) {
    const result = findStringProperty(item, property)
    if (result) return result
  }
  return null
}

function sendChunk(response: ServerResponse, chunk: unknown): void {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function sendToolCall(
  response: ServerResponse,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sendChunk(response, {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'nxcore-pi-document-test',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })
  sendChunk(response, {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'nxcore-pi-document-test',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  response.end('data: [DONE]\n\n')
}

function sendText(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sendChunk(response, {
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'nxcore-pi-document-test',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })
  sendChunk(response, {
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'nxcore-pi-document-test',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  response.end('data: [DONE]\n\n')
}

async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('Pi document tool integration', () => {
  it('commits without renderer ACK and refreshes Room context on a reused Pi session', async () => {
    let requestStep = 0
    const endpoint = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
          response.writeHead(404).end()
          return
        }
        const body = await readJson(request)
        const operationId = findOperationId(body)
        switch (requestStep++) {
          case 0:
            sendToolCall(response, 'call-begin-a', 'context_room_write_begin', {
              mode: 'create', title: 'Room A 文档', format: 'markdown',
            })
            return
          case 1:
            if (!operationId) throw new Error('begin result did not reach the model')
            sendToolCall(response, 'call-append-a', 'context_room_write_append', {
              operationId, sequence: 1, text: '# Room A 文档\n',
            })
            return
          case 2:
            if (!operationId) throw new Error('append result did not reach the model')
            sendToolCall(response, 'call-commit-a', 'context_room_write_commit', {
              operationId, finalSequence: 1,
            })
            return
          case 3:
            sendText(response, 'Room A 文档已创建。')
            return
          case 4:
            sendToolCall(response, 'call-begin-b', 'context_room_write_begin', {
              mode: 'create', title: 'Room B 临时文档', format: 'markdown',
            })
            return
          case 5:
            if (!operationId) throw new Error('second begin result did not reach the model')
            sendToolCall(response, 'call-abort-b', 'context_room_write_abort', {
              operationId, reason: 'integration-test',
            })
            return
          case 6:
            sendText(response, 'Room B 临时文档已中止。')
            return
          default:
            throw new Error(`unexpected model request ${String(requestStep)}`)
        }
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
        response.end(error instanceof Error ? error.message : 'model test failure')
      })
    })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
    if (!address || typeof address === 'string') throw new Error('Test endpoint did not bind')
    disposables.push(async () => {
      endpoint.close()
      await once(endpoint, 'close')
    })

    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-pi-document-integration-'))
    temporaryDirectories.push(dataDir)
    const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    db.insert(agentSessions).values({
      id: 'session-shared', roomId: 'room-a', pageLabel: 'Context Room', runtimeId: 'pi',
    }).run()
    const broker = new DocumentEventBroker()
    const service = new DocumentService(db, broker)
    const operations = new DocumentOperationService(db, broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    const runtime = new PiAgentRuntime({
      provider: 'nxcore-pi-document-test',
      model: 'nxcore-pi-document-test',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      apiKey: 'test-key',
      api: 'openai-completions',
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0,
      reasoning: 'off',
      sessionsDir: join(dataDir, 'sessions'),
      workingDirectory: join(dataDir, 'workspace'),
      agentDirectory: join(dataDir, 'config'),
    }, {
      tools: createDocumentPiTools(host),
      onRunFinished: (input, outcome) => host.finishAgentRun(input.sessionId, outcome, input.runId),
    })
    disposables.push(async () => {
      await runtime.dispose()
      await host.close()
      sqlite.close()
    })

    const firstInput: StartRuntimeRunInput = {
      runId: 'run-a',
      sessionId: 'session-shared',
      runtimeSessionRef: null,
      prompt: '在 Room A 创建文档',
      pageLabel: 'Context Room',
      roomId: 'room-a',
    }
    const firstRun = await runtime.start(firstInput)
    const firstEvents = await collect(firstRun.events)

    expect(firstEvents.filter((event) => event.type === 'tool.completed').map((event) =>
      (event.payload as { name?: string }).name)).toEqual([
      'context_room_write_begin',
      'context_room_write_append',
      'context_room_write_commit',
    ])
    expect(firstEvents.at(-1)?.type).toBe('run.completed')
    expect(service.list('room-a')).toEqual([
      expect.objectContaining({ title: 'Room A 文档', status: 'active', version: 1 }),
    ])

    const secondRun = await runtime.start({
      ...firstInput,
      runId: 'run-b',
      runtimeSessionRef: firstRun.runtimeSessionRef,
      prompt: '在 Room B 创建后中止',
      roomId: 'room-b',
    })
    const secondEvents = await collect(secondRun.events)
    expect(secondEvents.filter((event) => event.type === 'tool.completed').map((event) =>
      (event.payload as { name?: string }).name)).toEqual([
      'context_room_write_begin',
      'context_room_write_abort',
    ])
    expect(service.list('room-b')).toEqual([])

    const persistedOperations = db.select().from(documentOperations)
      .orderBy(asc(documentOperations.createdAt)).all()
    expect(persistedOperations).toEqual([
      expect.objectContaining({
        agentSessionId: 'session-shared', runId: 'run-a', roomId: 'room-a', status: 'completed',
      }),
      expect.objectContaining({
        agentSessionId: 'session-shared', runId: 'run-b', roomId: 'room-b', status: 'cancelled',
      }),
    ])
    await expect(runtime.start({
      ...firstInput,
      runId: 'run-forbidden',
      sessionId: 'another-local-session',
      runtimeSessionRef: firstRun.runtimeSessionRef,
    })).rejects.toThrow('different Agent session')
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-forbidden')).all()).toEqual([])
  }, 20_000)

  it('keeps a prepared edit awaiting review after the Pi run completes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-pi-edit-review-integration-'))
    temporaryDirectories.push(dataDir)
    const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    db.insert(agentSessions).values({
      id: 'session-edit-review', roomId: 'room-edit-review', pageLabel: 'Context Room', runtimeId: 'pi',
    }).run()
    const broker = new DocumentEventBroker()
    const service = new DocumentService(db, broker)
    const unchangedParagraphs = [
      '后续正文第一部分保持不变，介绍类型系统、函数签名和基础工程配置。'.repeat(2),
      '后续正文第二部分保持不变，介绍类、接口、泛型以及常见组合方式。'.repeat(2),
      '后续正文第三部分保持不变，介绍构建、测试、发布和运行时诊断。'.repeat(2),
      '后续正文第四部分保持不变，通过实践项目串联前面的语言知识。'.repeat(2),
    ]
    const document = await service.import({
      id: 'doc-edit-review', roomId: 'room-edit-review', title: 'Java 学习文档',
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '原始开头。' }] },
        ...unchangedParagraphs.map((text) => ({
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text }],
        })),
      ] },
    })
    const firstBlockId = service.listBlocks(document.id)[0]!.blockId

    let requestStep = 0
    const endpoint = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
          response.writeHead(404).end()
          return
        }
        const body = await readJson(request)
        const operationId = findStringProperty(body, 'operationId')
        switch (requestStep++) {
          case 0:
            // Reproduce the production failure: the model starts the patch before reading.
            sendToolCall(response, 'call-edit-begin-without-read', 'context_room_patch_begin', {
              documentId: document.id,
              baseVersion: document.version,
              kind: 'edit',
              summary: '重写 Java 学习文档的开头部分，使其更加详细',
            })
            return
          case 1:
            sendToolCall(response, 'call-edit-read-after-error', 'context_room_document_read', {
              documentId: document.id,
            })
            return
          case 2:
            sendToolCall(response, 'call-edit-begin', 'context_room_patch_begin', {
              documentId: document.id,
              baseVersion: document.version,
              kind: 'edit',
              summary: '重写 Java 学习文档的开头部分，使其更加详细',
            })
            return
          case 3:
            if (!operationId) throw new Error('patch begin result did not reach the model')
            sendToolCall(response, 'call-edit-hunk-with-full-document', 'context_room_patch_hunk', {
              sequence: 1,
              operation: 'replace',
              target: { blockId: firstBlockId },
              markdown: ['重写后的详细开头。', ...unchangedParagraphs].join('\n\n'),
            })
            return
          case 4:
            if (!operationId) throw new Error('patch hunk result did not reach the model')
            sendToolCall(response, 'call-edit-commit', 'context_room_patch_commit', {
              operationId: '725555bb-8699-47fd-adb4-1f72a91562bc',
              finalSequence: 1,
            })
            return
          case 5:
            sendText(response, '修改建议已准备好，等待你审阅。')
            return
          default:
            throw new Error(`unexpected model request ${String(requestStep)}`)
        }
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
        response.end(error instanceof Error ? error.message : 'model test failure')
      })
    })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
    if (!address || typeof address === 'string') throw new Error('Test endpoint did not bind')

    const operations = new DocumentOperationService(db, broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    const runtime = new PiAgentRuntime({
      provider: 'nxcore-pi-edit-review-test',
      model: 'nxcore-pi-edit-review-test',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      apiKey: 'test-key',
      api: 'openai-completions',
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0,
      reasoning: 'off',
      sessionsDir: join(dataDir, 'sessions'),
      workingDirectory: join(dataDir, 'workspace'),
      agentDirectory: join(dataDir, 'config'),
    }, {
      tools: createDocumentPiTools(host),
      onRunFinished: (input, outcome) => host.finishAgentRun(input.sessionId, outcome, input.runId),
    })
    disposables.push(async () => {
      await runtime.dispose()
      await host.close()
      sqlite.close()
      endpoint.close()
      await once(endpoint, 'close')
    })

    const run = await runtime.start({
      runId: 'run-edit-review',
      sessionId: 'session-edit-review',
      runtimeSessionRef: null,
      prompt: '重写 Java 学习文档的开头部分，使其更加详细',
      pageLabel: 'Context Room',
      roomId: 'room-edit-review',
      activeDocument: {
        roomId: 'room-edit-review', documentId: document.id, title: document.title,
        version: document.version, defaultAnchor: 'end',
      },
    })
    const events = await collect(run.events)
    expect(events.at(-1)?.type).toBe('run.completed')
    const failedBegin = events.find((event) => event.type === 'tool.failed'
      && (event.payload as { name?: string }).name === 'context_room_patch_begin')
    expect(failedBegin).toBeDefined()
    expect(JSON.stringify(failedBegin?.payload)).toContain('DOCUMENT_READ_REQUIRED')
    expect(JSON.stringify(failedBegin?.payload)).toContain('context_room_document_read')
    expect(events.filter((event) => event.type === 'tool.completed').map((event) =>
      (event.payload as { name?: string }).name)).toEqual([
      'context_room_document_read',
      'context_room_patch_begin',
      'context_room_patch_hunk',
      'context_room_patch_commit',
    ])
    const hunkEvent = events.find((event) => event.type === 'tool.completed'
      && (event.payload as { name?: string }).name === 'context_room_patch_hunk')
    expect(JSON.stringify(hunkEvent?.payload)).toContain('"fragmentReduced":true')
    expect(JSON.stringify(hunkEvent?.payload)).toContain('"operationIdCorrected":true')
    const commitEvent = events.find((event) => event.type === 'tool.completed'
      && (event.payload as { name?: string }).name === 'context_room_patch_commit')
    expect(JSON.stringify(commitEvent?.payload)).toContain('"documentChanged":false')
    expect(JSON.stringify(commitEvent?.payload)).toContain('"operationIdCorrected":true')
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-edit-review')).get()).toMatchObject({
      status: 'awaiting_review',
    })
    expect(service.get(document.id)).toMatchObject({
      version: 1,
      contentJson: document.contentJson,
    })
  }, 20_000)

  it('cancels a run after a persisted append and rolls back the draft', async () => {
    let requestStep = 0
    const endpoint = createServer((request, response) => {
      void (async () => {
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
          response.writeHead(404).end()
          return
        }
        const body = await readJson(request)
        if (requestStep++ % 2 === 0) {
          sendToolCall(response, 'call-cancel-begin', 'context_room_write_begin', {
            mode: 'create', title: '等待 ACK 的文档', format: 'markdown',
          })
          return
        }
        const operationId = findOperationId(body)
        if (!operationId) throw new Error('cancel begin result did not reach the model')
        sendToolCall(response, 'call-cancel-append', 'context_room_write_append', {
          operationId, sequence: 1, text: '尚未确认的正文',
        })
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
        response.end(error instanceof Error ? error.message : 'model test failure')
      })
    })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
    if (!address || typeof address === 'string') throw new Error('Test endpoint did not bind')
    disposables.push(async () => {
      endpoint.close()
      await once(endpoint, 'close')
    })

    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-pi-document-cancel-'))
    temporaryDirectories.push(dataDir)
    const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    db.insert(agentSessions).values({
      id: 'session-cancel', roomId: 'room-cancel', pageLabel: 'Context Room', runtimeId: 'pi',
    }).run()
    const broker = new DocumentEventBroker()
    const service = new DocumentService(db, broker)
    const operations = new DocumentOperationService(db, broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    const runtime = new PiAgentRuntime({
      provider: 'nxcore-pi-cancel-test',
      model: 'nxcore-pi-cancel-test',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      apiKey: 'test-key',
      api: 'openai-completions',
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0,
      reasoning: 'off',
      sessionsDir: join(dataDir, 'sessions'),
      workingDirectory: join(dataDir, 'workspace'),
      agentDirectory: join(dataDir, 'config'),
    }, {
      tools: createDocumentPiTools(host),
      onRunFinished: (input, outcome) => host.finishAgentRun(input.sessionId, outcome, input.runId),
    })
    disposables.push(async () => {
      await runtime.dispose()
      await host.close()
      sqlite.close()
    })

    const appendNotifications: Array<() => void> = []
    const waitForAppend = () => new Promise<void>((resolvePromise) => appendNotifications.push(resolvePromise))
    const unsubscribe = service.broker.subscribe('room-cancel', {
      readyState: 1,
      send(data) {
        const frame = JSON.parse(data) as { event?: { type?: string; payload?: { operation?: { id?: unknown } } } }
        if (frame.event?.type !== 'document.operation.changed') return
        const operationId = typeof frame.event?.payload?.operation?.id === 'string'
          ? frame.event.payload.operation.id
          : null
        if (!operationId) return
        const hasChunk = db.select().from(documentOperationItems)
          .where(eq(documentOperationItems.operationId, operationId)).get()
        if (hasChunk) appendNotifications.shift()?.()
      },
    })
    disposables.push(unsubscribe)

    const firstAppend = waitForAppend()
    const run = await runtime.start({
      runId: 'run-cancel',
      sessionId: 'session-cancel',
      runtimeSessionRef: null,
      prompt: '创建后等待确认',
      pageLabel: 'Context Room',
      roomId: 'room-cancel',
    })
    const eventsPromise = collect(run.events)
    await firstAppend
    expect(service.list('room-cancel')).toEqual([
      expect.objectContaining({
        title: '等待 ACK 的文档',
        status: 'draft',
        version: 0,
        activeTransactionId: expect.any(String),
      }),
    ])

    await runtime.cancel('run-cancel')
    const events = await eventsPromise

    expect(events.at(-1)?.type).toBe('run.cancelled')
    expect(service.list('room-cancel')).toEqual([])
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-cancel')).get()).toMatchObject({
      agentSessionId: 'session-cancel',
      roomId: 'room-cancel',
      status: 'cancelled',
    })

    const secondAppend = waitForAppend()
    const disposeRun = await runtime.start({
      runId: 'run-dispose',
      sessionId: 'session-cancel',
      runtimeSessionRef: run.runtimeSessionRef,
      prompt: '创建后由 runtime dispose 清理',
      pageLabel: 'Context Room',
      roomId: 'room-cancel',
    })
    const disposeEventsPromise = collect(disposeRun.events)
    await secondAppend
    await runtime.dispose()
    const disposeEvents = await disposeEventsPromise

    expect(disposeEvents.at(-1)?.type).toBe('run.cancelled')
    expect(service.list('room-cancel')).toEqual([])
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-dispose')).get()).toMatchObject({
      agentSessionId: 'session-cancel',
      roomId: 'room-cancel',
      status: 'cancelled',
    })
  }, 20_000)

  it('rolls back open transactions after model failure and an uncommitted completion', async () => {
    let requestStep = 0
    const endpoint = createServer((_request, response) => {
      switch (requestStep++) {
        case 0:
          sendToolCall(response, 'call-failed-begin', 'context_room_write_begin', {
            mode: 'create', title: '模型失败草稿', format: 'markdown',
          })
          return
        case 1:
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'model unavailable' } }))
          return
        case 2:
          sendToolCall(response, 'call-forgotten-begin', 'context_room_write_begin', {
            mode: 'create', title: '忘记提交草稿', format: 'markdown',
          })
          return
        case 3:
          sendText(response, '文档已经完成。')
          return
        default:
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end(`unexpected model request ${String(requestStep)}`)
      }
    })
    endpoint.listen(0, '127.0.0.1')
    await once(endpoint, 'listening')
    const address = endpoint.address()
    if (!address || typeof address === 'string') throw new Error('Test endpoint did not bind')
    disposables.push(async () => {
      endpoint.close()
      await once(endpoint, 'close')
    })

    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-pi-document-terminal-cleanup-'))
    temporaryDirectories.push(dataDir)
    const { db, sqlite } = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    db.insert(agentSessions).values({
      id: 'session-terminal', roomId: 'room-terminal', pageLabel: 'Context Room', runtimeId: 'pi',
    }).run()
    const broker = new DocumentEventBroker()
    const service = new DocumentService(db, broker)
    const operations = new DocumentOperationService(db, broker)
    const host = new DocumentMcpHost(service, undefined, undefined, operations)
    const runtime = new PiAgentRuntime({
      provider: 'nxcore-pi-terminal-test',
      model: 'nxcore-pi-terminal-test',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      apiKey: 'test-key',
      api: 'openai-completions',
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0,
      reasoning: 'off',
      sessionsDir: join(dataDir, 'sessions'),
      workingDirectory: join(dataDir, 'workspace'),
      agentDirectory: join(dataDir, 'config'),
      retry: { enabled: false },
    }, {
      tools: createDocumentPiTools(host),
      onRunFinished: (input, outcome) => host.finishAgentRun(input.sessionId, outcome, input.runId),
    })
    disposables.push(async () => {
      await runtime.dispose()
      await host.close()
      sqlite.close()
    })

    const failedRun = await runtime.start({
      runId: 'run-failed',
      sessionId: 'session-terminal',
      runtimeSessionRef: null,
      prompt: '创建文档后模拟模型失败',
      pageLabel: 'Context Room',
      roomId: 'room-terminal',
    })
    const failedEvents = await collect(failedRun.events)
    expect(failedEvents.at(-1)?.type).toBe('run.failed')
    expect(service.list('room-terminal')).toEqual([])
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-failed')).get()).toMatchObject({
      agentSessionId: 'session-terminal',
      roomId: 'room-terminal',
      status: 'cancelled',
    })

    const completedRun = await runtime.start({
      runId: 'run-uncommitted',
      sessionId: 'session-terminal',
      runtimeSessionRef: failedRun.runtimeSessionRef,
      prompt: '创建文档但不提交',
      pageLabel: 'Context Room',
      roomId: 'room-terminal',
    })
    const completedEvents = await collect(completedRun.events)
    expect(completedEvents.at(-1)?.type).toBe('run.completed')
    expect(service.list('room-terminal')).toEqual([])
    expect(db.select().from(documentOperations)
      .where(eq(documentOperations.runId, 'run-uncommitted')).get()).toMatchObject({
      agentSessionId: 'session-terminal',
      roomId: 'room-terminal',
      status: 'cancelled',
    })
  }, 20_000)
})
