import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RealityGatewayBridge } from '../src/main/gateway/reality-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []
const eventId = 'bcd005ac-05e1-40d4-ad69-e2102f78a29d'

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('RealityGatewayBridge requests', () => {
  it('sends confirm as supported JSON instead of an empty form request', async () => {
    let received: { contentType?: string; body: string } | null = null
    const server = createServer(async (request, response: ServerResponse) => {
      const requestBody = await body(request)
      received = {
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: eventId }))
    })
    const port = await listen(server)
    const supervisor = {
      getConnection: () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as GatewaySupervisor

    await new RealityGatewayBridge(supervisor).confirm(eventId)

    expect(received).toEqual({ contentType: 'application/json', body: '{}' })
  })

  it('refreshes a stale gateway connection and retries the request once', async () => {
    const staleServer = createServer()
    const stalePort = await listen(staleServer)
    const recoveredRequests: string[] = []
    const recoveredServer = createServer((request, response) => {
      recoveredRequests.push(request.url ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('[]')
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
      getConnection: () => staleConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    await close(staleServer)

    await expect(new RealityGatewayBridge(supervisor).listEvents()).resolves.toEqual([])

    expect(recoverConnection).toHaveBeenCalledOnce()
    expect(recoverConnection).toHaveBeenCalledWith(staleConnection)
    expect(recoveredRequests).toEqual(['/v1/reality/events'])
  })

  it('does not recover or retry an HTTP application error', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'reality unavailable' }))
    })
    const port = await listen(server)
    const connection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: 'test-token',
      version: 'test',
    }
    const recoverConnection = vi.fn()
    const supervisor = {
      getConnection: () => connection,
      recoverConnection,
    } as unknown as GatewaySupervisor

    await expect(new RealityGatewayBridge(supervisor).listEvents()).rejects.toThrow('reality unavailable')
    expect(recoverConnection).not.toHaveBeenCalled()
    expect(requests).toBe(1)
  })
})
