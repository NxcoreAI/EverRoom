import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app } from 'electron'

/**
 * 托管 TencentDB Agent Memory(MemoryCore)HTTP gateway 的子进程管理器。
 *
 * 三种工作模式(按优先级):
 * 1. 外部模式:用户显式设置了 NXCORE_MEMORY_BASE_URL(非默认值)或
 *    NXCORE_MEMORY_MANAGED=false / NXCORE_MEMORY_ENABLED=false —— 不托管,gateway
 *    直接沿用桌面进程继承到的用户配置。
 * 2. 复用模式:默认端口 127.0.0.1:8420 已有健康实例(比如用户手动部署的
 *    MemoryCore)—— 直接复用,不再拉起进程。
 * 3. 托管模式:从 git 依赖安装的 memory-core 包拉起 standalone gateway,
 *    配置全部走 TDAI_* 环境变量,LLM 复用桌面进程的 NXCORE_AI_*。
 *    数据落 <userData>/memory(TDAI_DATA_DIR,与 KS 的 knowledge/ 同款约定)。
 */
export interface MemoryCoreConnection {
  baseUrl: string
  apiKey: string
  /** 是否由本进程托管(决定退出时是否需要 kill)。 */
  managed: boolean
}

export interface MemoryCoreStartOptions {
  /** 重启时复用的 apiKey(不传则随机生成)。 */
  apiKey?: string
  /**
   * AI 覆盖环境变量(TDAI_LLM_* + TDAI_EMBEDDING_*),在 ...process.env 与
   * llmEnvironment 之后展开,覆盖 .env 透传值;null/undefined = 不覆盖(沿用进程 env)。
   */
  aiEnvironment?: Record<string, string> | null
}

