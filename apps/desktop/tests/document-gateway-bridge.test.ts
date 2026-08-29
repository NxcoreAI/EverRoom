import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentEventFrame, DocumentOperation, DocumentOperationSummary } from '@nxcore/agent-contract'
import {
  DocumentGatewayBridge,
  documentOperationListResult,
  operationIdFromDocumentEvent,
} from '../src/main/gateway/document-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('DocumentGatewayBridge CRUD', () => {
  it('preserves gateway error codes for renderer recovery', async () => {
    const server = createServer((_request, response) => {
      json(response, 409, {
        error: 'DOCUMENT_CONFLICT',
        message: 'Document version has changed',
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const bridge = new DocumentGatewayBridge({
      getConnection: () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as GatewaySupervisor)

    await expect(bridge.get('doc-conflict'))
      .rejects.toThrow('DOCUMENT_CONFLICT: Document version has changed')
  })

  it('sends JSON headers only for requests with bodies and supports a full CRUD cycle', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    let version = 1
    let contentJson: Record<string, unknown> = { type: 'doc', content: [] }
    const document = () => ({
      id: 'doc-crud',
      roomId: 'room-crud',
      title: 'CRUD 文档',
      contentJson,
      version,
      status: 'active',
      activeTransactionId: null,
      deletedAt: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      })
      if (request.headers.authorization !== 'Bearer test-token') return json(response, 401, {})
      if (request.method === 'POST') return json(response, 200, document())
      if (request.method === 'PUT') {
        const input = JSON.parse(requestBody) as { contentJson: Record<string, unknown> }
        contentJson = input.contentJson
        version += 1
        return json(response, 200, document())
      }
      if (request.method === 'DELETE') {
        response.writeHead(204)
        return response.end()
      }
      if (request.url?.startsWith('/v1/documents?')) return json(response, 200, [document()])
      return json(response, 200, document())
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const supervisor = {
      getConnection: () => ({ pid: 1, baseUrl: `http://127.0.0.1:${String(port)}`, token: 'test-token', version: 'test' }),
    } as GatewaySupervisor
    const bridge = new DocumentGatewayBridge(supervisor)

    await bridge.import({ id: 'doc-crud', roomId: 'room-crud', title: 'CRUD 文档', contentJson })
    await expect(bridge.list('room-crud')).resolves.toHaveLength(1)
    await expect(bridge.listTrash('room-crud')).resolves.toHaveLength(1)
    await expect(bridge.get('doc-crud')).resolves.toMatchObject({ id: 'doc-crud', version: 1 })
    await bridge.listBlocks('doc-crud')
    await bridge.resolveBlockReferences({
      sourceRoomId: 'room-crud',
      references: [{ roomId: 'room-crud', documentId: 'doc-crud', blockId: 'block-1' }],
    })
    await expect(bridge.save('doc-crud', {
      baseVersion: 1,
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    })).resolves.toMatchObject({ version: 2 })
    await expect(bridge.delete('doc-crud')).resolves.toBeUndefined()
    await expect(bridge.restore('doc-crud')).resolves.toMatchObject({ id: 'doc-crud' })
    await expect(bridge.deletePermanently('doc-crud')).resolves.toBeUndefined()
    await expect(bridge.emptyTrash('room-crud')).resolves.toBeUndefined()

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/documents/import'],
      ['GET', '/v1/documents?roomId=room-crud'],
      ['GET', '/v1/documents?roomId=room-crud&trashed=true'],
      ['GET', '/v1/documents/doc-crud'],
      ['GET', '/v1/documents/doc-crud/blocks'],
      ['POST', '/v1/document-blocks/resolve'],
      ['PUT', '/v1/documents/doc-crud'],
      ['DELETE', '/v1/documents/doc-crud'],
      ['POST', '/v1/documents/doc-crud/restore'],
      ['DELETE', '/v1/documents/doc-crud/permanent'],
      ['DELETE', '/v1/documents/trash?roomId=room-crud'],
    ])
    expect(requests[0]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('doc-crud') })
    expect(requests[1]).toMatchObject({ body: '' })
    expect(requests[1]).not.toHaveProperty('contentType')
    expect(requests[2]).not.toHaveProperty('contentType')
    expect(requests[3]).not.toHaveProperty('contentType')
    expect(requests[5]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('sourceRoomId') })
    expect(requests[6]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('baseVersion') })
    for (const index of [4, 7, 8, 9, 10]) {
      expect(requests[index]).toMatchObject({ body: '' })
      expect(requests[index]).not.toHaveProperty('contentType')
    }
  })

  it('lists, loads, and commands document operations with revision-safe inputs', async () => {
    const requests: Array<{ method: string; path: string; body: string }> = []
    const summary: DocumentOperationSummary = {
      id: 'operation-1',
      capabilityId: 'document.edit',
      capabilityVersion: 1,
      interactionMode: 'atomic_review',
      presenterKey: 'atomic-diff',
      roomId: 'room 1',
      documentId: 'doc/1',
      documentTitle: '计划',
      sessionId: 'session-1',
      runId: 'run-1',
      baseVersion: 3,
      status: 'awaiting_review',
      revision: 2,
      summary: '调整计划',
      conflictVersion: null,
      error: null,
      expiresAt: null,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
      completedAt: null,
    }
    const operation: DocumentOperation = { ...summary, input: {}, result: null, items: [] }
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({ method: request.method ?? '', path: request.url ?? '', body: requestBody })
      if (request.method === 'POST' && request.url === '/v1/document-operations') {
        return json(response, 200, operation)
      }
      if (request.method === 'POST') {
        return json(response, 200, { operation: { ...operation, revision: 3 }, duplicate: false })
      }
      if (request.url?.includes('/commands')) return json(response, 404, {})
      if (request.url?.startsWith('/v1/document-operations?')) {
        return json(response, 200, { operations: [summary] })
      }
      return json(response, 200, operation)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const bridge = new DocumentGatewayBridge({
      getConnection: () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'operation-token',
        version: 'test',
      }),
    } as GatewaySupervisor)

    await expect(bridge.listOperations({
      roomId: 'room 1',
      documentId: 'doc/1',
      sessionId: 'session/1',
      status: 'awaiting_review',
    })).resolves.toEqual([summary])
    const startInput = {
      capabilityId: 'document.selection-rewrite',
      context: {
        roomId: 'room 1',
        documentId: 'doc/1',
        sessionId: 'session-1',
        runId: 'run-1',
      },
      input: {
        baseVersion: 3,
        proposedContentJson: { type: 'doc', content: [] },
        originalText: '原文',
        replacementText: '新文',
        instruction: '重写',
      },
    }
    await expect(bridge.startOperation(startInput)).resolves.toEqual(operation)
    await expect(bridge.getOperation('operation/1')).resolves.toEqual(operation)
    await expect(bridge.executeOperationCommand('operation/1', {
      commandId: 'command-1',
      expectedRevision: 2,
      type: 'review.apply',
      payload: { acceptedItemIds: ['item-1'] },
    })).resolves.toMatchObject({ operation: { revision: 3 }, duplicate: false })

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/v1/document-operations?roomId=room+1&documentId=doc%2F1&sessionId=session%2F1&status=awaiting_review',
        body: '',
      },
      { method: 'POST', path: '/v1/document-operations', body: JSON.stringify(startInput) },
      { method: 'GET', path: '/v1/document-operations/operation%2F1', body: '' },
      {
        method: 'POST',
        path: '/v1/document-operations/operation%2F1/commands',
        body: JSON.stringify({
          commandId: 'command-1',
          expectedRevision: 2,
          type: 'review.apply',
          payload: { acceptedItemIds: ['item-1'] },
        }),
      },
    ])
    expect(documentOperationListResult({ operations: [summary] })).toEqual([summary])
  })

  it('extracts operation ids from summary and compact operation events', () => {
    const frame = (payload: unknown): DocumentEventFrame => ({
      type: 'document.event',
      protocol: 1,
      event: {
        id: 'event-1',
        roomId: 'room-1',
        documentId: 'doc-1',
        operationId: null,
        type: 'document.operation.changed',
        occurredAt: '2026-08-17T00:00:00.000Z',
        payload,
      },
    })
    expect(operationIdFromDocumentEvent(frame({ operation: { id: 'operation-1' } }))).toBe('operation-1')
    expect(operationIdFromDocumentEvent(frame({ operationId: 'operation-2' }))).toBe('operation-2')
    expect(operationIdFromDocumentEvent(frame({ operation: {}, operationId: 'operation-3' }))).toBe('operation-3')
    expect(operationIdFromDocumentEvent({ ...frame({ operationId: 'operation-4' }), event: {
      ...frame({ operationId: 'operation-4' }).event,
      type: 'document.changed',
    } })).toBeNull()
  })
})

