import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorGatewayBridge } from './connector-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'

function bridge(): ConnectorGatewayBridge {
  return new ConnectorGatewayBridge({} as GatewaySupervisor)
}

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

describe('ConnectorGatewayBridge input boundary', () => {
  it('rejects unsupported providers before issuing a request', () => {
    expect(() => bridge().registerConnection({
      provider: 'imap' as 'gmail',
      nangoConfigKey: 'mail',
      nangoConnectionId: 'connection-1',
    })).toThrow('不支持的连接提供方')
  })

  it('rejects unsupported authorization providers before issuing a request', async () => {
    await expect(bridge().startAuthorization('imap' as 'gmail')).rejects.toThrow('不支持的连接提供方')
  })

  it('rejects unsafe path identifiers', () => {
    expect(() => bridge().triggerSync('../scope', 'incremental')).toThrow('无效的连接器标识')
  })

  it('rejects unsafe wiki document identifiers', () => {
    expect(() => bridge().document('connection-1', '../secrets')).toThrow('无效的连接器标识')
  })

  it('rejects unknown synchronization modes', () => {
    expect(() => bridge().triggerSync('scope-1', 'unknown' as 'full')).toThrow('无效的同步模式')
  })

  it('rejects unknown fault injection points', () => {
    expect(() => bridge().armFault('before_commit')).toThrow('无效的故障注入点')
  })

  it('rejects unknown record types before issuing a request', () => {
    expect(() => bridge().records('connection-1', 'document' as 'mail')).toThrow('无效的数据记录类型')
  })

  it('sends valid JSON for bodyless connector POST actions', async () => {
    const requests: Array<{ path: string; contentType?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: await requestBody(request),
      })
      json(response, request.url?.includes('/cancel')
        ? { id: 'run-1', scopeId: 'scope-1', mode: 'full', status: 'running', processed: 0, failed: 0, error: null, startedAt: new Date(0).toISOString(), finishedAt: null }
        : { ok: true })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const testBridge = new ConnectorGatewayBridge({
      getConnection: () => ({ pid: 1, baseUrl: `http://127.0.0.1:${String(port)}`, token: 'test-token', version: 'test' }),
    } as GatewaySupervisor)

    await testBridge.cancelRun('run-1')
    await testBridge.disableConnection('connection-1')

    expect(requests.map((request) => request.path)).toEqual([
      '/v1/connectors/runs/run-1/cancel',
      '/v1/connectors/connections/connection-1/disable',
    ])
    for (const request of requests) {
      expect(request.contentType).toContain('application/json')
      expect(request.body).toBe('{}')
    }
  })
})
