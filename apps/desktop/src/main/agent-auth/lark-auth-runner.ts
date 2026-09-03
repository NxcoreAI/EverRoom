import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * 主进程 lark-cli 授权运行器。只负责授权相关命令（--version / auth status /
 * config init --new / auth login --no-wait / auth login --device-code），导出
 * 写入由网关侧执行。device code 只留在本模块与 CLI 之间，不进入渲染层。
 */

const PROBE_TIMEOUT_MS = 10_000
const AUTH_STATUS_TIMEOUT_MS = 20_000
const NO_WAIT_TIMEOUT_MS = 30_000
const DEVICE_POLL_TIMEOUT_MS = 15 * 60_000
const CONFIG_INIT_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export interface LarkRunOutcome {
  code: number | null
  stdout: string
  stderr: string
}

export interface LarkLoginNoWaitResult {
  verificationUrl: string | null
  deviceCode: string | null
  raw: Record<string, unknown>
}

export interface LarkAuthStatusPayload {
  appConfigured: boolean
  userAuthorized: boolean | null
  userName: string | null
  tokenStatus: string | null
  raw: Record<string, unknown>
}

interface RunOptions {
  timeoutMs: number
  onOutput?: (chunk: string) => void
}

export class LarkAuthRunner {
  private readonly active = new Map<string, ChildProcess>()

  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  gatewayEnvironment(): Record<string, string> {
    return { NXCORE_LARK_CLI_PATH: this.executable }
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
  }

  /** 探测可执行文件是否可用；返回 null 表示不可用。 */
  version(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(this.executable, ['--version'], {
        env: { ...this.environment, NO_COLOR: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let stdout = ''
      const timeout = setTimeout(() => child.kill('SIGTERM'), PROBE_TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.once('error', () => {
        clearTimeout(timeout)
        resolve(null)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        resolve(code === 0 ? stdout.trim() || 'ok' : null)
      })
    })
  }

  async authStatus(): Promise<LarkAuthStatusPayload> {
    const outcome = await this.run(['auth', 'status', '--json'], { timeoutMs: AUTH_STATUS_TIMEOUT_MS })
    if (outcome.code !== 0) {
      throw new Error(outcome.stderr.trim() || `lark-cli auth status 退出码 ${String(outcome.code)}`)
    }
    const raw = parseJsonObject(outcome.stdout) ?? {}
    const appId = typeof raw.appId === 'string' && raw.appId.trim() ? raw.appId.trim() : null
    const identities = raw.identities && typeof raw.identities === 'object'
      ? raw.identities as Record<string, unknown>
      : {}
    const user = identities.user && typeof identities.user === 'object'
      ? identities.user as Record<string, unknown>
      : {}
    return {
      appConfigured: appId !== null,
      userAuthorized: user.available === true ? user.tokenStatus !== 'invalid' : false,
      userName: typeof user.userName === 'string' ? user.userName : null,
      tokenStatus: typeof user.tokenStatus === 'string' ? user.tokenStatus : null,
      raw,
    }
  }

  /**
   * `lark-cli config init --new`：阻塞直到用户在浏览器完成应用创建。
   * 输出中的 URL 实时回调（步骤卡片展示链接/二维码）。
   */
  configInitNew(
    requestId: string,
    onOutput: (chunk: string) => void,
  ): Promise<LarkRunOutcome> {
    return this.run(['config', 'init', '--new', '--lang', 'zh'], {
      timeoutMs: CONFIG_INIT_TIMEOUT_MS,
      onOutput,
    }, requestId)
  }

  /**
   * 发起设备授权并立即返回 verification URL + device code（不阻塞）。
   * 不带 scope/domain 时 lark-cli 会报 validation 错，导出默认申请 docs+drive 域。
   */
  async authLoginNoWait(
    requestId: string,
    scopeArgs?: string[],
  ): Promise<LarkLoginNoWaitResult> {
    const args = ['auth', 'login', '--json', '--no-wait', ...(scopeArgs ?? ['--domain', 'docs,drive'])]
    const outcome = await this.run(args, { timeoutMs: NO_WAIT_TIMEOUT_MS }, requestId)
    const raw = parseJsonObject(outcome.stdout) ?? parseJsonObject(outcome.stderr) ?? {}
    const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {}
    const verificationUrl = pickString(data, ['verificationUrl', 'verification_url', 'url', 'authorizeUrl', 'authorize_url'])
      ?? pickString(raw, ['verificationUrl', 'verification_url', 'url', 'authorizeUrl', 'authorize_url'])
    const deviceCode = pickString(data, ['deviceCode', 'device_code', 'deviceCodeToken', 'userCode'])
      ?? pickString(raw, ['deviceCode', 'device_code', 'userCode'])
    if (!deviceCode) {
      throw new Error(
        `lark-cli auth login --no-wait 未返回 device code：${outcome.stderr.trim() || outcome.stdout.trim().slice(0, 400)}`,
      )
    }
    return { verificationUrl, deviceCode, raw }
  }

  /** 用 device code 阻塞轮询直到用户完成授权（或超时/取消）。 */
  authLoginPoll(requestId: string, deviceCode: string): Promise<LarkRunOutcome> {
    return this.run(['auth', 'login', '--json', '--device-code', deviceCode], {
      timeoutMs: DEVICE_POLL_TIMEOUT_MS,
    }, requestId)
  }

  newRequestId(prefix: string): string {
    return `${prefix}-${randomUUID()}`
  }

  private run(
    arguments_: string[],
    options: RunOptions,
    requestId = `lark-${randomUUID()}`,
  ): Promise<LarkRunOutcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, arguments_, {
        env: { ...this.environment, NO_COLOR: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.active.set(requestId, child)
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let settled = false
      const finish = (error?: Error, outcome?: LarkRunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.active.delete(requestId)
        if (error) reject(error)
        else resolve(outcome!)
      }
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error('lark-cli 命令超时'))
      }, options.timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM')
          finish(new Error('lark-cli 输出超过上限'))
          return
        }
        stdout += chunk
        options.onOutput?.(chunk)
      })
      child.stderr?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM')
          finish(new Error('lark-cli 输出超过上限'))
          return
        }
        stderr += chunk
        options.onOutput?.(chunk)
      })
      child.once('error', (error) => finish(error))
      child.once('close', (code) => finish(undefined, { code, stdout, stderr }))
    })
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const normalized = value.trim()
  if (!normalized) return null
  try {
    const parsed = JSON.parse(normalized) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 从 CLI 流式输出中提取第一个 http(s) URL（config init 的浏览器引导链接）。 */
export function extractVerificationUrl(chunk: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+/.exec(chunk)
  return match?.[0] ?? null
}