describe('DocumentGatewayBridge 订阅就绪韧性', () => {
  it('网关未就绪时订阅不抛未捕获异常，恢复后自动补连', async () => {
    // 复现线上路径：gateway 重启窗口内 getConnection 抛“尚未就绪”，
    // 旧实现直接在重连定时器回调里抛成 Uncaught Exception。
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ server })
    const opened = new Promise<void>((resolve) => wss.on('connection', () => resolve()))

    const connection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: 'test-token',
      version: 'test',
    }
    let ready = false
    const ensureConnection = vi.fn(async () => {
      ready = true
      return connection
    })
    const bridge = new DocumentGatewayBridge({
      getConnection: () => {
        if (!ready) throw new Error('NxCore Gateway 尚未就绪。')
        return connection
      },
      ensureConnection,
    } as unknown as GatewaySupervisor)

    const sent: Array<[string, unknown]> = []
    const contents = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push([channel, payload]),
      once: () => undefined,
    } as never

    expect(() => bridge.subscribe(contents, 'room-reconnect')).not.toThrow()
    // 服务端 connection 与客户端 open 的先后不确定，轮询等 renderer 收到基线刷新信号。
    await vi.waitFor(() => {
      expect(sent.some(([channel]) => channel === 'documents:ready')).toBe(true)
    }, { timeout: 3_000 })
    expect(ensureConnection).toHaveBeenCalled()

    bridge.dispose()
    await opened
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }, 10_000)
})
