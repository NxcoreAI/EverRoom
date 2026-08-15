import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'
import type { GatewayStatus } from '../../shared/sources'
import { createLoggedHttpClient } from '../network/http-client'

interface GatewayManifest {
  pid: number
  baseUrl: string
  token: string
  startedAt: string
  version: string
}

export interface GatewayConnection {
  pid: number
  baseUrl: string
  token: string
  version: string
}

const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const healthHttp = createLoggedHttpClient('gateway-health', { timeout: 1_000 })

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function forwardGatewayOutput(
  stream: NodeJS.ReadableStream,
  destination: NodeJS.WriteStream,
): void {
  let pending = ''
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) destination.write(`[gateway] ${line}\n`)
  })
  stream.on('end', () => {
    if (pending) destination.write(`[gateway] ${pending}\n`)
  })
}

function isGatewayManifest(value: unknown): value is GatewayManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<GatewayManifest>
  return (
    Number.isInteger(manifest.pid) &&
    typeof manifest.baseUrl === 'string' &&
    typeof manifest.token === 'string' &&
    typeof manifest.startedAt === 'string' &&
    typeof manifest.version === 'string'
  )
}

function resolveGatewayPackageDirectory(): string {
  const candidates = [
    join(app.getAppPath(), '..', 'gateway'),
    join(process.cwd(), 'apps', 'gateway'),
  ]
  const directory = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
  if (!directory) {
    throw new Error(`NxCore Gateway package not found. Checked: ${candidates.join(', ')}`)
  }
  return directory
}

export class GatewaySupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: GatewayConnection | null = null
  private stopping = false
  private lastError: string | null = null

  constructor(
    private readonly dataDirectory: string,
    /** 注入 gateway 子进程的额外环境变量(如托管 MemoryCore 的连接信息)。 */
    private readonly extraEnvironment: Record<string, string> = {},
  ) {}

  async start(): Promise<GatewayConnection> {
    if (this.connection) return this.connection
    if (this.child) throw new Error('NxCore Gateway is already starting')
    this.lastError = null

    const gatewayDirectory = app.isPackaged
      ? join(process.resourcesPath, 'gateway')
      : resolveGatewayPackageDirectory()
    const migrationsPath = join(gatewayDirectory, 'drizzle')
    const manifestPath = this.runtimeManifestPath()
    const token = randomBytes(32).toString('base64url')
    await rm(manifestPath, { force: true })

    const command = app.isPackaged
      ? process.execPath
      : (process.env.NXCORE_GATEWAY_PACKAGE_MANAGER ?? 'pnpm')
    const environment = {
      ...process.env,
      NXCORE_GATEWAY_TOKEN: token,
      ...this.extraEnvironment,
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    const gatewayArguments = [
      '--host',
      '127.0.0.1',
      '--port',
      app.isPackaged ? '0' : (process.env.NXCORE_GATEWAY_DEV_PORT ?? '0'),
      '--data-dir',
      this.dataDirectory,
      '--migrations-dir',
      migrationsPath,
    ]
    const commandArguments = app.isPackaged
      ? [join(gatewayDirectory, 'serve.js'), ...gatewayArguments]
      : ['--dir', gatewayDirectory, 'dev', '--', ...gatewayArguments]
    const detached = !app.isPackaged && process.platform !== 'win32'
    const child = spawn(
      command,
      commandArguments,
      {
        detached,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: !app.isPackaged && process.platform === 'win32',
      },
    )
    this.child = child
    this.stopping = false
    child.stdin.end()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    forwardGatewayOutput(child.stdout, process.stdout)
    forwardGatewayOutput(child.stderr, process.stderr)
    child.on('exit', (code, signal) => {
      this.child = null
      this.connection = null
      if (!this.stopping) {
        this.lastError = `Gateway 进程已退出（code=${String(code)}, signal=${String(signal)}）`
        console.error(this.lastError)
      }
    })

    try {
      const manifest = await this.waitUntilReady(child, manifestPath, token)
      this.connection = {
        pid: manifest.pid,
        baseUrl: manifest.baseUrl,
        token,
        version: manifest.version,
      }
      return this.connection
    } catch (error) {
      this.killChild(child, 'SIGTERM', detached)
      this.child = null
      this.lastError = error instanceof Error ? error.message : 'Gateway 启动失败'
      throw error
    }
  }

  async getStatus(): Promise<GatewayStatus> {
    const connection = this.connection
    if (!connection) {
      return {
        state: this.child ? 'starting' : this.lastError ? 'error' : 'stopped',
        pid: null,
        baseUrl: null,
        version: null,
        message: this.lastError,
      }
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(this.runtimeManifestPath(), 'utf8'))
      if (!isGatewayManifest(parsed) || parsed.token !== connection.token) {
        throw new Error('Gateway runtime manifest 无效')
      }
      const response = await healthHttp.get(`${parsed.baseUrl}/v1/health/ready`, {
        validateStatus: () => true,
      })
      if (response.status >= 400) throw new Error(`Gateway 健康检查失败（${response.status}）`)

      this.connection = {
        pid: parsed.pid,
        baseUrl: parsed.baseUrl,
        token: connection.token,
        version: parsed.version,
      }
      return {
        state: 'ready',
        pid: parsed.pid,
        baseUrl: parsed.baseUrl,
        version: parsed.version,
        message: null,
      }
    } catch (error) {
      return {
        state: 'error',
        pid: connection.pid,
        baseUrl: connection.baseUrl,
        version: connection.version,
        message: error instanceof Error ? error.message : 'Gateway 当前不可用',
      }
    }
  }

  getConnection(): GatewayConnection {
    if (!this.connection) throw new Error('NxCore Gateway 尚未就绪。')
    return this.connection
  }

  async shutdown(): Promise<void> {
    const child = this.child
    this.connection = null
    if (!child) return

    this.stopping = true
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        this.killChild(child, 'SIGKILL', !app.isPackaged && process.platform !== 'win32')
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
      child.once('exit', finish)
      if (!this.killChild(child, 'SIGTERM', !app.isPackaged && process.platform !== 'win32')) {
        finish()
      }
    })
    this.child = null
    this.lastError = null
    await rm(this.runtimeManifestPath(), { force: true })
  }

  private async waitUntilReady(
    child: ChildProcessWithoutNullStreams,
    manifestPath: string,
    token: string,
  ): Promise<GatewayManifest> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`NxCore Gateway exited during startup with code ${String(child.exitCode)}`)
      }

      try {
        const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
        if (isGatewayManifest(parsed) && parsed.token === token) {
          const response = await healthHttp.get(`${parsed.baseUrl}/v1/health/ready`, {
            validateStatus: () => true,
          })
          if (response.status < 400) return parsed
        }
      } catch {
        // The manifest and listener become available at slightly different times.
      }
      await delay(50)
    }

    throw new Error(`NxCore Gateway did not become ready within ${STARTUP_TIMEOUT_MS}ms`)
  }

  private runtimeManifestPath(): string {
    return join(this.dataDirectory, 'runtime', 'gateway.json')
  }

  private killChild(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
    processGroup: boolean,
  ): boolean {
    if (processGroup && child.pid) {
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        return false
      }
    }
    return child.kill(signal)
  }
}
