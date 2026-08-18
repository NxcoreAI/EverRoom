import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { RealityGatewayBridge } from '../src/main/gateway/reality-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []
const eventId = 'bcd005ac-05e1-40d4-ad69-e2102f78a29d'

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

    await new RealityGatewayBridge(supervisor).confirm(eventId)

    expect(received).toEqual({ contentType: 'application/json', body: '{}' })
  })
})
