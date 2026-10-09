import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { forgetProcessRecord, registerProcessRecord } from '../process-cleanup'

/**
 * 托管 nxcore-asr（自研离线转写：FunASR + 说话人识别）子进程管理器。
 * 与 MemoryCoreSupervisor 同款三模式，另加 Python 侧的层叠依赖编排：
 *
 * 1. 外部模式：NXCORE_ASR_BASE_URL 指向别处 / NXCORE_ASR_MANAGED=false —— 不托管。
 * 2. 复用模式：127.0.0.1:8300 已有健康实例（用户手动部署）—— 直接复用托管 key。
 * 3. 托管模式：按需拉起本地服务：
 *    python 检测 → venv+依赖安装（首次约 2GB）→ PostgreSQL（docker compose）
 *    → config.yaml（注入持久化租户 key）→ uvicorn 拉起（首装含模型下载约 2.1GB）。
 *
 * 按需启动：用户在设置页选「内置离线转写」才 start（FunASR 常驻内存 1-2GB，
 * 不随应用启动预载）。首次 setup 全程通过 status() 轮询呈现进度态。
 */
export type NxCoreAsrState =
  | 'idle'
  | 'external'
  | 'reused'
  | 'ready'
  | 'missing-python'
  | 'missing-docker'
  | 'setup-venv'
  | 'starting'
  | 'error'

export interface NxCoreAsrStatus {
  state: NxCoreAsrState
  /** 人可读的进度/缺失说明（i18n 由 renderer 侧按 state 处理，此处为细节补充）。 */
  message: string | null
  /** ready/reused 时的连接信息（apiKey 是本机租户密钥，仅在托管/复用时给出）。 */
  baseUrl: string | null
  apiKey: string | null
  /** 安装步骤进度（1 基）：检测环境 → 安装依赖 → 准备数据库 → 下载模型 → 启动。 */
  step: number
  /** 实时明细（当前下载的包名 / 模型下载百分比等），高频刷新。 */
  detail: string | null
}

export interface NxCoreAsrConnection {
  baseUrl: string
  apiKey: string
  managed: boolean
}

const SERVICE_PORT = 8300
const DEFAULT_BASE_URL = `http://127.0.0.1:${SERVICE_PORT}`
const PG_PORT = 25432
/** 正常启动（模型已就位）两分钟；首装含模型下载，放宽到 45 分钟。 */
const STARTUP_TIMEOUT_MS = 120_000
const FIRST_RUN_STARTUP_TIMEOUT_MS = 45 * 60_000
const SHUTDOWN_TIMEOUT_MS = 5_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function serviceDirectory(): string {
  const override = process.env.NXCORE_ASR_SERVICE_DIR?.trim()
  if (override) return override
  // dev：app.getAppPath() = apps/desktop，两层 .. 回仓库根；打包版由
  // resources 部署后经 NXCORE_ASR_SERVICE_DIR 指向。
  return join(app.getAppPath(), '..', '..', 'submodules', 'nxcoreasr')
}

function venvPython(serviceDir: string): string {
  return process.platform === 'win32'
    ? join(serviceDir, '.venv', 'Scripts', 'python.exe')
    : join(serviceDir, '.venv', 'bin', 'python')
}

/** 便携 PostgreSQL 二进制目录（打包版免 Docker 形态）：bin/ 下有 initdb 与
 *  pg_ctl 即认定有效。macOS 二进制无后缀，Windows 为 .exe。
 *  探测顺序：NXCORE_ASR_PG_DIST 覆盖 → 打包 resources → submodule pg-dist。 */
function portablePgDir(): string | null {
  const override = process.env.NXCORE_ASR_PG_DIST?.trim()
  const candidates = [
    ...(override ? [override] : []),
    join(app.getAppPath(), '..', '..', 'resources', 'postgres-portable'),
    join(app.getAppPath(), '..', '..', '..', 'submodules', 'nxcoreasr', 'pg-dist'),
  ]
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'bin', `initdb${exe}`))) return candidate
  }
  return null
}

