import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}))

import { OpenConnectorSupervisor } from '../../../../submodules/everroom-connectors/desktop-host/open-connector/open-connector-supervisor'

const temporaryDirectories: string[] = []
const supervisors: OpenConnectorSupervisor[] = []

async function createFixture(): Promise<{ dataDirectory: string; runtimeDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'everroom-open-connector-supervisor-'))
  temporaryDirectories.push(root)
  const runtimeDirectory = join(root, 'runtime')
  const dataDirectory = join(root, 'data')
  await Promise.all([
    mkdir(join(runtimeDirectory, 'src', 'server'), { recursive: true }),
    mkdir(join(runtimeDirectory, 'catalog', 'apps'), { recursive: true }),
    mkdir(join(runtimeDirectory, 'dist', 'web'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({
      type: 'module',
      version: '9.9.9',
    })),
    writeFile(join(runtimeDirectory, 'dist', 'web', 'index.html'), '<!doctype html>'),
    writeFile(join(runtimeDirectory, 'src', 'server', 'index.ts'), `
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT)
const dataDirectory = process.env.OOMOL_CONNECT_DATA_DIR
if (!dataDirectory) throw new Error('missing data directory')
await mkdir(dataDirectory, { recursive: true })
await writeFile(join(dataDirectory, 'environment.json'), JSON.stringify({
  nodeEnv: process.env.NODE_ENV,
  host,
  origin: process.env.OOMOL_CONNECT_ORIGIN,
  httpProxy: process.env.HTTP_PROXY,
  httpsProxy: process.env.HTTPS_PROXY,
  nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
  nodeOptions: process.env.NODE_OPTIONS,
  noProxy: process.env.NO_PROXY,
}))
const server = createServer((request, response) => {
  if (
    request.url === '/v1/health'
    && request.headers.authorization === 'Bearer ' + process.env.OOMOL_CONNECT_RUNTIME_TOKEN
  ) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ success: true, data: { ok: true } }))
    return
  }
  response.statusCode = 401
  response.end()
})
server.listen(port, host)
`),
  ])
  return { dataDirectory, runtimeDirectory }
}

function createSupervisor(
  dataDirectory: string,
  runtimeDirectory: string,
  environment: NodeJS.ProcessEnv = {},
  proxyResolver: (url: string) => Promise<string> = async () => 'DIRECT',
): OpenConnectorSupervisor {
  const supervisor = new OpenConnectorSupervisor(dataDirectory, {
    command: process.execPath,
    environment,
    packaged: false,
    proxyResolver,
    runtimeDirectory,
  })
  supervisors.push(supervisor)
  return supervisor
}

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.shutdown()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('OpenConnectorSupervisor', () => {
  it('starts a production sidecar, reports readiness, and stops it', async () => {
    const { dataDirectory, runtimeDirectory } = await createFixture()
    const supervisor = createSupervisor(dataDirectory, runtimeDirectory)

    const connection = await supervisor.start()

    expect(connection).toMatchObject({
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      managed: true,
      pid: expect.any(Number),
      version: '9.9.9',
    })
    expect(connection.runtimeToken).toHaveLength(43)
    expect(connection.adminToken).toHaveLength(43)
    expect(supervisor.getStatus()).toMatchObject({ state: 'ready', managed: true })
    await expect(fetch(`${connection.baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${connection.runtimeToken}` },
    }).then((response) => response.json())).resolves.toMatchObject({
      success: true,
      data: { ok: true },
    })
    await expect(readFile(join(dataDirectory, 'runtime-data', 'environment.json'), 'utf8')
      .then((value) => JSON.parse(value))).resolves.toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      origin: connection.baseUrl.replace('127.0.0.1', 'localhost'),
    })

    await supervisor.shutdown()
    expect(supervisor.getStatus().state).toBe('stopped')
    await expect(fetch(`${connection.baseUrl}/v1/health`)).rejects.toThrow()
  })

  it('persists generated secrets and the selected port across restarts', async () => {
    const { dataDirectory, runtimeDirectory } = await createFixture()
    const first = createSupervisor(dataDirectory, runtimeDirectory)
    const firstConnection = await first.start()
    await first.shutdown()
    const settingsPath = join(dataDirectory, 'managed-runtime.json')
    const settingsBefore = await readFile(settingsPath, 'utf8')

    const second = createSupervisor(dataDirectory, runtimeDirectory)
    const secondConnection = await second.start()

    expect(secondConnection.baseUrl).toBe(firstConnection.baseUrl)
    expect(secondConnection.runtimeToken).toBe(firstConnection.runtimeToken)
    expect(secondConnection.adminToken).toBe(firstConnection.adminToken)
    expect(await readFile(settingsPath, 'utf8')).toBe(settingsBefore)
    if (process.platform !== 'win32') {
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(dataDirectory, 'runtime-data'))).mode & 0o777).toBe(0o700)
    }
  })

  it('passes the desktop system proxy to provider requests without proxying loopback health checks', async () => {
    const { dataDirectory, runtimeDirectory } = await createFixture()
    const supervisor = createSupervisor(
      dataDirectory,
      runtimeDirectory,
      {},
      async () => 'PROXY 127.0.0.1:7890; DIRECT',
    )

    await supervisor.start()

    await expect(readFile(join(dataDirectory, 'runtime-data', 'environment.json'), 'utf8')
      .then((value) => JSON.parse(value))).resolves.toMatchObject({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      nodeUseEnvProxy: '1',
      nodeOptions: expect.stringContaining('--disable-warning=UNDICI-EHPA'),
      noProxy: expect.stringContaining('127.0.0.1'),
    })
  })

  it('uses an explicitly configured external runtime without local files or a child process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-open-connector-external-'))
    temporaryDirectories.push(root)
    const supervisor = createSupervisor(join(root, 'data'), join(root, 'missing-runtime'), {
      NXCORE_CLI_CONNECTOR_MANAGED: 'false',
      NXCORE_CLI_CONNECTOR_URL: 'http://127.0.0.1:4567/',
      NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN: 'external-runtime-token',
    })

    const connection = await supervisor.start()

    expect(connection).toEqual({
      baseUrl: 'http://127.0.0.1:4567',
      runtimeToken: 'external-runtime-token',
      adminToken: undefined,
      managed: false,
      pid: null,
      version: null,
    })
    expect(supervisor.getStatus()).toMatchObject({ state: 'ready', managed: false, pid: null })
    await expect(access(join(root, 'data', 'managed-runtime.json'), constants.F_OK)).rejects.toThrow()
  })
})
