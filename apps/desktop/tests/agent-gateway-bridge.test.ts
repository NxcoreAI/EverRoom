import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/monitoring/sentry', () => ({ captureSentryLog: vi.fn() }))

import { AgentGatewayBridge } from '../src/main/gateway/agent-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  const index = servers.indexOf(server)
  if (index >= 0) servers.splice(index, 1)
}

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

describe('AgentGatewayBridge requests', () => {
  it('only sends a JSON content type when the request has a body', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      })
      if (request.headers.authorization !== 'Bearer test-token') return json(response, 401, {})
      if (request.method === 'DELETE') {
        response.writeHead(204)
        return response.end()
      }
      if (request.url?.includes('/events?')) return json(response, 200, [])
      return json(response, 200, {})
    })
    const port = await listen(server)
    const ensureConnection = vi.fn(async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }))
    const supervisor = { ensureConnection } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)

    await bridge.createSession({ pageLabel: 'AI 重写', roomId: 'room-1' })
    await bridge.getEvents('session-1', 'run-1', 0)
    await bridge.cancelRun('run-1')
    await bridge.deleteSession('session-1')

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/agent/sessions'],
      ['GET', '/v1/agent/sessions/session-1/events?runId=run-1&afterSeq=0'],
      ['POST', '/v1/agent/runs/run-1/cancel'],
      ['DELETE', '/v1/agent/sessions/session-1'],
    ])
    expect(requests[0]).toMatchObject({
      contentType: 'application/json',
      body: expect.stringContaining('AI 重写'),
    })
    for (const index of [1, 2, 3]) {
      expect(requests[index]).toMatchObject({ body: '' })
      expect(requests[index]).not.toHaveProperty('contentType')
    }
    expect(ensureConnection).toHaveBeenCalledTimes(4)
  })

  it('refreshes a stale gateway connection and retries the request once', async () => {
    const staleServer = createServer((_request, response) => json(response, 200, {}))
    const stalePort = await listen(staleServer)
    const recoveredRequests: string[] = []
    const recoveredServer = createServer((request, response) => {
      recoveredRequests.push(request.url ?? '')
      json(response, 200, { id: 'recovered-session' })
    })
    const recoveredPort = await listen(recoveredServer)
    const staleConnection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(stalePort)}`,
      token: 'test-token',
      version: 'old',
    }
    const recoveredConnection = {
      pid: 2,
      baseUrl: `http://127.0.0.1:${String(recoveredPort)}`,
      token: 'test-token',
      version: 'new',
    }
    const recoverConnection = vi.fn(async () => recoveredConnection)
    const supervisor = {
      ensureConnection: async () => staleConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)
    await close(staleServer)

    const session = await bridge.createSession({ pageLabel: '续写', roomId: 'room-1' })

    expect(session.id).toBe('recovered-session')
    expect(recoverConnection).toHaveBeenCalledOnce()
    expect(recoverConnection).toHaveBeenCalledWith(staleConnection)
    expect(recoveredRequests).toEqual(['/v1/agent/sessions'])
  })

  it('does not retry repeatedly when the recovered connection also refuses', async () => {
    const unavailableServer = createServer()
    const unavailablePort = await listen(unavailableServer)
    const connection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(unavailablePort)}`,
      token: 'test-token',
      version: 'test',
    }
    const recoverConnection = vi.fn(async () => connection)
    const supervisor = {
      ensureConnection: async () => connection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)
    await close(unavailableServer)

    await expect(bridge.createSession({ pageLabel: '续写', roomId: 'room-1' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
    expect(recoverConnection).toHaveBeenCalledOnce()
  })
})
