import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'

import { app } from 'electron'

import { forgetProcessRecord, registerProcessRecord } from '../process-cleanup'

/**
 * 托管 nxcore-asr（自研离线转写：FunASR + 说话人识别）子进程管理器。
 * 与 MemoryCoreSupervisor 同款三模式，另加 Python 侧的层叠依赖编排：
 *
 * 1. 外部模式：NXCORE_ASR_BASE_URL 指向别处 / NXCORE_ASR_MANAGED=false —— 不托管。
 * 2. 复用模式：127.0.0.1:8300 已有健康实例（用户手动部署）—— 直接复用托管 key。
 * 3. 托管模式：按需拉起本地服务：
 *    python 检测 → venv+依赖安装（首次约 2GB）→ 音频解码器 ffmpeg 就位 →
 *    config.yaml（SQLite 库文件 + 持久租户 key）→ uvicorn 拉起（首装含模型
 *    下载约 2.1GB）。ffmpeg 是服务转码 webm/opus 的硬依赖，且按名字调用，
 *    故此处统一探测/自动安装后以前置 PATH 的固定名暴露（见 ensureFfmpeg）。
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
  /** 安装步骤进度（1 基）：检测环境 → 安装依赖 → 下载模型 → 启动。 */
  step: number
  /** 实时明细（当前下载的包名 / 模型下载百分比等），高频刷新。 */
  detail: string | null
  /** 模型档位：lite = SenseVoice（约 1GB，无说话人识别）；full = Fun-ASR+CAM++（约 2.1GB）。 */
  tier: NxCoreAsrModelTier
}

/** 模型档位。lite 经「目录别名」兼容实现：SenseVoice 预下载到引擎按固定名
 *  探测的 fun-asr-nano 子目录，服务端零改动（无逐字时间戳时引擎自动退化为
 *  整段单说话人，输出文本的富标签由网关侧剥离）。 */
export type NxCoreAsrModelTier = 'lite' | 'full'

export interface NxCoreAsrConnection {
  baseUrl: string
  apiKey: string
  managed: boolean
}

const SERVICE_PORT = 8300
const DEFAULT_BASE_URL = `http://127.0.0.1:${SERVICE_PORT}`
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
  // 打包版：extraResources 把服务目录部署到 resources/nxcoreasr
  // （getAppPath 为 resources/app.asar，上一级即 resources）。
  const packaged = join(app.getAppPath(), '..', 'nxcoreasr')
  if (existsSync(join(packaged, 'app'))) return packaged
  // dev：app.getAppPath() = apps/desktop，两层 .. 回仓库根。
  return join(app.getAppPath(), '..', '..', 'submodules', 'nxcoreasr')
}

function venvPython(serviceDir: string): string {
  return process.platform === 'win32'
    ? join(serviceDir, '.venv', 'Scripts', 'python.exe')
    : join(serviceDir, '.venv', 'bin', 'python')
}

