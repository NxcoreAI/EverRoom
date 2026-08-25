import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

/**
 * 托管 TencentDB Agent Memory(Knowledge Service / Wiki 引擎)的子进程管理器。
 *
 * 与 MemoryCoreSupervisor 同款三模式:
 * 1. 外部模式:NXCORE_KNOWLEDGE_MANAGED=false / NXCORE_KNOWLEDGE_ENABLED=false
 *    或显式设置了非默认 NXCORE_KNOWLEDGE_BASE_URL —— 不托管。
 * 2. 复用模式:127.0.0.1:8421 已有健康实例 —— 直接复用。
 * 3. 托管模式:从 git 依赖安装的 knowledge-service 包拉起服务,
 *    配置全部走环境变量(PORT/KNOWLEDGE_* / LLM_*),LLM 复用 NXCORE_AI_*。
 *
 * 只负责拉起 KS 进程与探活(docs/room-wiki-plan.md D4):wiki 的创建由
 * gateway 按 Room 懒创建(ensureWikiForRoom),不再引导全局 everroom-wiki。
 */
export interface KnowledgeServiceConnection {
  baseUrl: string
  serviceId: string
  teamId: string
  /** 是否由本进程托管(决定退出时是否需要 kill)。 */
  managed: boolean
}

const PACKAGE_NAME = '@tencentdb-agent-memory/knowledge-service'
const KNOWLEDGE_PORT = 8421
const DEFAULT_BASE_URL = `http://127.0.0.1:${KNOWLEDGE_PORT}`
const SERVICE_ID = 'everroom'
const TEAM_ID = 'everroom'
// 全新数据目录 + 多服务并行冷启动（tsx 编译争抢 IO）时 30s 不够，实测可超一分钟。
const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 5_000
/** 服务默认 32768,常见兼容端点(qwen-turbo 等)上限 16384,取安全缺省。 */
const DEFAULT_LLM_MAX_TOKENS = 16_384

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export interface KnowledgeServiceStartOptions {
  /** runtime config 派生的 LLM_* 覆盖（primary 段三要素）；未传走 .env 透传。 */
  aiEnvironment?: Record<string, string>
}

