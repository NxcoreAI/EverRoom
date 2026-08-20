import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { app, session } from 'electron'

/**
 * 托管 Nango(gateway/src/modules/connector 子模块)server 的子进程管理器。
 *
 * 三种工作模式(与 MemoryCoreSupervisor 一致):
 * 1. 外部模式:NXCORE_NANGO_URL 指向非默认地址,或 NXCORE_NANGO_MANAGED=false —— 不托管。
 * 2. 复用模式:127.0.0.1:3003 已有健康实例 —— 直接复用。
 * 3. 托管模式:在子模块目录里构建并拉起 nango server(NANGO_EMBEDDED_DB,无需 Docker)。
 *
 * 注意:secret key 存在于 Nango 数据库里(嵌入式 DB 持久化),沿用进程环境里的
 * NXCORE_NANGO_SECRET,这里只负责把 server 拉起来并注入 URL。
 */
export interface NangoConnection {
  baseUrl: string
  managed: boolean
}

const NANGO_PORT = 3003
const CONNECT_UI_PORT = 3009
const BASE_URL = `http://127.0.0.1:${NANGO_PORT}`
const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 5_000

function managedEncryptionKey(): string | undefined {
  if (process.env.NANGO_ENCRYPTION_KEY || process.env.NANGO_ENCRYPTION_KEY_WRAPPED) {
    return process.env.NANGO_ENCRYPTION_KEY
  }
  const secret = process.env.NXCORE_NANGO_SECRET?.trim()
  return secret
    ? createHash('sha256').update('everroom:nango:encryption:v1\0').update(secret).digest('base64')
    : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 是否为指向本机 NANGO_PORT 的回环地址(localhost/127.0.0.1/::1 写法都算)。 */
function isLoopbackNangoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.port === String(NANGO_PORT) &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function probe(): Promise<boolean> {
  return probeUrl(`${BASE_URL}/health`)
}

/**
 * Nango 的 keystore 加密 key(connect session 等 private key 的加密前置)。
 * 这个版本的 Nango 从环境变量取 DEK,缺失时创建 connect session 直接 500。
 * 生成后持久化复用 —— key 换了历史加密数据(OAuth token 等)就解不开了。
 * key 与 embedded DB 同放 userData/nango:清应用数据时两者一起消亡,
 * 避免旧库配新 key 的 "Rotation of NANGO_ENCRYPTION_KEY is not supported" 崩溃。
 */
function nangoDataDirectory(): string {
  return join(app.getPath('userData'), 'nango')
}

function nangoEncryptionKey(): string {
  const keyPath = join(nangoDataDirectory(), 'encryption-key')
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf8').trim()
    if (existing) return existing
  }
  mkdirSync(nangoDataDirectory(), { recursive: true })
  const generated = randomBytes(32).toString('base64')
  writeFileSync(keyPath, generated + '\n', { mode: 0o600 })
  return generated
}

/** 从 Chromium 代理规则("PROXY 127.0.0.1:7897; DIRECT" 形式)提取首个 http(s) 代理 URL。 */
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

/**
 * OAuth token 换取等出站请求走的代理(与 open-connector-supervisor 同款策略):
 * 显式 HTTPS_PROXY/HTTP_PROXY 优先,否则用 Electron 会话探测系统代理。
 * Nango(中国网络补丁)经 NANGO_OUTBOUND_PROXY/HTTPS_PROXY 认这个代理;
 * 本机地址进 NO_PROXY,embedded postgres/自身 API 不绕代理。
 */
async function nangoProxyEnvironment(): Promise<Record<string, string>> {
  const explicitHttps = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim()
  const explicitHttp = process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim()
  let proxyUrl = explicitHttps || explicitHttp || ''
  if (!proxyUrl) {
    try {
      proxyUrl = proxyUrlFromRules(await session.defaultSession.resolveProxy('https://oauth2.googleapis.com')) ?? ''
    } catch {
      return {}
    }
  }
  if (!proxyUrl) return {}
  console.info(`[nango] outbound proxy for provider OAuth: ${proxyUrl}`)
  const noProxyEntries = new Set(
    (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  )
  for (const loopback of ['127.0.0.1', 'localhost', '::1']) noProxyEntries.add(loopback)
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NANGO_OUTBOUND_PROXY: proxyUrl,
    NO_PROXY: [...noProxyEntries].join(','),
  }
}