function detectPython(): string | null {
  for (const command of ['python3.12', 'python', 'py -3.12']) {
    const parts = command.split(' ')
    try {
      const result = spawnSync(parts[0]!, parts.slice(1).concat('--version'), { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      if (result.status === 0 && /Python 3\.(12|1[3-9])/.test(`${result.stdout}${result.stderr}`)) {
        return command
      }
    } catch {
      // 尝试下一个候选。
    }
  }
  return null
}

/** TCP 连接探测：端口上有可连的服务返回 true（空闲端口返回 false）。
 *  曾误用 createServer().listen 反向判定——端口空闲（PG 未起）返回 true，
 *  导致 docker compose 从未执行、服务连接 PG 超时退出。 */
export async function probeTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ port, host: '127.0.0.1' })
    const finish = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    setTimeout(() => finish(false), 1_500).unref()
  })
}

export class NxCoreAsrSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: NxCoreAsrConnection | null = null
  private stopping = false
  private starting: Promise<NxCoreAsrConnection | null> | null = null
  private lastError: string | null = null
  private state: NxCoreAsrState = 'idle'
  private stateMessage: string | null = null
  private stateStep = 0
  private stateDetail: string | null = null

  constructor(private readonly dataDirectory: string) {}

  getStatus(): NxCoreAsrStatus {
    const connection = this.connection
    return {
      state: this.state,
      message: this.stateMessage ?? this.lastError,
      baseUrl: connection?.baseUrl ?? null,
      apiKey: connection?.apiKey ?? null,
      step: this.stateStep,
      detail: this.stateDetail,
    }
  }

  getConnection(): NxCoreAsrConnection | null {
    return this.connection
  }

  /** 按需启动：重复调用共享同一轮启动。返回 null 表示外部模式（不托管）。 */
  start(): Promise<NxCoreAsrConnection | null> {
    if (this.connection) return Promise.resolve(this.connection)
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<NxCoreAsrConnection | null> {
    if (process.env.NXCORE_ASR_MANAGED === 'false') {
      this.setState('external', 'NXCORE_ASR_MANAGED=false')
      return null
    }
    const externalBaseUrl = process.env.NXCORE_ASR_BASE_URL?.trim()
    if (externalBaseUrl && externalBaseUrl !== DEFAULT_BASE_URL) {
      this.setState('external', `外部实例 ${externalBaseUrl}`)
      return null
    }

    const apiKey = this.loadOrCreateApiKey()

    // 已有健康实例（含上次托管的残留或用户手动部署）：直接复用。
    if (await this.probe(apiKey)) {
      this.connection = { baseUrl: DEFAULT_BASE_URL, apiKey, managed: false }
      this.state = 'reused'
      this.stateMessage = null
      this.stateStep = 5
      this.stateDetail = null
      console.info(`[nxcore-asr] reusing existing instance at ${DEFAULT_BASE_URL}`)
      return this.connection
    }

    const serviceDir = serviceDirectory()
    if (!existsSync(join(serviceDir, 'app'))) {
      this.setState('error', `服务目录不存在：${serviceDir}（submodule 未检出？）`, 1)
      return null
    }

    const python = detectPython()
    if (!python) {
      this.setState('missing-python', '需要 Python 3.12+（python3.12 / python / py -3.12 均未检测到）', 1)
      return null
    }

    // 依赖安装（步骤 2）与 PostgreSQL（步骤 3）互不依赖，真正并行执行。
    // 就绪判定看「关键包可导入」而非 venv 存在——pip 中途失败会留下有
    // python.exe 无依赖的半成品 venv，曾导致 spawn 直接报 No module named uvicorn。
    const pythonPath = venvPython(serviceDir)
    const depsReady = (): boolean => {
      if (!existsSync(pythonPath)) return false
      const probe = spawnSync(pythonPath, ['-c', 'import uvicorn, fastapi'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
      return probe.status === 0
    }
    const setupDone: Promise<boolean> = (async () => {
      if (depsReady()) return true
      this.setState('setup-venv', '正在安装依赖（首次约 2GB，走国内镜像）…', 2)
      await this.runSetup(python, serviceDir)
      if (!depsReady()) {
        this.lastError = '依赖安装未完成（关键包不可导入）'
        return false
      }
      return true
    })()
    const pgDone: Promise<boolean> = (async () => {
      if (await probeTcpPort(PG_PORT)) return true
      // 便携 PG 分支（打包版形态）：自带 postgres 二进制目录，免 Docker。
      // dev 无 pg-dist 时回落 docker compose。
      if (portablePgDir()) return this.startPortablePg()
      const started = await this.runDockerCompose(serviceDir)
      if (!started) return false
      return await this.waitPgReady()
    })()
    const [setupOk, pgOk] = await Promise.all([setupDone, pgDone])
    if (!setupOk) {
      this.setState('error', this.lastError ?? '依赖安装失败', 2)
      return null
    }
    if (!pgOk) {
      this.setState('missing-docker', this.lastError ?? 'PostgreSQL 未就绪（docker compose 失败）', 3)
      return null
    }

    // config.yaml：托管模式注入持久化租户 key（复用/外部实例不受影响——
    // 服务的租户表是静态白名单，写文件只在文件缺失或 key 不匹配时发生）。
    this.ensureServiceConfig(serviceDir, apiKey)

    // 首装判定：models 目录不存在 → 服务首启会下载模型（约 2.1GB）。
    const firstRun = !existsSync(join(serviceDir, 'models'))
    this.setState('starting', firstRun ? '首次启动：正在下载模型（约 2.1GB，仅此一次）…' : null, 4)

    const child = spawn(
      pythonPath,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(SERVICE_PORT)],
      {
        cwd: serviceDir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    this.stopping = false
    child.stdin.end()
    registerProcessRecord(join(this.dataDirectory, 'runtime'), 'nxcore-asr', child.pid, pythonPath)
    const forward = (stream: NodeJS.ReadableStream, target: NodeJS.WriteStream): void => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        target.write(`[nxcore-asr] ${chunk}`)
        // modelscope 下载进度（tqdm 风格百分比）透传为状态明细——首装十几
        // 分钟的真空期由此可见实时进度。
        const progress = chunk.match(/(\d{1,3})%\|[^|]*\|\s*([\d.]+\s*[KMG]B?)\s*\/\s*([\d.]+\s*[KMG]B?)/)
        if (progress) this.setDetail(`模型下载 ${progress[1]}%（${progress[2]}/${progress[3]}）`)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    child.on('exit', (code, signal) => {
      this.child = null
      forgetProcessRecord(join(this.dataDirectory, 'runtime'), 'nxcore-asr')
      if (!this.stopping) {
        // 崩溃/被杀：清空连接让 start() 可重入（否则设置页点启动只会
        // 返回陈旧连接，录音持续失败直到重启应用）。
        this.connection = null
        this.lastError = `nxcore-asr 进程已退出（code=${String(code)}, signal=${String(signal)}）`
        this.setState('error', this.lastError)
        console.error(this.lastError)
      }
    })

    try {
      await this.waitUntilReady(child, apiKey, firstRun ? FIRST_RUN_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS)
      this.connection = { baseUrl: DEFAULT_BASE_URL, apiKey, managed: true }
      this.state = 'ready'
      this.stateMessage = null
      this.stateStep = 5
      this.stateDetail = null
      console.info(`[nxcore-asr] managed instance ready at ${DEFAULT_BASE_URL} (pid=${child.pid})`)
      return this.connection
    } catch (error) {
      this.killChild(child)
      this.child = null
      const message = error instanceof Error ? error.message : 'nxcore-asr 启动失败'
      this.lastError = message
      this.setState('error', message, 4)
      return null
    }
  }

  async shutdown(): Promise<void> {
    const child = this.child
    this.connection = null
    this.stopPortablePg()
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

  /** venv 创建 + pip 依赖安装。国内镜像直连 torch 等大包（官方源国内极慢，
   *  可用 NXCORE_ASR_PIP_INDEX 覆盖）；pip 输出解析为实时明细。 */
  private runSetup(python: string, serviceDir: string): Promise<void> {
    const pipIndex = process.env.NXCORE_ASR_PIP_INDEX?.trim() || 'https://pypi.tuna.tsinghua.edu.cn/simple'
    /** pip 非 tty 输出按行解析：Collecting/Downloading → 当前包；Installing → 安装阶段。 */
    const parsePipLine = (line: string): void => {
      const download = line.match(/Downloading\s+(\S+)\s+\(([\d.]+\s*[KMG]B?)/)
      if (download) {
        this.setDetail(`下载 ${download[1]!.split('-')[0]}（${download[2]}）`)
        return
      }
      const collect = line.match(/Collecting\s+(\S+)/)
      if (collect) {
        this.setDetail(`获取 ${collect[1]!.split('==')[0]}`)
        return
      }
      if (line.startsWith('Installing collected packages')) {
        this.setDetail('正在安装已下载的包…')
        return
      }
      if (line.startsWith('Successfully installed')) {
        this.setDetail(null)
      }
    }
    const pipeOutput = (stream: NodeJS.ReadableStream, target: NodeJS.WriteStream, parse: boolean): void => {
      stream.setEncoding('utf8')
      let buffer = ''
      stream.on('data', (chunk: string) => {
        target.write(`[nxcore-asr-setup] ${chunk}`)
        if (!parse) return
        // 行缓冲：pip 的进度按行输出，块内可能多行。
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) parsePipLine(trimmed)
        }
      })
    }
    return new Promise((resolve) => {
      const parts = python.split(' ')
      const child = spawn(parts[0]!, [...parts.slice(1), '-m', 'venv', '.venv'], {
        cwd: serviceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      child.stdin.end()
      pipeOutput(child.stdout!, process.stdout, false)
      pipeOutput(child.stderr!, process.stderr, false)
      child.on('exit', (venvCode) => {
        if (venvCode !== 0) {
          this.lastError = `venv 创建失败（code=${String(venvCode)}）`
          resolve()
          return
        }
        this.setDetail('正在下载依赖包…')
        const pip = spawn(venvPython(serviceDir), ['-m', 'pip', 'install', '-r', 'requirements.txt', '-i', pipIndex], {
          cwd: serviceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        })
        pip.stdin.end()
        pipeOutput(pip.stdout, process.stdout, true)
        pipeOutput(pip.stderr, process.stdout, true)
        pip.on('exit', (pipCode) => {
          if (pipCode !== 0) this.lastError = `pip install 失败（code=${String(pipCode)}）`
          this.setDetail(null)
          resolve()
        })
      })
    })
  }

  /** docker compose 起 PostgreSQL（异步，与 pip 安装并行）。 */
  private runDockerCompose(serviceDir: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('docker', ['compose', 'up', '-d'], {
        cwd: serviceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      child.stdin.end()
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        process.stdout.write(`[nxcore-asr-setup] ${chunk}`)
      })
      child.stderr.on('data', (chunk: string) => {
        output += chunk
        process.stdout.write(`[nxcore-asr-setup] ${chunk}`)
        // 首次拉 postgres 镜像的进度行透传为明细。
        const pull = chunk.match(/Pulling\s+([\w:.-]+)[\s.]*([\d.kmg]+\/[\d.kmg]+)?/)
        if (pull) this.setDetail(`拉取镜像 ${pull[1]}${pull[2] ? `（${pull[2]}）` : ''}`)
      })
      const timeout = setTimeout(() => {
        this.killChild(child)
        this.lastError = 'docker compose 超时（5 分钟）'
        resolve(false)
      }, 300_000)
      child.on('exit', (code) => {
        clearTimeout(timeout)
        this.setDetail(null)
        if (code === 0) return resolve(true)
        this.lastError = '离线转写需要 PostgreSQL（docker compose）未就绪：' + (output.trim().split('\n').pop() || 'docker 不可用')
        resolve(false)
      })
    })
  }

  /** 等 PG 端口就绪（容器起后到可连有几秒窗口）。 */
  private async waitPgReady(): Promise<boolean> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await probeTcpPort(PG_PORT)) return true
      await delay(500)
    }
    this.lastError = 'PostgreSQL 端口 30s 内未就绪'
    return false
  }

  /** 便携 PG 托管（打包版免 Docker）：initdb 一次 → pg_ctl start → 复刻
   *  docker initdb 的角色/库初始化（asr_app + asr 库 owner）。
   *  平面注意：macOS 二进制无后缀、initdb 需 --locale=C（默认 locale 报错）、
   *  pg_ctl 用 -w -t 同步等待启动完成。 */
  private async startPortablePg(): Promise<boolean> {
    const pgDir = portablePgDir()
    if (!pgDir) return false
    const exe = process.platform === 'win32' ? '.exe' : ''
    const bin = join(pgDir, 'bin')
    const pgHome = join(this.dataDirectory, 'nxcore-asr-pg')
    let dataDir = join(pgHome, 'data')
    const logFile = join(pgHome, 'logfile.txt')
    const run = (args: string[], timeoutMs: number): { status: number | null; output: string } => {
      const result = spawnSync(join(bin, args[0]!), args.slice(1).map((arg) => arg === '{{DATA}}' ? dataDir : arg), {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      })
      return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
    }
    this.setDetail('准备 PostgreSQL…')
    await mkdir(pgHome, { recursive: true }).catch(() => undefined)
    if (!existsSync(join(dataDir, 'PG_VERSION'))) {
      this.setDetail('初始化 PostgreSQL 数据目录…')
      let init = run(['initdb', '-D', '{{DATA}}', '-U', 'asr_admin', '-E', 'UTF8', '-A', 'trust', '--locale=C'], 120_000)
      // Windows 杀软实时扫描可锁 WAL rename（Improper link/No such file）：
      // userData 常在扫描重点区，重试换 os.tmpdir() 下的目录。dataDir 随之切换，
      // 后续 pg_ctl/PG_VERSION 探测/stop 统一走实际目录（tmpdir 集群重启后
      // 丢失，PG_VERSION 不在即重走 initdb，自愈）。
      if (init.status !== 0 && /rename|No such file|Improper link/i.test(init.output)) {
        console.warn('[nxcore-asr] initdb 在数据目录被拦截（疑似杀软），改用临时目录重试')
        dataDir = join(tmpdir(), 'everroom-nxcore-asr-pg', 'data')
        await mkdir(join(tmpdir(), 'everroom-nxcore-asr-pg'), { recursive: true }).catch(() => undefined)
        init = run(['initdb', '-D', '{{DATA}}', '-U', 'asr_admin', '-E', 'UTF8', '-A', 'trust', '--locale=C'], 120_000)
      }
      if (init.status !== 0) {
        this.lastError = `initdb 失败：${init.output.slice(-300)}`
        return false
      }
    }
    if (!(await probeTcpPort(PG_PORT))) {
      this.setDetail('启动 PostgreSQL…')
      const start = run(['pg_ctl', '-D', dataDir, '-l', logFile,
        '-o', `-p ${PG_PORT} -h 127.0.0.1`, '-w', '-t', '60', 'start'], 90_000)
      if (start.status !== 0) {
        this.lastError = `pg_ctl start 失败：${start.output.slice(-300)}`
        return false
      }
    }
    if (!(await this.waitPgReady())) return false
    // 复刻 docker/initdb/01-roles.sql（幂等）：asr_app 角色 + asr 库 owner。
    // trust 认证下本地回环免密，超级用户 asr_admin 直连执行。
    const psql = (sql: string): { status: number | null; output: string } =>
      run(['psql', '-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'asr_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], 30_000)
    const role = psql("SELECT 1 FROM pg_roles WHERE rolname='asr_app'")
    if (role.status !== 0) {
      this.lastError = `psql 角色查询失败：${role.output.slice(-200)}`
      return false
    }
    if (!role.output.includes('1')) {
      const create = psql("CREATE ROLE asr_app LOGIN PASSWORD 'asr_dev_password'")
      if (create.status !== 0) {
        this.lastError = `创建 asr_app 角色失败：${create.output.slice(-200)}`
        return false
      }
    }
    const db = psql("SELECT 1 FROM pg_database WHERE datname='asr'")
    if (db.status === 0 && !db.output.includes('1')) {
      const create = psql('CREATE DATABASE asr OWNER asr_app')
      if (create.status !== 0) {
        this.lastError = `创建 asr 库失败：${create.output.slice(-200)}`
        return false
      }
    }
    this.setDetail(null)
    console.info(`[nxcore-asr] portable PostgreSQL ready at 127.0.0.1:${PG_PORT}`)
    return true
  }

  /** 便携 PG 关停（托管进程树里 pg_ctl 派生的 postgres 由 shutdown 兜底）。
   *  两个候选数据目录都尝试 stop：杀软回退路径的集群在 tmpdir 下。 */
  private stopPortablePg(): void {
    const pgDir = portablePgDir()
    if (!pgDir) return
    const exe = process.platform === 'win32' ? '.exe' : ''
    const candidates = [
      join(this.dataDirectory, 'nxcore-asr-pg', 'data'),
      join(tmpdir(), 'everroom-nxcore-asr-pg', 'data'),
    ]
    for (const dataDir of candidates) {
      if (!existsSync(dataDir)) continue
      try {
        spawnSync(join(pgDir, 'bin', `pg_ctl${exe}`), ['-D', dataDir, '-m', 'fast', '-w', '-t', '10', 'stop'], {
          encoding: 'utf8', timeout: 15_000, windowsHide: true,
        })
      } catch {
        // 已停或异常都不阻塞退出。
      }
    }
  }

  /** 租户 key 持久化在应用数据目录：重启复用，服务端 config.yaml 与网关配置共享同一把。 */
  private loadOrCreateApiKey(): string {
    const keyFile = join(this.dataDirectory, 'nxcore-asr-key')
    try {
      const existing = readFileSync(keyFile, 'utf8').trim()
      if (existing.length >= 32) return existing
    } catch {
      // 未持久化过。
    }
    const generated = randomBytes(24).toString('hex')
    try {
      writeFileSync(keyFile, generated + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[nxcore-asr] key persist failed |', error)
    }
    return generated
  }

  private ensureServiceConfig(serviceDir: string, apiKey: string): void {
    const configPath = join(serviceDir, 'config.yaml')
    const desired = [
      '# 由 EverRoom 桌面端托管生成：修改会被下次托管启动覆盖（手动部署请自建 config.yaml 并设 NXCORE_ASR_MANAGED=false）。',
      // funasr 纯 torch：零准备（模型首启自动下载）；默认 llamacpp 需预编译
      // 二进制（setup 脚本 10-30 分钟），托管模式不假设用户跑过。
      'engine: funasr',
      'data_dir: ./data',
      'model_dir: ./models',
      'database_url: postgresql+psycopg://asr_app:asr_dev_password@127.0.0.1:25432/asr',
      'max_workers: 2',
      'tenants:',
      `  - name: everroom_desktop`,
      `    api_key: ${apiKey}`,
      '',
    ].join('\n')
    try {
      if (existsSync(configPath)) {
        const current = readFileSync(configPath, 'utf8')
        if (current.includes(apiKey)) return
      }
      writeFileSync(configPath, desired, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[nxcore-asr] config.yaml write failed |', error)
    }
  }

  private async probe(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${DEFAULT_BASE_URL}/v1/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(1_500),
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async waitUntilReady(child: ChildProcessWithoutNullStreams, apiKey: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`nxcore-asr 启动期间退出（code=${String(child.exitCode)}）${this.lastError ? `：${this.lastError}` : ''}`)
      }
      if (await this.probe(apiKey)) return
      await delay(500)
    }
    throw new Error(`nxcore-asr ${timeoutMs / 1000}s 内未就绪${firstRunHint(timeoutMs)}`)
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }

  private setState(state: NxCoreAsrState, message: string | null, step = 0, detail: string | null = null): void {
    this.state = state
    this.stateMessage = message
    this.stateStep = step
    this.stateDetail = detail
  }

  /** 高频明细更新（pip 包名 / 模型下载百分比），不改状态机只刷新 detail。 */
  private setDetail(detail: string | null): void {
    this.stateDetail = detail
  }
}

function firstRunHint(timeoutMs: number): string {
  return timeoutMs > 10 * 60_000 ? '（首次启动含模型下载，可稍后重试或查看应用日志）' : ''
}