const PACKAGE_NAME = '@tencentdb-agent-memory/memory-tencentdb-v2'
const MEMORY_CORE_PORT = 8420
const DEFAULT_BASE_URL = `http://127.0.0.1:${MEMORY_CORE_PORT}`
// 全新数据目录 + 多服务并行冷启动（tsx 编译争抢 IO）时 30s 不够，实测可超一分钟。
const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 5_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class MemoryCoreSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: MemoryCoreConnection | null = null
  private stopping = false
  private lastError: string | null = null

  constructor(private readonly dataDirectory: string) {}

  async start(options: MemoryCoreStartOptions = {}): Promise<MemoryCoreConnection | null> {
    if (this.connection) return this.connection

    if (process.env.NXCORE_MEMORY_MANAGED === 'false' || process.env.NXCORE_MEMORY_ENABLED === 'false') {
      return null
    }
    const externalBaseUrl = process.env.NXCORE_MEMORY_BASE_URL?.trim()
    if (externalBaseUrl && externalBaseUrl !== DEFAULT_BASE_URL) return null

    // 复用已在运行的实例(用户手动部署的 MemoryCore 等)。
    if (await this.probe()) {
      this.connection = {
        baseUrl: DEFAULT_BASE_URL,
        apiKey: process.env.NXCORE_MEMORY_API_KEY?.trim() ?? '',
        managed: false,
      }
      console.info(`[memory-core] reusing existing instance at ${DEFAULT_BASE_URL}`)
      return this.connection
    }

    // 重启场景复用旧 apiKey：gateway env 里的 NXCORE_MEMORY_API_KEY 不变，
    // 免去重启后 gateway 侧 401。
    const apiKey = options.apiKey ?? randomBytes(24).toString('base64url')
    const entryPath = this.resolveEntry()
    await mkdir(this.dataDirectory, { recursive: true })
    // 数据目录收进应用数据(KS 的 knowledge/ 同款约定):不设 TDAI_DATA_DIR 时
    // MemoryCore 默认落 ~/.memory-tencentdb/,卸载/清数据会留残骸。
    const dataDir = join(this.dataDirectory, 'memory')
    await mkdir(dataDir, { recursive: true })
    const logDirectory = process.env.LOG_PATH?.trim() || join(this.dataDirectory, 'logs', 'memory-core')
    await mkdir(logDirectory, { recursive: true })

    const command = app.isPackaged ? process.execPath : (process.env.NXCORE_MEMORY_NODE ?? 'node')
    const child = spawn(
      command,
      [entryPath],
      {
        cwd: dataDir,
        // detached 让子进程成为进程组组长：shutdown 可整组 kill（tsx wrapper
        // fork 的孙进程才不会残留占端口）。Electron 主进程退出不连带子进程
        // 组——退出清理仍靠 shutdown() 的显式调用。
        detached: true,
        env: {
          ...process.env,
          TDAI_GATEWAY_HOST: '127.0.0.1',
          TDAI_GATEWAY_PORT: String(MEMORY_CORE_PORT),
          TDAI_GATEWAY_API_KEY: apiKey,
          TDAI_DATA_DIR: dataDir,
          LOG_PATH: logDirectory,
          ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...this.llmEnvironment(),
          ...(options.aiEnvironment ?? {}),
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
    child.stdout.on('data', (chunk: string) => process.stdout.write(`[memory-core] ${chunk}`))
    child.stderr.on('data', (chunk: string) => process.stderr.write(`[memory-core] ${chunk}`))
    child.on('exit', (code, signal) => {
      this.child = null
      if (!this.stopping) {
        this.lastError = `MemoryCore 进程已退出（code=${String(code)}, signal=${String(signal)}）`
        console.error(this.lastError)
      }
    })

    try {
      await this.waitUntilReady(child)
      this.connection = { baseUrl: DEFAULT_BASE_URL, apiKey, managed: true }
      console.info(`[memory-core] managed instance ready at ${DEFAULT_BASE_URL} (pid=${child.pid})`)
      return this.connection
    } catch (error) {
      this.killChild(child, 'SIGTERM')
      this.child = null
      this.lastError = error instanceof Error ? error.message : 'MemoryCore 启动失败'
      throw error
    }
  }

  getConnection(): MemoryCoreConnection | null {
    return this.connection
  }

  /**
   * 重启托管实例以应用新的 AI 环境(MemoryCore 启动时解析配置,无热加载)。
   * 复用旧 apiKey,busy/外部/复用模式不重启。失败抛出,连接置空。
   */
  async restart(aiEnvironment: Record<string, string> | null): Promise<MemoryCoreConnection | null> {
    const connection = this.connection
    if (!connection?.managed) return connection
    const apiKey = connection.apiKey
    await this.shutdown()
    return this.start({ apiKey, aiEnvironment: aiEnvironment ?? undefined })
  }

  getLastError(): string | null {
    return this.lastError
  }

  async shutdown(): Promise<void> {
    const child = this.child
    this.connection = null
    if (!child) return

    this.stopping = true
    // 杀整棵进程树（负 PID）：dev 模式入口是 tsx wrapper，SIGTERM 只杀
    // wrapper 时它 fork 的 gateway 孙进程会残留并占住 8420，下一轮
    // start() 的 probe 会误判「复用外部实例」，带新 env 的重启被吞掉。
    const processGroupKill = (): boolean => {
      try {
        return process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // 进程组 kill 不可用（如非组长）退回单进程 kill。
        return this.killChild(child, 'SIGTERM')
      }
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已死 */ }
        this.killChild(child, 'SIGKILL')
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
      child.once('exit', finish)
      if (!processGroupKill()) finish()
    })
    // 孙进程可能比 wrapper 晚退出几百毫秒：等待端口释放，避免 start() 的
    // probe 抢在残留进程死亡前把它当成「可复用实例」。
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && await this.probe()) await delay(100)
    this.child = null
    this.lastError = null
  }

  /**
   * 把桌面的 NXCORE_AI_* 映射为 MemoryCore 提炼管道使用的 TDAI_LLM_*。
   * embedding 不在此映射:TDAI_EMBEDDING_* 由 spawn 的 ...process.env 原样透传
   * （fork 侧 env > tdai-gateway.yaml > 默认），在根目录 .env 配即可生效。
   */
  private llmEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {}
    const baseUrl = process.env.NXCORE_AI_BASE_URL?.trim()
    const apiKey = process.env.NXCORE_AI_API_KEY?.trim()
    const model = process.env.NXCORE_AI_MODEL?.trim()
    if (baseUrl) environment.TDAI_LLM_BASE_URL = baseUrl
    if (apiKey) environment.TDAI_LLM_API_KEY = apiKey
    if (model) environment.TDAI_LLM_MODEL = model
    // 提炼输出预算保持 .env-only 可选:不设则 fork 默认(见 .env 注释)。
    const maxTokens = process.env.TDAI_LLM_MAX_TOKENS?.trim()
    if (maxTokens) environment.TDAI_LLM_MAX_TOKENS = maxTokens
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
          `MemoryCore exited during startup with code ${String(child.exitCode)}${this.lastError ? `: ${this.lastError}` : ''}`,
        )
      }
      if (await this.probe()) return
      await delay(100)
    }
    throw new Error(`MemoryCore did not become ready within ${STARTUP_TIMEOUT_MS}ms`)
  }

  private resolveEntry(): string {
    const override = process.env.NXCORE_MEMORY_CORE_DIR?.trim()
    if (override) return join(override, 'bin', 'memory-gateway.mjs')
    // dev:从 apps/desktop 的 node_modules 解析 git 依赖安装的 memory-core 包。
    // 包的 exports 只放行了 ./bin/*,所以用 bin 入口定位包根目录。
    const baseRequire = createRequire(join(app.getAppPath(), 'package.json'))
    return baseRequire.resolve(`${PACKAGE_NAME}/bin/memory-gateway.mjs`)
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}
