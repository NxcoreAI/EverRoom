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
  it('starts lazily and coalesces concurrent first connection requests', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-gateway-supervisor-'))
    temporaryDirectories.push(dataDirectory)
    const supervisor = new GatewaySupervisor(dataDirectory)
    const connection: GatewayConnection = {
      pid: 10,
      baseUrl: 'http://127.0.0.1:4000',
      token: 'lazy-token',
      version: 'test',
    }
    const start = vi.spyOn(supervisor, 'start').mockImplementation(async () => {
      await Promise.resolve()
      ;(supervisor as unknown as { connection: GatewayConnection | null }).connection = connection
      return connection
    })

    const [first, second] = await Promise.all([
      supervisor.ensureConnection(),
      supervisor.ensureConnection(),
    ])

    expect(first).toEqual(connection)
    expect(second).toEqual(connection)
    expect(start).toHaveBeenCalledOnce()
  })

  it('starts a replacement process after the cached child has exited', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-gateway-supervisor-'))
    temporaryDirectories.push(dataDirectory)
    const supervisor = new GatewaySupervisor(dataDirectory)
    const staleConnection: GatewayConnection = {
      pid: 10,
      baseUrl: 'http://127.0.0.1:1',
      token: 'stale-token',
      version: 'old',
    }
    const replacement: GatewayConnection = {
      pid: 20,
      baseUrl: 'http://127.0.0.1:2',
      token: 'replacement-token',
      version: 'new',
    }
    ;(supervisor as unknown as { connection: GatewayConnection | null }).connection = staleConnection
    const start = vi.spyOn(supervisor, 'start').mockImplementation(async () => {
      ;(supervisor as unknown as { connection: GatewayConnection | null }).connection = replacement
      return replacement
    })

    await expect(supervisor.recoverConnection(staleConnection)).resolves.toEqual(replacement)
    expect(start).toHaveBeenCalledOnce()
  })

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

  it('waits for a replacement runtime manifest during a gateway restart', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/v1/health/ready') {
        response.writeHead(404).end()
        return
      }
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
    const manifestPath = join(runtimeDirectory, 'gateway.json')
    const staleConnection: GatewayConnection = {
      pid: 10,
      baseUrl: 'http://127.0.0.1:1',
      token: 'stable-token',
      version: 'old',
    }
    await writeFile(manifestPath, JSON.stringify({
      ...staleConnection,
      startedAt: new Date().toISOString(),
    }))
    const supervisor = new GatewaySupervisor(dataDirectory)
    const supervisorState = supervisor as unknown as {
      child: object | null
      connection: GatewayConnection | null
    }
    supervisorState.child = {}
    supervisorState.connection = staleConnection

    const recovery = supervisor.recoverConnection(staleConnection)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await writeFile(manifestPath, JSON.stringify({
      pid: 20,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: staleConnection.token,
      startedAt: new Date().toISOString(),
      version: 'new',
    }))

    await expect(recovery).resolves.toMatchObject({
      pid: 20,
      baseUrl: `http://127.0.0.1:${String(port)}`,
      version: 'new',
    })
  })
})
