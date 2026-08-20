import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { app, session } from 'electron'

const DEFAULT_PORT = 3000
const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 5_000

interface ManagedSecrets {
  version: 1
  encryptionKey: string
  adminToken: string
  runtimeToken: string
  port: number
}

export interface OpenConnectorConnection {
  baseUrl: string
  runtimeToken?: string
  adminToken?: string
  managed: boolean
  pid: number | null
  version: string | null
}

export interface OpenConnectorSupervisorStatus {
  state: 'starting' | 'ready' | 'stopped' | 'error'
  baseUrl: string | null
  managed: boolean
  pid: number | null
  version: string | null
  message: string | null
}

export interface OpenConnectorSupervisorOptions {
  command?: string
  environment?: NodeJS.ProcessEnv
  packaged?: boolean
  proxyResolver?: (url: string) => Promise<string>
  runtimeDirectory?: string
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isManagedSecrets(value: unknown): value is ManagedSecrets {
  if (!value || typeof value !== 'object') return false
  const secrets = value as Partial<ManagedSecrets>
  return secrets.version === 1
    && typeof secrets.encryptionKey === 'string'
    && secrets.encryptionKey.length >= 32
    && typeof secrets.adminToken === 'string'
    && secrets.adminToken.length >= 32
    && typeof secrets.runtimeToken === 'string'
    && secrets.runtimeToken.length >= 32
    && Number.isInteger(secrets.port)
    && Number(secrets.port) > 0
    && Number(secrets.port) <= 65_535
}

function normalizedBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('NXCORE_CLI_CONNECTOR_URL 必须是有效的 HTTP(S) 地址。')
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('EverRoom 连接器外部地址必须使用 HTTPS；HTTP 仅允许回环地址。')
  }
  return url.toString().replace(/\/$/, '')
}

function proxyUrlFromRules(rules: string): string | null {
  for (const rule of rules.split(';')) {
    const match = /^\s*(PROXY|HTTP|HTTPS)\s+([^\s]+)\s*$/i.exec(rule)
    if (!match) continue
    const protocol = match[1]?.toUpperCase() === 'HTTPS' ? 'https' : 'http'
    try {
      const url = new URL(`${protocol}://${match[2]}`)
      if (!url.hostname || !url.port) continue
      return url.toString().replace(/\/$/, '')
    } catch {
      // Try the next proxy rule.
    }
  }
  return null
}

function noProxyWithLoopback(value?: string): string {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  const normalized = new Set(entries.map((entry) => entry.toLowerCase()))
  for (const loopback of ['127.0.0.1', 'localhost', '::1']) {
    if (!normalized.has(loopback)) entries.push(loopback)
  }
  return entries.join(',')
}

function nodeOptionsWithEnvProxyWarningDisabled(value?: string): string {
  const option = '--disable-warning=UNDICI-EHPA'
  if (value?.includes(option)) return value
  return [value?.trim(), option].filter(Boolean).join(' ')
}

function forwardOutput(stream: NodeJS.ReadableStream, destination: NodeJS.WriteStream): void {
  let pending = ''
  stream.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) destination.write(`[open-connector] ${line}\n`)
  })
  stream.on('end', () => {
    if (pending) destination.write(`[open-connector] ${pending}\n`)
  })
}