function detectPython(): string | null {
  // macOS/Linux 常见名是 python3 / python3.N（裸 python 常不存在，/usr/bin/python3
  // 可能是系统 3.9——版本正则会拒掉继续试）；Windows 走 py 启动器。顺序即优先级。
  for (const command of ['python3', 'python3.13', 'python3.12', 'python', 'py -3.12']) {
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

/** 源码模式自动检出服务子模块：nxcoreasr 在公共镜像（github.com/NxcoreAI/
 *  nxcoreasr），无凭据即可拉取。仅开发态（非打包）且运行在 git 检出内时尝试
 *  ——打包版服务码随 resources 发布，永远不会走到服务目录缺失。 */
function findGitBinary(): string | null {
  // GUI 启动（macOS Finder 双击）的 PATH 不含 Homebrew 路径，补常见 git 位置。
  for (const bin of ['git', '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) {
    try {
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      if (probe.status === 0) return bin
    } catch {
      // 尝试下一个候选。
    }
  }
  return null
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
  private tier: NxCoreAsrModelTier = 'full'
  /** 服务子进程需要前置到 PATH 的 ffmpeg 目录（固定名 shim 或来源目录）。 */
  private ffmpegDirectory: string | null = null

  constructor(private readonly dataDirectory: string) {
    try {
      const saved = readFileSync(join(dataDirectory, 'nxcore-asr-tier'), 'utf8').trim()
      if (saved === 'lite' || saved === 'full') this.tier = saved
    } catch {
      // 未持久化过，默认完整档。
    }
  }

  getStatus(): NxCoreAsrStatus {
    const connection = this.connection
    return {
      state: this.state,
      message: this.stateMessage ?? this.lastError,
      baseUrl: connection?.baseUrl ?? null,
      apiKey: connection?.apiKey ?? null,
      step: this.stateStep,
      detail: this.stateDetail,
      tier: this.tier,
    }
  }

  getModelTier(): NxCoreAsrModelTier {
    return this.tier
  }

  /** 切换模型档位：持久化；托管实例运行中则重启以加载另一套模型目录。 */
  async setModelTier(tier: NxCoreAsrModelTier): Promise<void> {
    if (tier !== 'lite' && tier !== 'full') return
    if (tier === this.tier) return
    this.tier = tier
    try {
      writeFileSync(join(this.dataDirectory, 'nxcore-asr-tier'), tier + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[nxcore-asr] tier persist failed |', error)
    }
    if (this.child) {
      await this.shutdown()
      void this.start()
    }
  }

  /** 档位对应的模型目录：full 用服务目录内 ./models（服务自管下载）；
   *  lite 用应用数据目录下的独立目录（supervisor 预下载 SenseVoice 到
   *  引擎固定探测的 fun-asr-nano 子目录名）。斜杠统一为 /（yaml 友好）。 */
  private modelDirForTier(): string {
    return this.tier === 'lite'
      ? join(this.dataDirectory, 'nxcore-asr-models-lite').replaceAll('\\', '/')
      : './models'
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

  /** 源码模式自动检出服务子模块：nxcoreasr 在公共镜像上，无凭据即可拉取。
   *  仅开发态（非打包）且运行在 git 检出内时尝试；失败原因写入 lastError。 */
  private async tryInitSubmodule(): Promise<boolean> {
    if (app.isPackaged) return false
    const repoRoot = join(app.getAppPath(), '..', '..')
    if (!existsSync(join(repoRoot, '.git'))) return false
    const rel = 'submodules/nxcoreasr'
    this.lastError = null
    this.setDetail('正在获取内置转写服务源码…')
    const git = findGitBinary()
    if (!git) {
      this.lastError = '未找到 git'
      return false
    }
    // sync：换源后本地记录的子模块 URL 可能过期，先与 .gitmodules 对齐。
    for (const args of [['submodule', 'sync', '--', rel], ['submodule', 'update', '--init', '--', rel]]) {
      let output = ''
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(git, args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk) => { output += chunk })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk) => { output += chunk })
        const timer = setTimeout(() => { child.kill(); resolve(null) }, 120_000)
        child.on('error', () => { clearTimeout(timer); resolve(null) })
        child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
      })
      if (code !== 0) {
        this.lastError = `git ${args.join(' ')} 失败：${output.slice(-200)}`
        return false
      }
    }
    this.setDetail(null)
    return existsSync(join(repoRoot, rel, 'app'))
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
      this.stateStep = 4
      this.stateDetail = null
      console.info(`[nxcore-asr] reusing existing instance at ${DEFAULT_BASE_URL}`)
      return this.connection
    }

    const serviceDir = serviceDirectory()
    if (!existsSync(join(serviceDir, 'app'))) {
      // 源码模式：子模块未检出时自动从公共镜像拉取（无凭据），失败才要求手动。
      const inited = await this.tryInitSubmodule()
      if (!inited) {
        const reason = this.lastError ? `（${this.lastError}）` : ''
        this.setState('error', `内置转写服务源码缺失：自动获取失败${reason}。请手动执行 git submodule update --init submodules/nxcoreasr 后重试`, 1)
        return null
      }
    }

    const python = detectPython()
    if (!python) {
      this.setState('missing-python', '需要 Python 3.12+（python3.12 / python / py -3.12 均未检测到）', 1)
      return null
    }

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
    const setupOk = await setupDone
    if (!setupOk) {
      this.setState('error', this.lastError ?? '依赖安装失败', 2)
      return null
    }
    // 服务的转码步骤（webm/opus → 16k 单声道 wav）按名字调 ffmpeg：托管 venv
    // 里没有它，用户机器也常常没装（装了 Homebrew 版时 GUI 启动的 PATH 又看不
    // 到）。缺失会让每个任务都终止在 [Errno 2] No such file or directory。
    const ffmpegReady = await this.ensureFfmpeg(pythonPath)
    if (!ffmpegReady) {
      this.setState('error', this.lastError ?? '内置转写缺少音频解码器 ffmpeg', 2)
      return null
    }
    // lite 档：SenseVoice 预下载到目录别名 fun-asr-nano（引擎按固定名探测，
    // 见 modelDirForTier）——必须在 uvicorn 拉起前就位，否则服务会把真正的
    // Fun-ASR-Nano（约 2.1GB）下下来。fsmn-vad/cam-plus 体量小，交给服务首启自下。
    if (this.tier === 'lite') {
      const liteReady = await this.ensureLiteModels(pythonPath)
      if (!liteReady) {
        this.setState('error', this.lastError ?? '轻量模型下载失败', 3)
        return null
      }
    }

    // config.yaml：托管模式注入持久化租户 key（复用/外部实例不受影响——
    // 服务的租户表是静态白名单，写文件只在文件缺失或 key 不匹配时发生）。
    this.ensureServiceConfig(serviceDir, apiKey)

    // 首装判定：full 看 models 目录；lite 的 SenseVoice 已在上面预下载就位，
    // 仅剩 vad/声纹小模型（服务首启自下，几十 MB）。
    const firstRun = this.tier === 'full' && !existsSync(join(serviceDir, 'models'))
    this.setState('starting', firstRun ? '首次启动：正在下载模型（约 2.1GB，仅此一次）…' : null, 3)

    const child = spawn(
      pythonPath,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(SERVICE_PORT)],
      {
        cwd: serviceDir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // 全量继承 Electron 主进程 env 曾致 uvicorn 加载期静默退出（纯 Node
        // 同参 spawn 正常；Electron env 中的变量毒化 Python）——改传最小必需
        // + 服务可识别变量，同时隔离打包版 ELECTRON_* 污染。
        env: this.serviceEnvironment(),
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
      this.stateStep = 4
      this.stateDetail = null
      console.info(`[nxcore-asr] managed instance ready at ${DEFAULT_BASE_URL} (pid=${child.pid})`)
      return this.connection
    } catch (error) {
      this.killChild(child)
      this.child = null
      const message = error instanceof Error ? error.message : 'nxcore-asr 启动失败'
      this.lastError = message
      this.setState('error', message, 3)
      return null
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
    this.lastError = null
  }

  /** venv 创建 + pip 依赖安装。国内镜像直连 torch 等大包（官方源国内极慢，
   *  可用 NXCORE_ASR_PIP_INDEX 覆盖）；pip 输出解析为实时明细。 */
  private runSetup(python: string, serviceDir: string): Promise<void> {
    const pipIndex = this.pipIndex()
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

  /** lite 档模型预下载：SenseVoiceSmall 快照到应用数据目录的 fun-asr-nano
   *  别名目录（兼容见 modelDirForTier）。已就位直接通过；tqdm 进度透传为
   *  状态明细，超时 45 分钟对齐首装窗口。 */
  private ensureLiteModels(pythonPath: string): Promise<boolean> {
    const target = join(this.dataDirectory, 'nxcore-asr-models-lite', 'fun-asr-nano')
    if (existsSync(join(target, 'configuration.json'))) return Promise.resolve(true)
    this.setState('starting', '正在下载轻量模型（约 1GB，仅此一次）…', 3)
    const script = [
      'import sys',
      'from modelscope.hub.snapshot_download import snapshot_download',
      "snapshot_download('iic/SenseVoiceSmall', local_dir=sys.argv[1])",
    ].join('\n')
    return new Promise((resolve) => {
      const child = spawn(pythonPath, ['-c', script, target], {
        cwd: this.dataDirectory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: this.serviceEnvironment(),
      })
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.setDetail(null)
        if (!ok) this.killChild(child)
        resolve(ok)
      }
      const timeout = setTimeout(() => {
        this.lastError = '轻量模型下载超时（45 分钟）'
        finish(false)
      }, FIRST_RUN_STARTUP_TIMEOUT_MS)
      child.stdin.end()
      const forward = (stream: NodeJS.ReadableStream, target: NodeJS.WriteStream): void => {
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          target.write(`[nxcore-asr-models] ${chunk}`)
          const progress = chunk.match(/(\d{1,3})%\|[^|]*\|\s*([\d.]+\s*[KMG]B?)\s*\/\s*([\d.]+\s*[KMG]B?)/)
          if (progress) this.setDetail(`模型下载 ${progress[1]}%（${progress[2]}/${progress[3]}）`)
        })
      }
      forward(child.stdout, process.stdout)
      forward(child.stderr, process.stderr)
      child.on('exit', (code) => {
        if (code !== 0) this.lastError = `轻量模型下载失败（code=${String(code)}）`
        finish(code === 0)
      })
      child.on('error', (error) => {
        this.lastError = `轻量模型下载启动失败：${error.message}`
        finish(false)
      })
    })
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

  /** 托管运行的可写数据目录（SQLite 库 + 音频落盘）：打包版服务目录在
   *  resources（只读），必须放应用数据目录。路径斜杠统一 /（yaml 友好）。 */
  private managedDataDir(): string {
    return join(this.dataDirectory, 'nxcore-asr-data').replaceAll('\\', '/')
  }

  private ensureServiceConfig(serviceDir: string, apiKey: string): void {
    const configPath = join(serviceDir, 'config.yaml')
    const modelDir = this.modelDirForTier()
    const dataDir = this.managedDataDir()
    // SQLite 库文件放应用数据目录（服务方言分支：单文件单租户，免 PG）。
    // URL 百分号编码：SQLAlchemy 解码后交给 sqlite3，路径含空格/中文都安全。
    const sqliteUrl = `sqlite:///${encodeURIComponent(`${this.managedDataDir()}/asr.db`)}`
    const desired = [
      '# 由 EverRoom 桌面端托管生成：修改会被下次托管启动覆盖（手动部署请自建 config.yaml 并设 NXCORE_ASR_MANAGED=false）。',
      // funasr 纯 torch：零准备（模型首启自动下载）；默认 llamacpp 需预编译
      // 二进制（setup 脚本 10-30 分钟），托管模式不假设用户跑过。
      'engine: funasr',
      `data_dir: ${dataDir}`,
      `model_dir: ${modelDir}`,
      `database_url: ${sqliteUrl}`,
      'max_workers: 2',
      'tenants:',
      `  - name: everroom_desktop`,
      `    api_key: ${apiKey}`,
      '',
    ].join('\n')
    try {
      // 库文件父目录先建（sqlite 只建文件不建目录）。
      mkdirSync(join(this.dataDirectory, 'nxcore-asr-data'), { recursive: true })
      if (existsSync(configPath)) {
        const current = readFileSync(configPath, 'utf8')
        // key、模型目录（档位）与库地址一致才跳过重写：切档换 model_dir，
        // 旧版 PG 库地址（已废弃）也会触发重写迁移到 SQLite。
        if (current.includes(apiKey) && current.includes(`model_dir: ${modelDir}`) && current.includes(sqliteUrl)) return
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

  /** pip 源：官方源国内极慢，默认走清华镜像，可用 NXCORE_ASR_PIP_INDEX 覆盖。 */
  private pipIndex(): string {
    return process.env.NXCORE_ASR_PIP_INDEX?.trim() || 'https://pypi.tuna.tsinghua.edu.cn/simple'
  }

  /** 保证服务子进程能按名字找到 ffmpeg（转码 webm/opus 的硬依赖）：
   *  本机探测（含 GUI 启动时不在 PATH 的 Homebrew 位置）→ 缺失则装静态版 →
   *  统一以固定名 shim 暴露并前置到子进程 PATH。返回 false 时 lastError 已
   *  写明原因。 */
  private async ensureFfmpeg(pythonPath: string): Promise<boolean> {
    const shimPath = this.ffmpegShimPath()
    const shimDirectory = join(this.dataDirectory, 'nxcore-asr-bin')
    // 已部署过的 shim 仍可用就直接复用（老版本用户升级后无需重装）。
    if (existsSync(shimPath) && this.probeFfmpeg(shimPath)) {
      this.ffmpegDirectory = shimDirectory
      return true
    }
    const detected = this.detectFfmpeg()
    if (detected) {
      // 裸命令名说明继承来的 PATH 已能解析，无需 shim；绝对路径则暴露成固定名
      // （macOS 的 Homebrew 目录不在 GUI 应用的 PATH 里）。
      if (!detected.includes('/') && !detected.includes('\\')) return true
      this.ffmpegDirectory = this.writeFfmpegShim(detected, shimPath) ? shimDirectory : dirname(detected)
      return true
    }
    return this.provisionFfmpeg(pythonPath, shimPath, shimDirectory)
  }

  /** ffmpeg 探测顺序：显式 env 覆盖 → PATH → macOS/Linux 常见安装位置。
   *  Finder 双击启动的应用 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，必须补
   *  绝对路径才能用到已装好的 Homebrew/MacPorts 版。 */
  private ffmpegCandidates(): string[] {
    const override = process.env.NXCORE_ASR_FFMPEG?.trim()
    return [
      ...(override ? [override] : []),
      'ffmpeg',
      '/opt/homebrew/bin/ffmpeg',   // macOS Apple Silicon Homebrew
      '/usr/local/bin/ffmpeg',      // Intel Homebrew / 手动安装
      '/opt/local/bin/ffmpeg',      // MacPorts
    ]
  }

  private detectFfmpeg(): string | null {
    for (const candidate of this.ffmpegCandidates()) {
      if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) continue
      if (this.probeFfmpeg(candidate)) return candidate
    }
    return null
  }

  private probeFfmpeg(command: string): boolean {
    try {
      const probe = spawnSync(command, ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      return probe.status === 0
    } catch {
      return false
    }
  }

  /** 从 PyPI 装静态 ffmpeg（imageio-ffmpeg 的 wheel 自带二进制，约 30MB，各
   *  平台轮子齐全），免用户手动安装；装好后再以固定名暴露给服务。 */
  private provisionFfmpeg(pythonPath: string, shimPath: string, shimDirectory: string): Promise<boolean> {
    this.setDetail('未找到音频解码器 ffmpeg，正在自动安装（约 30MB）…')
    return new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        this.setDetail(null)
        if (!ok) {
          this.lastError ??= '未找到音频解码器 ffmpeg，自动安装失败（可手动安装后重试：macOS 执行 brew install ffmpeg）'
          resolve(false)
          return
        }
        const source = this.resolveImageioFfmpeg(pythonPath)
        if (!source) {
          this.lastError = '音频解码器 ffmpeg 安装完成但无法定位二进制'
          resolve(false)
          return
        }
        if (!this.writeFfmpegShim(source, shimPath)) {
          this.lastError = '音频解码器 ffmpeg 无法部署到服务 PATH'
          resolve(false)
          return
        }
        this.ffmpegDirectory = shimDirectory
        console.info(`[nxcore-asr] ffmpeg provisioned at ${source}`)
        resolve(true)
      }
      const pip = spawn(
        pythonPath,
        ['-m', 'pip', 'install', '--disable-pip-version-check', 'imageio-ffmpeg', '-i', this.pipIndex()],
        { cwd: this.dataDirectory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      pip.stdin.end()
      const forward = (stream: NodeJS.ReadableStream): void => {
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => { process.stdout.write(`[nxcore-asr-ffmpeg] ${chunk}`) })
      }
      forward(pip.stdout)
      forward(pip.stderr)
      pip.on('error', (error) => {
        this.lastError = `音频解码器 ffmpeg 自动安装失败：${error.message}`
        finish(false)
      })
      pip.on('exit', (code) => {
        if (code !== 0) this.lastError = `音频解码器 ffmpeg 自动安装失败（pip code=${String(code)}）`
        finish(code === 0)
      })
    })
  }

  /** imageio-ffmpeg 把二进制放在 site-packages 下且带平台后缀名，这里问它拿
   *  真实路径（固定名 shim 由 writeFfmpegShim 负责）。 */
  private resolveImageioFfmpeg(pythonPath: string): string | null {
    const probe = spawnSync(
      pythonPath,
      ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    )
    if (probe.status !== 0) return null
    const lines = `${probe.stdout ?? ''}`.trim().split(/\r?\n/)
    const executable = lines[lines.length - 1]?.trim()
    return executable && existsSync(executable) ? executable : null
  }

  private ffmpegShimPath(): string {
    return join(this.dataDirectory, 'nxcore-asr-bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  }

  /** 在数据目录以固定名 `ffmpeg` 暴露来源二进制：服务的 subprocess 只按名字
   *  调用。POSIX 用软链；Windows 无符号链接权限时退化为复制。 */
  private writeFfmpegShim(source: string, shimPath: string): boolean {
    try {
      mkdirSync(dirname(shimPath), { recursive: true })
      try { unlinkSync(shimPath) } catch { /* 尚未创建 */ }
      try {
        symlinkSync(source, shimPath)
      } catch {
        copyFileSync(source, shimPath)
      }
      return true
    } catch (error) {
      console.warn('[nxcore-asr] ffmpeg shim failed |', error)
      return false
    }
  }

  /** uvicorn 子进程的最小环境：仅系统必需 + Python 编码 + 服务自身识别的
   *  env（config.yaml 覆盖与 OSS 变量）。Electron 主进程其余 env 不透传——
   *  全量继承曾致 uvicorn 加载期静默 exit 1（纯 Node 同参 spawn 正常）。 */
  private serviceEnvironment(): NodeJS.ProcessEnv {
    // ffmpeg 目录前置：服务只按名调用它，而 GUI 启动的应用 PATH 不含 Homebrew
    // 等常见安装位置（探到的绝对路径/自动安装的静态版都靠这里进 PATH）。
    const path = [this.ffmpegDirectory, process.env.PATH ?? '']
      .filter((entry): entry is string => Boolean(entry))
      .join(delimiter)
    const env: Record<string, string | undefined> = {
      PATH: path,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      // macOS/Linux：Python 与 modelscope 依赖 HOME（用户缓存/配置定位）。
      HOME: process.env.HOME,
      PYTHONIOENCODING: 'utf-8',
    }
    for (const key of ['ASR_DATABASE_URL', 'ASR_FAKE_ENGINE', 'ASR_OSS_ENDPOINT', 'ASR_OSS_BUCKET', 'ASR_OSS_ACCESS_KEY_ID', 'ASR_OSS_ACCESS_KEY_SECRET', 'ASR_OSS_UPLOAD_TTL_SECONDS']) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    return env as NodeJS.ProcessEnv
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