export class NangoSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private connectUiChild: ChildProcessWithoutNullStreams | null = null
  private connection: NangoConnection | null = null
  private stopping = false
  private lastError: string | null = null

  async start(): Promise<NangoConnection | null> {
    if (this.connection) return this.connection

    if (process.env.NXCORE_NANGO_MANAGED === 'false') return null
    const externalBaseUrl = process.env.NXCORE_NANGO_URL?.trim()
    if (externalBaseUrl && !isLoopbackNangoUrl(externalBaseUrl)) return null

    // ponytail: 打包形态尚未把 nango 子模块打进 extraResources,先只支持 dev 托管。
    if (app.isPackaged) throw new Error('Nango 托管目前仅支持开发模式')
    const nangoDirectory = join(app.getAppPath(), '..', 'gateway', 'src', 'modules', 'connector')

    // 复用已在运行的实例(用户手动启动的 Nango 等)。
    if (await probe()) {
      this.connection = { baseUrl: BASE_URL, managed: false }
      console.info(`[nango] reusing existing instance at ${BASE_URL}`)
      await this.startConnectUi(nangoDirectory)
      return this.connection
    }

    if (!existsSync(join(nangoDirectory, 'package.json'))) {
      throw new Error(`Nango 子模块不存在: ${nangoDirectory}（试试 git submodule update --init）`)
    }
    const tsxCli = join(nangoDirectory, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (!existsSync(tsxCli)) {
      throw new Error('Nango 依赖未安装:请在 apps/gateway/src/modules/connector 下执行 npm install')
    }
    // 同仓包(shared/utils/...)以 dist 解析,先做一次性全量构建再拉起 server。
    // ponytail: 每次启动都全量 ts-build 较慢,增量缓存(tsc -b)会兜底;需要快时可换 esbuild。
    const build = await this.run(nangoDirectory, ['run', 'ts-build'], 300_000)
    if (build !== 0) throw new Error(`Nango 构建失败（exit=${build}）`)

    // logo 等静态资源由 server 从 webapp/dist 托管(NANGO_PUBLIC_SERVER_URL 指向 3003);
    // webapp 本体不跑,把 public/images 复制进 dist 即可让 logo 可访问。
    const webappImages = join(nangoDirectory, 'packages', 'webapp', 'public', 'images')
    const webappDistImages = join(nangoDirectory, 'packages', 'webapp', 'dist', 'images')
    if (existsSync(webappImages) && !existsSync(join(webappDistImages, 'template-logos'))) {
      cpSync(webappImages, webappDistImages, { recursive: true })
    }

    const serverDirectory = join(nangoDirectory, 'packages', 'server')
    const child = spawn(
      process.execPath,
      [tsxCli, '-r', 'dotenv/config', 'lib/server.ts'],
      {
        cwd: serverDirectory,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DOTENV_CONFIG_PATH: join(nangoDirectory, '.env'),
          FLAG_AUTH_ENABLED: 'false',
          NANGO_EMBEDDED_DB: 'true',
          // ponytail: embedded postgres 固定 5433,但 utils 包的 zod env 默认 5432 且不感知
          // NANGO_EMBEDDED_DB(records 等包用它拼连接串),必须显式指定端口避免分叉。
          NANGO_DB_PORT: '5433',
          // ponytail: embedded DB 收进 userData/nango(默认落在仓库 server 目录里,
          // 清应用数据/换仓库都会让 DB 与加密 key 失配)。
          NANGO_EMBEDDED_DB_DIR: join(nangoDataDirectory(), 'embedded-postgres'),
          // ponytail: OAuth 回调直连本机(默认会用 redirectmeto.com 跳板包一层,
          // Google 侧需登记跳板 URI;直连时登记 http://localhost:3003/oauth/callback 即可)。
          NANGO_SERVER_URL: `http://localhost:${NANGO_PORT}`,
          // ponytail: 关闭 dashboard 的 session 鉴权(自托管无鉴权模式),gateway 的
          // nango-bootstrap 依赖此模式经 /api/v1/environment/api-keys 自举 API key。
          // 公开 API 仍走 secretKeyAuth,实例只监听回环,风险可控。
          FLAG_AUTH_ENABLED: 'false',
          // ponytail: keystore 的 DEK 缺失时创建 connect session(/connect/sessions)
          // 会因无法加密 private key 而 500;key 持久化在 userData,重启不变。
          NANGO_ENCRYPTION_KEY: nangoEncryptionKey(),
          // ponytail: OAuth token 交换等出站请求走系统代理(Node 不读 macOS 系统代理,
          // 直连 Google 在无代理网络下会 ETIMEDOUT 卡死授权回调)。
          ...(await nangoProxyEnvironment()),
          SERVER_PORT: String(NANGO_PORT),
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
    child.stdout.on('data', (chunk: string) => process.stdout.write(`[nango] ${chunk}`))
    child.stderr.on('data', (chunk: string) => process.stderr.write(`[nango] ${chunk}`))
    child.on('exit', (code, signal) => {
      this.child = null
      if (!this.stopping) {
        this.lastError = `Nango 进程已退出（code=${String(code)}, signal=${String(signal)}）`
        console.error(this.lastError)
      }
    })

    try {
      await this.waitUntilReady(child)
      this.connection = { baseUrl: BASE_URL, managed: true }
      console.info(`[nango] managed instance ready at ${BASE_URL} (pid=${child.pid})`)
    } catch (error) {
      this.killChild(child, 'SIGTERM')
      this.child = null
      this.lastError = error instanceof Error ? error.message : 'Nango 启动失败'
      throw error
    }

    await this.startConnectUi(nangoDirectory)
    return this.connection
  }

  /** 授权页所需的 Connect UI(静态站,默认 3009)。失败不阻断,授权链接会打不开但 server 正常。 */
  private async startConnectUi(nangoDirectory: string): Promise<void> {
    if (await probeUrl(`http://127.0.0.1:${CONNECT_UI_PORT}`)) {
      console.info(`[nango] reusing existing Connect UI at :${CONNECT_UI_PORT}`)
      return
    }
    const connectUiDirectory = join(nangoDirectory, 'packages', 'connect-ui')
    try {
      if (!existsSync(join(connectUiDirectory, 'dist', 'index.html'))) {
        const build = await this.run(nangoDirectory, ['run', 'build', '-w', '@nangohq/connect-ui'], 300_000)
        if (build !== 0) throw new Error(`Connect UI 构建失败（exit=${build}）`)
      }
      const child = spawn(
        process.execPath,
        [
          join(nangoDirectory, 'node_modules', 'serve', 'build', 'main.js'),
          '-s',
          'dist',
          '-p',
          String(CONNECT_UI_PORT),
          '--no-clipboard',
        ],
        {
          cwd: connectUiDirectory,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      this.connectUiChild = child
      child.stdin.end()
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => process.stdout.write(`[nango-connect-ui] ${chunk}`))
      child.stderr.on('data', (chunk: string) => process.stderr.write(`[nango-connect-ui] ${chunk}`))
      child.on('exit', () => {
        this.connectUiChild = null
      })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && (await probeUrl(`http://127.0.0.1:${CONNECT_UI_PORT}`)) === false) {
        if (child.exitCode !== null) break
        await delay(300)
      }
      console.info(`[nango] Connect UI ready at :${CONNECT_UI_PORT} (pid=${child.pid})`)
    } catch (error) {
      console.warn('[nango] Connect UI 启动失败,第三方授权页将不可用:', error instanceof Error ? error.message : error)
    }
  }

  getConnection(): NangoConnection | null {
    return this.connection
  }

  async shutdown(): Promise<void> {
    const child = this.child
    const connectUi = this.connectUiChild
    this.connection = null
    this.stopping = true
    connectUi?.kill('SIGTERM')
    this.connectUiChild = null
    if (!child) return
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.killChild(child, 'SIGKILL')
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      if (!this.killChild(child, 'SIGTERM')) resolve()
    })
    this.child = null
    this.lastError = null
  }

  private async waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Nango server exited during startup with code ${String(child.exitCode)}`)
      }
      if (await probe()) return
      await delay(200)
    }
    throw new Error(`Nango server did not become ready within ${STARTUP_TIMEOUT_MS}ms`)
  }

  private run(cwd: string, args: string[], timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn('npm', args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`命令超时: npm ${args.join(' ')}`))
      }, timeoutMs)
      child.stdout.on('data', (chunk: string) => process.stdout.write(`[nango-build] ${chunk}`))
      child.stderr.on('data', (chunk: string) => process.stderr.write(`[nango-build] ${chunk}`))
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })
  }

  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    return child.kill(signal)
  }
}
