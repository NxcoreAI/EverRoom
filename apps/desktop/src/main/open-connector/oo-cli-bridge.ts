import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

import type {
  OpenConnectorCommandEvent,
  OpenConnectorCommandRequest,
  OpenConnectorCommandResult,
  OpenConnectorExecutionInput,
  OpenConnectorStatus,
} from '../../shared/open-connector'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export interface OoCliBridgeOptions {
  executable: string
  argumentPrefix?: string[]
  baseUrl: string
  managed?: boolean
  gatewayPid?: number | null
  gatewayVersion?: string | null
  runtimeToken?: string
  configDirectory: string
  dataDirectory: string
  timeoutMs?: number
  environment?: NodeJS.ProcessEnv
}

type CommandListener = (event: OpenConnectorCommandEvent) => void

function requireText(value: string, label: string, maxLength = 200): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}长度必须在 1 到 ${maxLength} 个字符之间。`)
  }
  return normalized
}

function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label, 128)
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(`${label}格式无效。`)
  return normalized
}

function commandArguments(command: OpenConnectorCommandRequest): string[] {
  switch (command.kind) {
    case 'search':
      return ['connector', 'search', '--json', '--', requireText(command.query, '搜索内容')]
    case 'schema': {
      const actionId = requireText(command.actionId, 'Action ID', 257)
      const [service, ...actionParts] = actionId.split('.')
      requireIdentifier(service ?? '', 'Service')
      requireIdentifier(actionParts.join('.'), 'Action')
      return ['connector', 'schema', actionId, ...(command.refresh ? ['--refresh'] : [])]
    }
    case 'run': {
      const service = requireIdentifier(command.service, 'Service')
      const action = requireIdentifier(command.action, 'Action')
      const input = JSON.stringify(command.input)
      if (Buffer.byteLength(input) > 256 * 1024) throw new Error('Action 输入不能超过 256 KiB。')
      return [
        'connector',
        'run',
        service,
        '--action',
        action,
        '--data',
        input,
        ...(command.connectionName
          ? ['--connection-name', requireText(command.connectionName, '连接名称', 128)]
          : []),
        ...(command.dryRun ? ['--dry-run'] : []),
        '--json',
      ]
    }
    case 'apps':
      return [
        'connector',
        'apps',
        ...(command.service ? [requireIdentifier(command.service, 'Service')] : []),
        '--json',
      ]
  }
}

function displayCommand(arguments_: string[]): string {
  const hiddenInput = arguments_.map((argument, index) => (
    arguments_[index - 1] === '--data' ? '<json>' : argument
  ))
  return `oo ${hiddenInput.join(' ')}`
}

function parseJsonOutput(output: string): unknown {
  const normalized = output.trim()
  if (!normalized) return null
  try {
    return JSON.parse(normalized)
  } catch {
    throw new Error('oo CLI 返回了无法解析的 JSON。')
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactText(value: string, secret?: string): string {
  return secret ? value.split(secret).join('<redacted>') : value
}

function redactValue(value: unknown, secret?: string): unknown {
  if (!secret) return value
  if (typeof value === 'string') return redactText(value, secret)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactValue(item, secret),
    ]))
  }
  return value
}

function createStreamRedactor(secret?: string): { push(chunk: string): string; flush(): string } {
  let pending = ''
  return {
    push(chunk) {
      if (!secret) return chunk
      const combined = pending + chunk
      let splitAt = Math.max(0, combined.length - Math.max(0, secret.length - 1))
      const crossingMatch = combined.lastIndexOf(secret, Math.max(0, splitAt - 1))
      if (crossingMatch >= 0 && crossingMatch + secret.length > splitAt) splitAt = crossingMatch
      pending = combined.slice(splitAt)
      return redactText(combined.slice(0, splitAt), secret)
    },
    flush() {
      const output = redactText(pending, secret)
      pending = ''
      return output
    },
  }
}

export class OoCliBridge {
  private readonly listeners = new Set<CommandListener>()
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>()
  private initialized = false

  constructor(private readonly options: OoCliBridgeOptions) {}

  onCommand(listener: CommandListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  environment(): Record<string, string> {
    return {
      OO_CONNECTOR_URL: this.options.baseUrl,
      ...(this.options.runtimeToken ? { OO_CONNECTOR_TOKEN: this.options.runtimeToken } : {}),
      OO_CONFIG_DIR: this.options.configDirectory,
      OO_DATA_DIR: this.options.dataDirectory,
      NXCORE_OO_CLI_PATH: this.options.executable,
      NO_COLOR: '1',
    }
  }

  async status(): Promise<OpenConnectorStatus> {
    await this.initialize()
    const [gateway, cli] = await Promise.all([this.gatewayStatus(), this.cliStatus()])
    return {
      baseUrl: this.options.baseUrl,
      managed: this.options.managed ?? false,
      gatewayPid: this.options.gatewayPid ?? null,
      gatewayVersion: this.options.gatewayVersion ?? null,
      runtimeTokenConfigured: Boolean(this.options.runtimeToken),
      ...gateway,
      ...cli,
    }
  }

  async execute(input: OpenConnectorExecutionInput): Promise<OpenConnectorCommandResult> {
    await this.initialize()
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId)) throw new Error('无效的命令请求标识。')
    if (this.active.has(input.requestId)) throw new Error('该命令正在运行。')
    const arguments_ = commandArguments(input.command)
    return this.run(input.requestId, input.command.kind, arguments_)
  }

  cancel(requestId: string): boolean {
    const child = this.active.get(requestId)
    if (!child) return false
    child.kill('SIGTERM')
    return true
  }

  shutdown(): void {
    for (const child of this.active.values()) child.kill('SIGTERM')
    this.active.clear()
    this.listeners.clear()
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    await Promise.all([
      mkdir(this.options.configDirectory, { recursive: true }),
      mkdir(this.options.dataDirectory, { recursive: true }),
    ])
    this.initialized = true
  }

  private emit(event: OpenConnectorCommandEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private processEnvironment(): NodeJS.ProcessEnv {
    return {
      ...(this.options.environment ?? process.env),
      ...this.environment(),
    }
  }

  private async gatewayStatus(): Promise<Pick<
    OpenConnectorStatus,
    'gatewayState' | 'gatewayMessage'
  >> {
    try {
      const response = await fetch(new URL('/v1/health', this.options.baseUrl), {
        headers: this.options.runtimeToken
          ? { authorization: `Bearer ${this.options.runtimeToken}` }
          : undefined,
        signal: AbortSignal.timeout(2_500),
      })
      if (response.status === 401) {
        return { gatewayState: 'unauthorized', gatewayMessage: 'Runtime Token 未被网关接受。' }
      }
      if (!response.ok) {
        return { gatewayState: 'unreachable', gatewayMessage: `健康检查返回 HTTP ${response.status}。` }
      }
      const payload = await response.json().catch(() => null) as {
        success?: unknown
        data?: { ok?: unknown }
      } | null
      if (payload?.success !== true || payload.data?.ok !== true) {
        return { gatewayState: 'unreachable', gatewayMessage: '目标服务不是兼容的 OpenConnector 网关。' }
      }
      return { gatewayState: 'ready', gatewayMessage: null }
    } catch (error) {
      return { gatewayState: 'unreachable', gatewayMessage: errorText(error) }
    }
  }

  private async cliStatus(): Promise<Pick<
    OpenConnectorStatus,
    'cliState' | 'cliVersion' | 'cliPath' | 'cliMessage'
  >> {
    try {
      const result = await this.runProbe(['version', '--json'], 5_000)
      const payload = parseJsonOutput(result.stdout) as { version?: unknown } | null
      return {
        cliState: 'ready',
        cliVersion: typeof payload?.version === 'string' ? payload.version : null,
        cliPath: this.options.executable,
        cliMessage: null,
      }
    } catch (error) {
      const message = errorText(error)
      return {
        cliState: /ENOENT|not found/i.test(message) ? 'missing' : 'error',
        cliVersion: null,
        cliPath: this.options.executable,
        cliMessage: message,
      }
    }
  }

  private runProbe(arguments_: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, [...(this.options.argumentPrefix ?? []), ...arguments_], {
        env: this.processEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdin.end()
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(
          redactText(stderr.trim(), this.options.runtimeToken)
            || `oo CLI 退出码为 ${String(code)}。`,
        ))
      })
    })
  }

  private run(
    requestId: string,
    kind: OpenConnectorCommandRequest['kind'],
    arguments_: string[],
  ): Promise<OpenConnectorCommandResult> {
    const command = displayCommand(arguments_)
    const startedAt = new Date()
    this.emit({ type: 'started', requestId, kind, command, timestamp: startedAt.toISOString() })

    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, [...(this.options.argumentPrefix ?? []), ...arguments_], {
        env: this.processEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.active.set(requestId, child)
      child.stdin.end()
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      const stdoutRedactor = createStreamRedactor(this.options.runtimeToken)
      const stderrRedactor = createStreamRedactor(this.options.runtimeToken)
      const emitOutput = (stream: 'stdout' | 'stderr', text: string): void => {
        if (text) this.emit({
          type: 'output',
          requestId,
          stream,
          text,
          timestamp: new Date().toISOString(),
        })
      }
      const finish = (error: Error | null, exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.active.delete(requestId)
        emitOutput('stdout', stdoutRedactor.flush())
        emitOutput('stderr', stderrRedactor.flush())
        const finishedAt = new Date()
        const durationMs = finishedAt.getTime() - startedAt.getTime()
        this.emit({
          type: 'finished',
          requestId,
          exitCode,
          durationMs,
          timestamp: finishedAt.toISOString(),
        })
        if (error) {
          reject(error)
          return
        }
        try {
          resolve({
            requestId,
            kind,
            command,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs,
            exitCode,
            data: redactValue(parseJsonOutput(stdout), this.options.runtimeToken),
            stderr: redactText(stderr.trim(), this.options.runtimeToken),
          })
        } catch (parseError) {
          reject(parseError)
        }
      }
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error('oo CLI 执行超时。'), 124)
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
        if (settled) return
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM')
          finish(new Error('oo CLI 输出超过 4 MiB 限制。'), 125)
          return
        }
        if (stream === 'stdout') stdout += chunk
        else stderr += chunk
        emitOutput(
          stream,
          (stream === 'stdout' ? stdoutRedactor : stderrRedactor).push(chunk),
        )
      }
      child.stdout.on('data', (chunk: string) => append('stdout', chunk))
      child.stderr.on('data', (chunk: string) => append('stderr', chunk))
      child.once('error', (error) => finish(error, 127))
      child.once('close', (code, signal) => {
        const exitCode = code ?? (signal ? 130 : 1)
        finish(exitCode === 0 ? null : new Error(
          redactText(stderr.trim(), this.options.runtimeToken)
            || `oo CLI 执行失败（${exitCode}）。`,
        ), exitCode)
      })
    })
  }
}