export class OpenConnectorSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: OpenConnectorConnection | null = null
  private starting = false
  private stopping = false
  private lastError: string | null = null

  constructor(
    private readonly dataDirectory: string,
    private readonly options: OpenConnectorSupervisorOptions = {},
  ) {}

  async start(): Promise<OpenConnectorConnection> {
    if (this.connection) return this.connection
    if (this.starting || this.child) throw new Error('EverRoom 连接器正在启动。')
    this.starting = true
    this.lastError = null

    try {
      if (this.environment().NXCORE_CLI_CONNECTOR_MANAGED === 'false') {
        const baseUrl = normalizedBaseUrl(
          this.environment().NXCORE_CLI_CONNECTOR_URL?.trim() || 'http://127.0.0.1:3000',
        )
        this.connection = {
          baseUrl,
          runtimeToken: this.configuredRuntimeToken(),
          adminToken: this.environment().NXCORE_CLI_CONNECTOR_ADMIN_TOKEN?.trim() || undefined,
          managed: false,
          pid: null,
          version: null,
        }
        return this.connection
      }

      const runtimeDirectory = this.resolveRuntimeDirectory()
      const manifest = JSON.parse(await readFile(join(runtimeDirectory, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      const version = typeof manifest.version === 'string' ? manifest.version : null
      const secrets = await this.loadOrCreateSecrets()
      const runtimeDataDirectory = join(this.dataDirectory, 'runtime-data')
      await mkdir(runtimeDataDirectory, { recursive: true, mode: 0o700 })
      await chmod(runtimeDataDirectory, 0o700).catch(() => undefined)
      const port = await this.resolvePort(secrets.port, secrets.runtimeToken)
      if (port !== secrets.port) {
        secrets.port = port
        await this.writeSecrets(secrets)
      }
      const baseUrl = `http://127.0.0.1:${port}`
      const publicOrigin = `http://localhost:${port}`

      const existing = await this.probe(baseUrl, secrets.runtimeToken)
      if (existing) {
        this.connection = {
          baseUrl,
          runtimeToken: secrets.runtimeToken,
          adminToken: secrets.adminToken,
          managed: true,
          pid: null,
          version,
        }
        console.info(`[open-connector] reusing EverRoom runtime at ${baseUrl}`)
        return this.connection
      }

      const packaged = this.options.packaged ?? app.isPackaged
      const command = this.options.command
        ?? (packaged ? process.execPath : (this.environment().NXCORE_CLI_CONNECTOR_NODE?.trim() || 'node'))
      const proxyEnvironment = await this.resolveProxyEnvironment()
      const child = spawn(command, [join(runtimeDirectory, 'src', 'server', 'index.ts')], {
        cwd: runtimeDirectory,
        env: {
          ...this.environment(),
          ...proxyEnvironment,
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(port),
          OOMOL_CONNECT_ORIGIN: publicOrigin,
          OOMOL_CONNECT_DATA_DIR: runtimeDataDirectory,
          OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryptionKey,
          OOMOL_CONNECT_ADMIN_TOKEN: secrets.adminToken,
          OOMOL_CONNECT_RUNTIME_TOKEN: secrets.runtimeToken,
          OOMOL_CONNECT_LOG_LEVEL: this.environment().OOMOL_CONNECT_LOG_LEVEL?.trim() || 'info',
          ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      this.stopping = false
      child.stdin.end()
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      forwardOutput(child.stdout, process.stdout)
      forwardOutput(child.stderr, process.stderr)
      child.on('exit', (code, signal) => {
        this.child = null
        this.connection = null
        if (!this.stopping) {
          this.lastError = `EverRoom 连接器进程已退出（code=${String(code)}, signal=${String(signal)}）`
          console.error(this.lastError)
        }
      })

      await this.waitUntilReady(child, baseUrl, secrets.runtimeToken)
      this.connection = {
        baseUrl,
        runtimeToken: secrets.runtimeToken,
        adminToken: secrets.adminToken,
        managed: true,
        pid: child.pid ?? null,
        version,
      }
      console.info(`[open-connector] managed runtime ready at ${baseUrl} (pid=${String(child.pid)})`)
      return this.connection
    } catch (error) {
      const child = this.child
      if (child) this.killChild(child, 'SIGTERM')
      this.child = null
      this.connection = null
      this.lastError = error instanceof Error ? error.message : 'EverRoom 连接器启动失败'
      throw error
    } finally {
      this.starting = false
    }
  }

  getConnection(): OpenConnectorConnection | null {
    return this.connection
  }

  getStatus(): OpenConnectorSupervisorStatus {
    const connection = this.connection
    if (connection) {
      return {
        state: 'ready',
        baseUrl: connection.baseUrl,
        managed: connection.managed,
        pid: connection.pid,
        version: connection.version,
        message: null,
      }
    }
    return {
      state: this.starting || this.child ? 'starting' : this.lastError ? 'error' : 'stopped',
      baseUrl: null,
      managed: this.environment().NXCORE_CLI_CONNECTOR_MANAGED !== 'false',
      pid: null,
      version: null,
      message: this.lastError,
    }
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
        this.killChild(child, 'SIGKILL')
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
      child.once('exit', finish)
      if (!this.killChild(child, 'SIGTERM')) finish()
    })
    this.child = null
    this.stopping = false
  }

  private environment(): NodeJS.ProcessEnv {
    return this.options.environment ?? process.env
  }

  private configuredRuntimeToken(): string | undefined {
    return this.environment().NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN?.trim()
      || this.environment().OOMOL_CONNECT_RUNTIME_TOKEN?.trim()
      || undefined
  }

  private async resolveProxyEnvironment(): Promise<NodeJS.ProcessEnv> {
    const environment = this.environment()
    const explicitHttpProxy = environment.HTTP_PROXY ?? environment.http_proxy
    const explicitHttpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy
    const explicitAllProxy = environment.ALL_PROXY ?? environment.all_proxy
    const common = {
      NODE_USE_ENV_PROXY: environment.NODE_USE_ENV_PROXY?.trim() || '1',
      NODE_OPTIONS: nodeOptionsWithEnvProxyWarningDisabled(environment.NODE_OPTIONS),
      NO_PROXY: noProxyWithLoopback(environment.NO_PROXY ?? environment.no_proxy),
    }
    if (explicitHttpProxy?.trim() || explicitHttpsProxy?.trim() || explicitAllProxy?.trim()) {
      const fallbackProxy = explicitHttpsProxy?.trim() || explicitHttpProxy?.trim()
      return {
        ...common,
        ...(fallbackProxy ? {
          HTTP_PROXY: explicitHttpProxy?.trim() || fallbackProxy,
          HTTPS_PROXY: explicitHttpsProxy?.trim() || fallbackProxy,
        } : {}),
      }
    }

    try {
      const resolveProxy = this.options.proxyResolver
        ?? ((url: string) => session.defaultSession.resolveProxy(url))
      const proxyUrl = proxyUrlFromRules(await resolveProxy('https://oauth2.googleapis.com'))
      if (!proxyUrl) return {}
      console.info('[open-connector] using the desktop system proxy for provider requests')
      return {
        ...common,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
      }
    } catch {
      return {}
    }
  }

  private resolveRuntimeDirectory(): string {
    const configured = this.options.runtimeDirectory
      ?? this.environment().NXCORE_CLI_CONNECTOR_RUNTIME_DIR?.trim()
    const packaged = this.options.packaged ?? app.isPackaged
    const candidates = [
      configured,
      packaged ? join(process.resourcesPath, 'open-connector') : undefined,
      join(app.getAppPath(), 'build', 'open-connector'),
    ].filter((candidate): candidate is string => Boolean(candidate))
    const directory = candidates.find((candidate) => (
      existsSync(join(candidate, 'src', 'server', 'index.ts'))
      && existsSync(join(candidate, 'catalog', 'apps'))
      && existsSync(join(candidate, 'dist', 'web', 'index.html'))
    ))
    if (!directory) {
      throw new Error(`EverRoom 连接器运行时未准备。已检查：${candidates.join(', ')}`)
    }
    return directory
  }

  private async loadOrCreateSecrets(): Promise<ManagedSecrets> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.dataDirectory, 0o700).catch(() => undefined)
    try {
      const parsed: unknown = JSON.parse(await readFile(this.secretsPath(), 'utf8'))
      if (isManagedSecrets(parsed)) return parsed
    } catch {
      // Generate a fresh settings file below.
    }
    const configuredPort = Number(this.environment().NXCORE_CLI_CONNECTOR_PORT ?? DEFAULT_PORT)
    const secrets: ManagedSecrets = {
      version: 1,
      encryptionKey: randomBytes(32).toString('base64url'),
      adminToken: randomBytes(32).toString('base64url'),
      runtimeToken: this.configuredRuntimeToken() ?? randomBytes(32).toString('base64url'),
      port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
        ? configuredPort
        : DEFAULT_PORT,
    }
    await this.writeSecrets(secrets)
    return secrets
  }

  private async writeSecrets(secrets: ManagedSecrets): Promise<void> {
    const temporaryPath = `${this.secretsPath()}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryPath, this.secretsPath())
    await chmod(this.secretsPath(), 0o600).catch(() => undefined)
  }

  private secretsPath(): string {
    return join(this.dataDirectory, 'managed-runtime.json')
  }

  private async resolvePort(preferredPort: number, runtimeToken: string): Promise<number> {
    if (await this.probe(`http://127.0.0.1:${preferredPort}`, runtimeToken)) return preferredPort
    if (await this.portAvailable(preferredPort)) return preferredPort
    return this.availablePort()
  }

  private portAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()
      server.unref()
      server.once('error', () => resolve(false))
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close(() => resolve(true))
      })
    })
  }

  private availablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.unref()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('无法分配 EverRoom 连接器本地端口。'))
          return
        }
        server.close((error) => error ? reject(error) : resolve(address.port))
      })
    })
  }

  private async probe(baseUrl: string, runtimeToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${runtimeToken}` },
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) return false
      const payload = await response.json() as { success?: unknown; data?: { ok?: unknown } }
      return payload.success === true && payload.data?.ok === true
    } catch {
      return false
    }
  }

  private async waitUntilReady(
    child: ChildProcessWithoutNullStreams,
    baseUrl: string,
    runtimeToken: string,
  ): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`EverRoom 连接器启动期间退出（code=${String(child.exitCode)}）。`)
      }
      if (await this.probe(baseUrl, runtimeToken)) return
      await delay(100)
    }
    throw new Error(`EverRoom 连接器未能在 ${STARTUP_TIMEOUT_MS}ms 内就绪。`)
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}
