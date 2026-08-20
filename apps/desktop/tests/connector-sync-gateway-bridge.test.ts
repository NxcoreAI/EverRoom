import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { CliConnectorSyncGatewayBridge } from '../src/main/gateway/connector-sync-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('CliConnectorSyncGatewayBridge requests', () => {
  it('serializes pagination and posts selected record ids for ingest', async () => {
    const requests: Array<{ method: string; path: string; body: string }> = []
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method ?? '', path: request.url ?? '', body: await body(request) })
      if (request.method === 'GET') {
        json(response, { items: [], total: 1048, limit: 25, offset: 50 })
      } else {
        json(response, { items: [], imported: 0, deduped: 0, failed: 0 })
      }
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
    const bridge = new CliConnectorSyncGatewayBridge(supervisor)

    const page = await bridge.data({ dataset: 'emails', query: '预算', limit: 25, offset: 50 })
    await bridge.ingestRecords(['record-1', 'record-2'])

    expect(page).toMatchObject({ total: 1048, limit: 25, offset: 50 })
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/v1/cli-connectors/data?dataset=emails&query=%E9%A2%84%E7%AE%97&limit=25&offset=50',
      body: '',
    })
    expect(requests[1]).toEqual({
      method: 'POST',
      path: '/v1/cli-connectors/data/ingest',
      body: JSON.stringify({ recordIds: ['record-1', 'record-2'] }),
    })
  })

  it('only sends a JSON content type when the request has a body', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: await body(request),
      })
      json(response, { id: 'job-1' })
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
    const bridge = new CliConnectorSyncGatewayBridge(supervisor)

    await bridge.createJob({
      name: 'Gmail recent mail',
      service: 'gmail',
      dataset: 'emails',
      resourceType: 'email',
      connectionName: 'default',
      allowedActions: ['fetch_emails'],
      input: { query: 'newer_than:1d' },
      goal: 'Sync recent mail',
      promptProfileId: null,
      promptOverride: null,
      scheduleType: 'manual',
      intervalMs: 900_000,
      timezone: 'Asia/Shanghai',
      retryPolicy: { maxAttempts: 3, baseDelayMs: 30_000 },
      status: 'active',
    })
    await bridge.runJob('job-1')

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/cli-connectors/sync/jobs'],
      ['POST', '/v1/cli-connectors/sync/jobs/job-1/run'],
    ])
    expect(requests[0]).toMatchObject({
      contentType: 'application/json',
      body: expect.stringContaining('Gmail recent mail'),
    })
    expect(requests[1]).toMatchObject({ body: '' })
    expect(requests[1]).not.toHaveProperty('contentType')
  })
})