export class KnowledgeServiceSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: KnowledgeServiceConnection | null = null
  private stopping = false
  private lastError: string | null = null

  constructor(private readonly dataDirectory: string) {}

  async start(options: KnowledgeServiceStartOptions = {}): Promise<KnowledgeServiceConnection | null> {
    if (this.connection) return this.connection

    if (
      process.env.NXCORE_KNOWLEDGE_MANAGED === 'false' ||
      process.env.NXCORE_KNOWLEDGE_ENABLED === 'false'
    ) {
      return null
    }
    const externalBaseUrl = process.env.NXCORE_KNOWLEDGE_BASE_URL?.trim()
    if (externalBaseUrl && externalBaseUrl !== DEFAULT_BASE_URL) return null

    // 复用已在运行的实例(用户手动部署的 Knowledge Service 等)。
    if (await this.probe()) {
      console.info(`[knowledge] reusing existing instance at ${DEFAULT_BASE_URL}`)
      this.connection = {
        baseUrl: DEFAULT_BASE_URL,
        serviceId: SERVICE_ID,
        teamId: TEAM_ID,
        managed: false,
      }
      return this.connection
    }

    const { packageDirectory, tsxEntryUrl } = this.resolvePackage()
    const dataDir = join(this.dataDirectory, 'knowledge')
    await mkdir(dataDir, { recursive: true })

    const command = app.isPackaged ? process.execPath : (process.env.NXCORE_KNOWLEDGE_NODE ?? 'node')
    const serverEntry = join(packageDirectory, 'src', 'server.ts').replace(/\\/g, '/')
    const child = spawn(
      command,
      ['--import', tsxEntryUrl, serverEntry],
      {
        cwd: dataDir,
        env: {
          ...process.env,
          PORT: String(KNOWLEDGE_PORT),
          API_PREFIX: '/v3',
          KNOWLEDGE_DATA_DIR: dataDir,
          KNOWLEDGE_DB_PATH: join(dataDir, 'knowledge.db'),
          KNOWLEDGE_PUBLIC_BASE_URL: `${DEFAULT_BASE_URL}/v3`,
          // 服务默认 debug;托管实例跟随桌面日志级别。
          LOG_LEVEL: process.env.NXCORE_KNOWLEDGE_LOG_LEVEL?.trim() ?? 'info',
          ...this.llmEnvironment(),
          ...(options.aiEnvironment ?? {}),
          ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    this.stopping = false
    child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => process.stdout.write(`[knowledge] ${chunk}`))
    child.stderr.on('data', (chunk: string) => process.stderr.write(`[knowledge] ${chunk}`))
    child.on('exit', (code, signal) => {
      this.child = null
      if (!this.stopping) {
        this.lastError = `Knowledge service 进程已退出（code=${String(code)}, signal=${String(signal)}）`
        console.error(this.lastError)
      }
    })

    try {
      await this.waitUntilReady(child)
      console.info(`[knowledge] managed instance ready at ${DEFAULT_BASE_URL} (pid=${child.pid})`)
      this.connection = {
        baseUrl: DEFAULT_BASE_URL,
        serviceId: SERVICE_ID,
        teamId: TEAM_ID,
        managed: true,
      }
      return this.connection
    } catch (error) {
      this.killChild(child, 'SIGTERM')
      this.child = null
      this.lastError = error instanceof Error ? error.message : 'Knowledge service 启动失败'
      throw error
    }
  }

  getConnection(): KnowledgeServiceConnection | null {
    return this.connection
  }

  /** runtime config 变更后带新 LLM env 重启托管实例；复用/外部实例原样返回。 */
  async restart(aiEnvironment: Record<string, string> | null): Promise<KnowledgeServiceConnection | null> {
    const connection = this.connection
    if (!connection?.managed) return connection
    await this.shutdown()
    return this.start({ aiEnvironment: aiEnvironment ?? undefined })
  }

  getLastError(): string | null {
    return this.lastError
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
    this.lastError = null
  }

  /** 把桌面的 NXCORE_AI_* 映射为 Knowledge Service 使用的 LLM_*(注意与 MemoryCore 的 TDAI_LLM_* 不同名)。 */
  private llmEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {
      // 脱离 Panel 直连 LLM 端点;回调默认即空,不通知 TMC。
      LLM_MODE: 'custom',
    }
    const baseUrl = process.env.NXCORE_AI_BASE_URL?.trim()
    const apiKey = process.env.NXCORE_AI_API_KEY?.trim()
    const model = process.env.NXCORE_AI_MODEL?.trim()
    if (baseUrl) environment.LLM_BASE_URL = baseUrl
    if (apiKey) environment.LLM_API_KEY = apiKey
    if (model) environment.LLM_MODEL = model
    if (process.env.NXCORE_AI_API === 'anthropic-messages') environment.LLM_PROTOCOL = 'anthropic'
    // 服务默认 32768 会被部分兼容端点拒绝(qwen-turbo 上限 16384),夹取到安全区间。
    const raw = Number(process.env.NXCORE_KNOWLEDGE_LLM_MAX_TOKENS)
    const preferred = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_MAX_TOKENS
    environment.LLM_MAX_TOKENS = String(Math.min(Math.max(preferred, 1_024), 65_536))
    return environment
  }

  private async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${DEFAULT_BASE_URL}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Knowledge service exited during startup with code ${String(child.exitCode)}${this.lastError ? `: ${this.lastError}` : ''}`,
        )
      }
      if (await this.probe()) return
      await delay(100)
    }
    throw new Error(`Knowledge service did not become ready within ${STARTUP_TIMEOUT_MS}ms`)
  }

  private resolvePackage(): { packageDirectory: string; tsxEntryUrl: string } {
    const override = process.env.NXCORE_KNOWLEDGE_SERVICE_DIR?.trim()
    const manifestPath = override
      ? join(override, 'package.json')
      : createRequire(join(app.getAppPath(), 'package.json')).resolve(`${PACKAGE_NAME}/package.json`)
    const packageRequire = createRequire(manifestPath)
    return {
      packageDirectory: dirname(manifestPath),
      tsxEntryUrl: pathToFileURL(packageRequire.resolve('tsx')).href,
    }
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}
