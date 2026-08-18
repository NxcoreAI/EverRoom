import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}))
vi.mock('../src/main/monitoring/sentry', () => ({ captureSentryLog: vi.fn() }))

import {
  GatewaySupervisor,
  type GatewayConnection,
} from '../src/main/gateway/gateway-supervisor'

const temporaryDirectories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('GatewaySupervisor connection recovery', () => {
  it('refreshes a cached connection from the latest healthy runtime manifest', async () => {
    let healthRequests = 0
    const server = createServer((request, response) => {
      if (request.url !== '/v1/health/ready') {
        response.writeHead(404).end()
        return
      }
      healthRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo

    const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-gateway-supervisor-'))
    temporaryDirectories.push(dataDirectory)
    const runtimeDirectory = join(dataDirectory, 'runtime')
    await mkdir(runtimeDirectory)
    const staleConnection: GatewayConnection = {
      pid: 10,
      baseUrl: 'http://127.0.0.1:1',
      token: 'stable-token',
      version: 'old',
    }
    await writeFile(join(runtimeDirectory, 'gateway.json'), JSON.stringify({
      pid: 20,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: staleConnection.token,
      startedAt: new Date().toISOString(),
      version: 'new',
    }))
    const supervisor = new GatewaySupervisor(dataDirectory)
    ;(supervisor as unknown as { connection: GatewayConnection | null }).connection = staleConnection

    const [first, second] = await Promise.all([
      supervisor.recoverConnection(staleConnection),
      supervisor.recoverConnection(staleConnection),
    ])

    expect(first).toEqual({
      pid: 20,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: 'stable-token',
      version: 'new',
    })
    expect(second).toEqual(first)
    expect(supervisor.getConnection()).toEqual(first)
    expect(healthRequests).toBe(1)
  })
})
