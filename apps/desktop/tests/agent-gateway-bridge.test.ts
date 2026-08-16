import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentGatewayBridge } from '../src/main/gateway/agent-gateway-bridge'
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
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const supervisor = {
      getConnection: () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as GatewaySupervisor
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
  })
})
