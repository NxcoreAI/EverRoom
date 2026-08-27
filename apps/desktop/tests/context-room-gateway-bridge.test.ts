import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  ContextRoomSnapshot,
  CreateContextRoomResult,
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract'
import { afterEach, describe, expect, it } from 'vitest'

import { ContextRoomGatewayBridge } from '../src/main/gateway/context-room-gateway-bridge'
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

describe('ContextRoomGatewayBridge snapshots', () => {
  it('loads and atomically saves complete Room snapshots', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    const empty: ContextRoomSnapshot = { rooms: [], deletedRooms: [], updatedAt: null }
    let stored = empty
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      })
      if (request.headers.authorization !== 'Bearer room-token') return json(response, 401, {})
      if (request.method === 'POST') {
        const input = JSON.parse(requestBody) as { title: string; description: string }
        const result: CreateContextRoomResult = {
          created: true,
          room: {
            id: 'room-created',
            title: input.title,
            kind: '主题',
            data: { id: 'room-created', title: input.title, description: input.description },
          },
        }
        return json(response, 200, result)
      }
      if (request.method === 'PUT') {
        const input = JSON.parse(requestBody) as SaveContextRoomSnapshotInput
        stored = { ...input, updatedAt: '2026-08-16T08:00:00.000Z' }
      }
      return json(response, 200, stored)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const supervisor = {
      getConnection: () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'room-token',
        version: 'test',
      }),
    } as GatewaySupervisor
    const bridge = new ContextRoomGatewayBridge(supervisor)

    await expect(bridge.list()).resolves.toEqual(empty)
    await expect(bridge.create({
      title: 'Campus Life',
      description: 'Campus activities and study notes',
    })).resolves.toMatchObject({ created: true, room: { id: 'room-created', title: 'Campus Life' } })
    await expect(bridge.syncSnapshot({
      rooms: [{ id: 'room-1', title: '项目 A', kind: '项目', data: { id: 'room-1', title: '项目 A' } }],
      deletedRooms: [{ id: 'room-2', title: '归档主题', kind: '主题', data: { id: 'room-2' } }],
    })).resolves.toMatchObject({ updatedAt: '2026-08-16T08:00:00.000Z' })

    expect(requests).toEqual([
      { method: 'GET', path: '/v1/context-rooms', body: '' },
      {
        method: 'POST',
        path: '/v1/context-rooms',
        contentType: 'application/json',
        body: JSON.stringify({
          title: 'Campus Life',
          description: 'Campus activities and study notes',
        }),
      },
      {
        method: 'PUT',
        path: '/v1/context-rooms/snapshot',
        contentType: 'application/json',
        body: expect.stringContaining('deletedRooms'),
      },
    ])
  })

  it('forwards duplicate review and irreversible merge operations to the Gateway', async () => {
    const requests: Array<{ method: string; path: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({ method: request.method ?? '', path: request.url ?? '', body: requestBody })
      if (request.url?.includes('duplicate-check')) {
        return json(response, 200, { candidates: [], overrideToken: null, expiresAt: null })
      }
      if (request.url?.includes('duplicate-candidates')) return json(response, 200, { items: [] })
      if (request.url?.includes('merge-preview')) return json(response, 200, { previewHash: 'preview' })
      return json(response, 200, { id: 'merge-operation' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const bridge = new ContextRoomGatewayBridge({
      getConnection: () => ({ pid: 1, baseUrl: `http://127.0.0.1:${String(port)}`, token: 'room-token', version: 'test' }),
    } as GatewaySupervisor)

    await bridge.checkDuplicates({ title: '校园生活', description: '校园资料' })
    await bridge.listDuplicateCandidates('open')
    await bridge.updateDuplicateCandidate('candidate-1', 'distinct')
    await bridge.previewMerge('room-source', 'room-target')
    await bridge.startMerge({ sourceRoomId: 'room-source', targetRoomId: 'room-target', previewHash: 'hash', idempotencyKey: 'key' })
    await bridge.getMergeOperation('operation-1')
    await bridge.retryMerge('operation-1')
    await bridge.cancelMerge('operation-1')

    expect(requests).toEqual([
      { method: 'POST', path: '/v1/context-rooms/duplicate-check', body: JSON.stringify({ title: '校园生活', description: '校园资料' }) },
      { method: 'GET', path: '/v1/context-rooms/duplicate-candidates?status=open', body: '' },
      { method: 'PATCH', path: '/v1/context-rooms/duplicate-candidates/candidate-1', body: JSON.stringify({ status: 'distinct' }) },
      { method: 'POST', path: '/v1/context-rooms/merge-preview', body: JSON.stringify({ sourceRoomId: 'room-source', targetRoomId: 'room-target' }) },
      { method: 'POST', path: '/v1/context-rooms/merge-operations', body: JSON.stringify({ sourceRoomId: 'room-source', targetRoomId: 'room-target', previewHash: 'hash', idempotencyKey: 'key' }) },
      { method: 'GET', path: '/v1/context-rooms/merge-operations/operation-1', body: '' },
      { method: 'POST', path: '/v1/context-rooms/merge-operations/operation-1/retry', body: '' },
      { method: 'POST', path: '/v1/context-rooms/merge-operations/operation-1/cancel', body: '' },
    ])
  })
})
