import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ContextRoomSnapshot, SaveContextRoomSnapshotInput } from '@nxcore/agent-contract'
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
    await expect(bridge.syncSnapshot({
      rooms: [{ id: 'room-1', title: '项目 A', kind: '项目', data: { id: 'room-1', title: '项目 A' } }],
      deletedRooms: [{ id: 'room-2', title: '归档主题', kind: '主题', data: { id: 'room-2' } }],
    })).resolves.toMatchObject({ updatedAt: '2026-08-16T08:00:00.000Z' })

    expect(requests).toEqual([
      { method: 'GET', path: '/v1/context-rooms', body: '' },
      {
        method: 'PUT',
        path: '/v1/context-rooms/snapshot',
        contentType: 'application/json',
        body: expect.stringContaining('deletedRooms'),
      },
    ])
  })
})
