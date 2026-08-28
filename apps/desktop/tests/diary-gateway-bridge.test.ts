import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DiaryGatewayBridge } from '../src/main/gateway/diary-gateway-bridge'
import type { GatewayConnection, GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

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

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function connection(port: number, version: string): GatewayConnection {
  return {
    pid: 1,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token: 'test-token',
    version,
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('DiaryGatewayBridge requests', () => {
  it('刷新失效的 Gateway 连接并重试一次', async () => {
    const staleServer = createServer((_request, response) => json(response, 200, {}))
    const staleConnection = connection(await listen(staleServer), 'old')
    const recoveredRequests: string[] = []
    const recoveredServer = createServer((request, response) => {
      recoveredRequests.push(request.url ?? '')
      json(response, 202, { runId: 'recovered-run' })
    })
    const recoveredConnection = connection(await listen(recoveredServer), 'new')
    const recoverConnection = vi.fn(async () => recoveredConnection)
    const supervisor = {
      ensureConnection: async () => staleConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    await close(staleServer)

    const result = await new DiaryGatewayBridge(supervisor).generate('2026-08-20')

    expect(result).toEqual({ runId: 'recovered-run' })
    expect(recoverConnection).toHaveBeenCalledOnce()
    expect(recoverConnection).toHaveBeenCalledWith(staleConnection)
    expect(recoveredRequests).toEqual(['/v1/diary/days/2026-08-20/generate'])
  })

  it('HTTP 错误不触发连接恢复', async () => {
    const server = createServer((_request, response) => json(response, 503, { message: '日记服务繁忙' }))
    const currentConnection = connection(await listen(server), 'current')
    const recoverConnection = vi.fn()
    const supervisor = {
      ensureConnection: async () => currentConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor

    await expect(new DiaryGatewayBridge(supervisor).generate('2026-08-20'))
      .rejects.toThrow('日记服务繁忙')
    expect(recoverConnection).not.toHaveBeenCalled()
  })

  it('运行记录 404（数据被重置）时返回 null 而不是抛错', async () => {
    const server = createServer((_request, response) => json(response, 404, { message: 'run not found' }))
    const currentConnection = connection(await listen(server), 'current')
    const recoverConnection = vi.fn()
    const supervisor = {
      ensureConnection: async () => currentConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor

    await expect(new DiaryGatewayBridge(supervisor).run('run-x')).resolves.toBeNull()
    expect(recoverConnection).not.toHaveBeenCalled()
  })

  it('恢复后的连接仍不可用时不再重复恢复', async () => {
    const unavailableServer = createServer()
    const unavailableConnection = connection(await listen(unavailableServer), 'unavailable')
    const recoverConnection = vi.fn(async () => unavailableConnection)
    const supervisor = {
      ensureConnection: async () => unavailableConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    await close(unavailableServer)

    await expect(new DiaryGatewayBridge(supervisor).generate('2026-08-20'))
      .rejects.toThrow(/fetch failed/i)
    expect(recoverConnection).toHaveBeenCalledOnce()
  })
})
