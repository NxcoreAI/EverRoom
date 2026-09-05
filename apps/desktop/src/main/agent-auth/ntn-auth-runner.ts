import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * 主进程 ntn（Notion 官方 CLI）授权运行器。两步登录流（面向 Agent 设计）：
 * `ntn login --no-browser` 输出 verification URL + 校验码后退出，
 * `ntn login poll` 长驻等待浏览器确认完成。token 由 ntn 自己存 OS 钥匙串，
 * 不经过 IPC / Gateway。
 */

const PROBE_TIMEOUT_MS = 10_000
const WHOAMI_TIMEOUT_MS = 20_000
const LOGIN_NO_BROWSER_TIMEOUT_MS = 30_000
const LOGIN_POLL_TIMEOUT_MS = 15 * 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

interface RunOptions {
  timeoutMs: number
}

interface RunOutcome {
  code: number | null
  stdout: string
  stderr: string
}

export interface NtnLoginStartResult {
  verificationUrl: string | null
  verificationCode: string | null
}

export interface NtnWhoamiResult {
  authenticated: boolean
  userName: string | null
  raw: Record<string, unknown>
}

export class NtnAuthRunner {
  private readonly active = new Map<string, ChildProcess>()

  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  gatewayEnvironment(): Record<string, string> {
    return { NXCORE_NTN_CLI_PATH: this.executable }
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

  /** `ntn whoami --json`：未登录时报 "Run `ntn login` first"。 */
  async whoami(): Promise<NtnWhoamiResult> {
    const outcome = await this.run(['whoami', '--json'], { timeoutMs: WHOAMI_TIMEOUT_MS })
    const combined = `${outcome.stdout}\n${outcome.stderr}`
    if (/ntn login first|No workspace selected|not logged in/i.test(combined)) {
      return { authenticated: false, userName: null, raw: {} }
    }
    if (outcome.code !== 0) {
      throw new Error(outcome.stderr.trim().split('\n')[0] || `ntn whoami 退出码 ${String(outcome.code)}`)
    }
    const raw = this.parseJson(outcome.stdout) ?? {}
    const user = raw.user && typeof raw.user === 'object' ? raw.user as Record<string, unknown> : {}
    const name = raw.name ?? user.name
    return { authenticated: true, userName: typeof name === 'string' ? name : null, raw }
  }

  /** 第一步：`ntn login --no-browser` 打印 URL + 校验码后退出。 */
  async loginNoBrowser(): Promise<NtnLoginStartResult> {
    const outcome = await this.run(['login', '--no-browser'], { timeoutMs: LOGIN_NO_BROWSER_TIMEOUT_MS })
    const combined = `${outcome.stdout}\n${outcome.stderr}`
    const verificationUrl = /https:\/\/[^\s"'<>]+/.exec(combined)?.[0] ?? null
    const verificationCode = /\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/.exec(combined)?.[1] ?? null
    if (!verificationUrl) {
      throw new Error(`ntn login --no-browser 未返回授权链接：${combined.trim().slice(0, 300)}`)
    }
    return { verificationUrl, verificationCode }
  }

  /** 第二步：`ntn login poll` 长驻等待浏览器确认，完成即退出。 */
  loginPoll(requestId: string): Promise<RunOutcome> {
    return this.run(['login', 'poll'], { timeoutMs: LOGIN_POLL_TIMEOUT_MS }, requestId)
  }

  newRequestId(prefix: string): string {
    return `${prefix}-${randomUUID()}`
  }

  private run(
    arguments_: string[],
    options: RunOptions,
    requestId = `ntn-${randomUUID()}`,
  ): Promise<RunOutcome> {
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
      const finish = (error?: Error, outcome?: RunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.active.delete(requestId)
        if (error) reject(error)
        else resolve(outcome!)
      }
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error('ntn 命令超时'))
      }, options.timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM')
          finish(new Error('ntn 输出超过上限'))
          return
        }
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        stderr += chunk
      })
      child.once('error', (error) => finish(error))
      child.once('close', (code) => finish(undefined, { code, stdout, stderr }))
    })
  }

  private parseJson(value: string): Record<string, unknown> | null {
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
}
