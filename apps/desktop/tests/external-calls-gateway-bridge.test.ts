import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/monitoring/sentry', () => ({ captureSentryLog: vi.fn() }))

import { ExternalCallsGatewayBridge } from '../src/main/gateway/external-calls-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

describe('ExternalCallsGatewayBridge', () => {
  it('keeps authentication in the main process and maps every budget endpoint', async () => {
    const requests: Array<{ method: string; url: string; authorization?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body: await body(request),
      })
      if (request.method === 'DELETE') {
        response.writeHead(204)
        response.end()
        return
      }
      json(response, request.method === 'PUT' ? { id: 'policy-1' } : { items: [], total: 0, limit: 50, offset: 0 })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const port = (server.address() as AddressInfo).port
    const supervisor = { ensureConnection: vi.fn(async () => ({ pid: 1, baseUrl: `http://127.0.0.1:${port}`, token: 'private-token', version: 'test' })) } as unknown as GatewaySupervisor
    const bridge = new ExternalCallsGatewayBridge(supervisor)
    const policy = { subjectScope: 'service', subjectId: 'MCP', service: 'MCP', period: 'UTC_DAY', limit: 10, warningThreshold: 8, enforcement: 'BLOCK' } as const

    await bridge.listPolicies({ service: 'MCP', limit: 10 })
    await bridge.savePolicy(policy)
    await bridge.listUsage({ subjectScope: 'service' })
    await bridge.listAudits({ from: '2026-08-25T00:00:00.000Z', offset: 50 })
    await bridge.deletePolicy('policy/1')

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ['GET', '/v1/external-calls/policies?service=MCP&limit=10'],
      ['PUT', '/v1/external-calls/policies'],
      ['GET', '/v1/external-calls/usage?subjectScope=service'],
      ['GET', '/v1/external-calls/audits?from=2026-08-25T00%3A00%3A00.000Z&offset=50'],
      ['DELETE', '/v1/external-calls/policies/policy%2F1'],
    ])
    expect(requests.every((request) => request.authorization === 'Bearer private-token')).toBe(true)
    expect(JSON.parse(requests[1]!.body)).toEqual(policy)
  })
})
