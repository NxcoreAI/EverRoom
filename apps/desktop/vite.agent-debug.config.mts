// Agent 调试台 / 链路剖析看板专用 Vite 配置（独立 dev 页面，不参与 Electron/生产打包）。
//
// - root = apps/desktop，入口 debug/agent-debug.html（调试台）、debug/agent-dashboard.html（剖析看板）；
// - 自定义插件 agent-debug-gateway 在 Vite 内部中间件之前挂载：
//   · GET /@agent-debug/sources           → 列出网关来源 + 本机历史归档来源（不含 token）
//   · GET /@agent-debug/gateway/:id/*     → live 来源同源代理到 Gateway（Node 侧注入 Bearer token）；
//                                           archive 来源由本地只读归档读取器直接响应
//   manifest 每次请求按 mtime 重读：Desktop 重启后端口/token 变化会自动生效。
//   归档读取器在 dev server 生命周期内按目录缓存复用（索引也是按 mtime 缓存）。
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { IncomingMessage, ServerResponse } from 'node:http'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import {
  DebugArchiveSource,
  discoverArchiveSources,
  type AgentDebugArchivedFilter,
  type DiscoveredArchiveSource,
} from './debug/host/archive-source'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

/** 历史归档来源的展示前缀（页面会自己再追加「· 只读」）。 */
const ARCHIVE_LABEL_PREFIX = '历史归档'

interface GatewayManifest {
  pid: number
  baseUrl: string
  token: string
  startedAt: string
  version: string
}

interface ManifestCandidate {
  path: string
  label: string
  /** manifest 所属数据目录（`dirname(dirname(path))`），用于发现 `<dataDir>/agent-debug/*` 归档。 */
  dataDir: string
}

interface SourceRecord {
  id: string
  label: string
  baseUrl: string
  version: string
  /** 只在 Node 进程里使用，绝不回传给浏览器。 */
  token: string
  path: string
  /** manifest 里记录的 Gateway 进程号，用于存活探测。 */
  pid: number
}

interface ManifestCacheEntry {
  mtimeMs: number
  manifest: GatewayManifest | null
  warning: string | null
}

const manifestCache = new Map<string, ManifestCacheEntry>()

function everroomDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'EverOffice')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'EverOffice')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'EverOffice')
}

function nxcoreDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'NxCore')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'NxCore')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'NxCore')
}

/**
 * manifest 发现顺序：
 * 1. EVERROOM_AGENT_DEBUG_MANIFEST（POSIX 用 `:`、Windows 用 `;` 分隔）；
 * 2. NXCORE_DATA_DIR（缺省为 EverOffice 平台默认数据目录）下的主网关与补全网关；
 * 3. NxCore 独立网关默认数据目录（独立 `pnpm dev` 场景）；
 * 4. 仓库 .data/runtime/gateway.json。
 * 无效/缺失的候选直接跳过；`dataDir` 用于发现同目录下的历史归档。
 */
function resolveManifestCandidates(): ManifestCandidate[] {
  const candidates: ManifestCandidate[] = []
  const explicit = (process.env.EVERROOM_AGENT_DEBUG_MANIFEST ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of explicit) {
    const absolute = resolve(entry)
    candidates.push({
      path: absolute,
      label: `Manifest · ${basename(dirname(absolute))}`,
      dataDir: dirname(dirname(absolute)),
    })
  }

  const baseDataDir = process.env.NXCORE_DATA_DIR?.trim() || everroomDataDir()
  candidates.push({
    path: join(baseDataDir, 'runtime', 'gateway.json'),
    label: 'EverOffice 主网关',
    dataDir: baseDataDir,
  })
  candidates.push({
    path: join(baseDataDir, 'cursor-completion-service', 'runtime', 'gateway.json'),
    label: '补全服务网关',
    dataDir: join(baseDataDir, 'cursor-completion-service'),
  })

  const nxcoreDir = nxcoreDataDir()
  if (resolve(nxcoreDir) !== resolve(baseDataDir)) {
    candidates.push({ path: join(nxcoreDir, 'runtime', 'gateway.json'), label: 'NxCore 独立网关', dataDir: nxcoreDir })
  }

  candidates.push({ path: join(repoRoot, '.data', 'runtime', 'gateway.json'), label: '仓库本地网关', dataDir: join(repoRoot, '.data') })

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = resolve(candidate.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseManifest(raw: string): GatewayManifest | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const manifest = value as Partial<GatewayManifest>
  if (typeof manifest.pid !== 'number' || !Number.isInteger(manifest.pid)) return null
  if (typeof manifest.baseUrl !== 'string' || !/^https?:\/\//.test(manifest.baseUrl)) return null
  if (typeof manifest.token !== 'string' || manifest.token.length === 0) return null
  if (typeof manifest.startedAt !== 'string') return null
  if (typeof manifest.version !== 'string') return null
  return {
    pid: manifest.pid,
    baseUrl: manifest.baseUrl.replace(/\/+$/, ''),
    token: manifest.token,
    startedAt: manifest.startedAt,
    version: manifest.version,
  }
}

/** 每次请求按 mtime 判断是否要重读 manifest（Runtime 重启会换端口/token）。 */
async function readManifest(candidatePath: string): Promise<ManifestCacheEntry> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(candidatePath)).mtimeMs
  } catch {
    manifestCache.delete(candidatePath)
    return { mtimeMs: 0, manifest: null, warning: null }
  }
  const cached = manifestCache.get(candidatePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached

  let entry: ManifestCacheEntry
  try {
    const raw = await readFile(candidatePath, 'utf8')
    const manifest = parseManifest(raw)
    entry = {
      mtimeMs,
      manifest,
      warning: manifest ? null : `${candidatePath} 不是有效的 Gateway runtime manifest（缺少 pid/baseUrl/token/startedAt/version）`,
    }
  } catch (error) {
    entry = {
      mtimeMs,
      manifest: null,
      warning: `${candidatePath} 读取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  manifestCache.set(candidatePath, entry)
  return entry
}

async function collectSources(candidates: ManifestCandidate[]): Promise<{ sources: SourceRecord[]; warnings: string[] }> {
  const sources: SourceRecord[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    const entry = await readManifest(candidate.path)
    if (entry.warning) warnings.push(entry.warning)
    if (!entry.manifest) continue
    sources.push({
      id: createHash('sha1').update(resolve(candidate.path)).digest('hex').slice(0, 12),
      label: candidate.label,
      baseUrl: entry.manifest.baseUrl,
      version: entry.manifest.version,
      token: entry.manifest.token,
      path: candidate.path,
      pid: entry.manifest.pid,
    })
  }
  return { sources, warnings }
}

/**
 * 发现所有 manifest 候选 dataDir 下的历史归档来源：
 * 同一归档目录只出现一次，按最新 run 时间倒序（§2.2）。
 */
function collectArchiveSources(
  candidates: ManifestCandidate[],
  sourceFor: (dir: string) => DebugArchiveSource,
): DiscoveredArchiveSource[] {
  const seen = new Set<string>()
  const discovered: DiscoveredArchiveSource[] = []
  for (const candidate of candidates) {
    if (!candidate.dataDir) continue
    for (const entry of discoverArchiveSources(candidate.dataDir, ARCHIVE_LABEL_PREFIX, sourceFor)) {
      if (seen.has(entry.dir)) continue
      seen.add(entry.dir)
      // label 已由读取器按目录语义名生成（main → 主网关、cursor-completion → 补全服务）。
      discovered.push(entry)
    }
  }
  return discovered.sort((left, right) => {
    const leftAt = left.latestStartedAt ? Date.parse(left.latestStartedAt) : Number.NaN
    const rightAt = right.latestStartedAt ? Date.parse(right.latestStartedAt) : Number.NaN
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1
    return left.dir.localeCompare(right.dir)
  })
}

/**
 * `process.kill(pid, 0)` 存活探测：EPERM 说明进程存在但无权限，仍算存活。
 * 导出以便单测直接验证 stale pid（已退出）→ false、当前进程 → true。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  response.end(JSON.stringify(body))
}

function isGet(request: IncomingMessage): boolean {
  return request.method === 'GET'
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: 'method_not_allowed', message: '调试代理只支持 GET' }, { allow: 'GET' })
}

function invalidQuery(response: ServerResponse, message: string): void {
  sendJson(response, 400, { error: 'invalid_query', message })
}

/**
 * 解析整数查询参数（与 Gateway typebox 校验一致）：缺省用 `fallback`，
 * 非法（非整数 / 越界 / 空串）返回 null 由调用方回 400。
 */
function parseIntegerParam(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) return null
  return value
}

/** 查询解析结果：失败时带 400 的 message，成功时带校验后的参数值。 */
export type ArchiveQueryParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

export interface ArchiveSnapshotQuery {
  runs: number
  archived: AgentDebugArchivedFilter
}

/** `snapshot?runs=&archived=` 校验（与 Gateway typebox 语义一致：空串/非法值/越界都 400）。 */
export function parseArchiveSnapshotQuery(searchParams: URLSearchParams): ArchiveQueryParseResult<ArchiveSnapshotQuery> {
  const runs = parseIntegerParam(searchParams.get('runs'), 1, 300, 150)
  if (runs === null) return { ok: false, message: 'runs 必须是 1–300 的整数' }
  const archived = searchParams.get('archived') ?? 'include'
  if (archived !== 'include' && archived !== 'only' && archived !== 'exclude') {
    return { ok: false, message: 'archived 必须是 include / only / exclude' }
  }
  return { ok: true, value: { runs, archived } }
}

export interface ArchiveEventsQuery {
  afterSeq: number
  limit: number
}

/** `events?afterSeq=&limit=` 校验（与 Gateway typebox 语义一致：空串/非法值/越界都 400）。 */
export function parseArchiveEventsQuery(searchParams: URLSearchParams): ArchiveQueryParseResult<ArchiveEventsQuery> {
  const afterSeq = parseIntegerParam(searchParams.get('afterSeq'), 0, Number.MAX_SAFE_INTEGER, 0)
  if (afterSeq === null) return { ok: false, message: 'afterSeq 必须是 >= 0 的整数' }
  const limit = parseIntegerParam(searchParams.get('limit'), 1, 5_000, 1_000)
  if (limit === null) return { ok: false, message: 'limit 必须是 1–5000 的整数' }
  return { ok: true, value: { afterSeq, limit } }
}

/**
 * archive 来源上的代理端点（§2.3）：本地读归档，不经过 Gateway。
 * 只支持 snapshot / runs/:runId/events，其它路径 404；参数非法 400、未知 run 404。
 */
function handleArchiveProxy(
  response: ServerResponse,
  source: DebugArchiveSource,
  restPath: string,
  searchParams: URLSearchParams,
): void {
  if (restPath === '/v1/agent-debug/snapshot') {
    const parsed = parseArchiveSnapshotQuery(searchParams)
    if (!parsed.ok) {
      invalidQuery(response, parsed.message)
      return
    }
    sendJson(response, 200, source.snapshot(parsed.value.runs, parsed.value.archived))
    return
  }

  const eventsMatch = /^\/v1\/agent-debug\/runs\/([^/]+)\/events$/.exec(restPath)
  if (eventsMatch) {
    let runId: string
    try {
      runId = decodeURIComponent(eventsMatch[1] ?? '')
    } catch {
      invalidQuery(response, 'runId 不是合法的 URL 编码')
      return
    }
    if (runId.length === 0 || runId.length > 200) {
      invalidQuery(response, 'runId 长度必须是 1–200')
      return
    }
    const parsed = parseArchiveEventsQuery(searchParams)
    if (!parsed.ok) {
      invalidQuery(response, parsed.message)
      return
    }
    const run = source.getRun(runId)
    const page = run ? source.readEvents(runId, parsed.value.afterSeq, parsed.value.limit) : null
    if (!run || !page) {
      sendJson(response, 404, { error: 'not_found', message: `归档里没有这条 run：${runId}` })
      return
    }
    sendJson(response, 200, { run, events: page.events, latestSeq: page.latestSeq })
    return
  }

  sendJson(response, 404, { error: 'not_found', message: `归档来源不支持该接口：${restPath}` })
}

async function handleAgentDebugRequest(
  request: IncomingMessage,
  response: ServerResponse,
  candidates: ManifestCandidate[],
  archiveSourceFor: (dir: string) => DebugArchiveSource,
): Promise<void> {
  const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = parsedUrl.pathname

  if (pathname === '/@agent-debug/sources') {
    if (!isGet(request)) {
      methodNotAllowed(response)
      return
    }
    const { sources, warnings } = await collectSources(candidates)
    const archiveSources = collectArchiveSources(candidates, archiveSourceFor)
    // HTTP header 只允许 latin1：先 encodeURIComponent，页面侧 decode 后展示。
    const warningHeader = warnings.length > 0
      ? encodeURIComponent(warnings.join('；').slice(0, 800))
      : null
    const payload = [
      // live 来源：manifest 发现顺序在前；available = manifest.pid 是否还活着。
      ...sources.map(({ id, label, baseUrl, version, pid }) => ({
        id,
        label,
        baseUrl,
        version,
        backend: 'live' as const,
        available: isProcessAlive(pid),
      })),
      // archive 来源：始终可用（只要求归档目录可读），按最新 run 时间倒序。
      ...archiveSources.map((entry) => entry.source.descriptor(entry.label)),
    ]
    sendJson(response, 200, payload, warningHeader ? { 'x-agent-debug-warning': warningHeader } : {})
    return
  }

  const proxyMatch = /^\/@agent-debug\/gateway\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!proxyMatch) {
    sendJson(response, 404, { error: 'not_found', message: `未知调试页接口：${pathname}` })
    return
  }
  if (!isGet(request)) {
    methodNotAllowed(response)
    return
  }

  const sourceId = decodeURIComponent(proxyMatch[1] ?? '')
  const restPath = proxyMatch[2] ?? '/'
  const { sources } = await collectSources(candidates)
  const archiveSources = collectArchiveSources(candidates, archiveSourceFor)

  // archive 来源优先：命中就本地读归档（不依赖 Gateway）。
  const archiveSource = archiveSources.find((entry) => entry.id === sourceId)
  if (archiveSource) {
    handleArchiveProxy(response, archiveSource.source, restPath, parsedUrl.searchParams)
    return
  }

  if (sources.length === 0 && archiveSources.length === 0) {
    sendJson(response, 503, {
      error: 'no_manifest',
      message: '未发现 Gateway runtime manifest：请先启动 EverOffice，或设置 EVERROOM_AGENT_DEBUG_MANIFEST 指向 runtime/gateway.json',
    })
    return
  }
  const source = sources.find((entry) => entry.id === sourceId)
  if (!source) {
    sendJson(response, 404, {
      error: 'unknown_source',
      message: `未知网关来源：${sourceId}（已发现 ${sources.length} 个 live / ${archiveSources.length} 个 archive 来源，可重新加载 sources）`,
    })
    return
  }

  const targetUrl = `${source.baseUrl}${restPath}${parsedUrl.search}`
  let upstream: globalThis.Response
  try {
    upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${source.token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    sendJson(response, 502, {
      error: 'gateway_unreachable',
      message: `无法连接 Gateway ${source.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  const body = Buffer.from(await upstream.arrayBuffer())
  if (response.headersSent) return
  response.statusCode = upstream.status
  response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/** Vite 插件：必须在 Vite 内部中间件之前挂载（configureServer 里直接 use）。 */
function agentDebugGatewayPlugin(): Plugin {
  return {
    name: 'agent-debug-gateway',
    configureServer(server) {
      const candidates = resolveManifestCandidates()
      // 归档读取器按目录缓存：dev server 生命周期内复用，避免每个请求重新解析 1.4MB 索引。
      const archiveSourceCache = new Map<string, DebugArchiveSource>()
      const archiveSourceFor = (dir: string): DebugArchiveSource => {
        const key = resolve(dir)
        let source = archiveSourceCache.get(key)
        if (!source) {
          source = new DebugArchiveSource(key)
          archiveSourceCache.set(key, source)
        }
        return source
      }
      server.middlewares.use((request, response, next) => {
        if (!(request.url ?? '').startsWith('/@agent-debug/')) {
          next()
          return
        }
        void handleAgentDebugRequest(request, response, candidates, archiveSourceFor).catch((error: unknown) => {
          sendJson(response, 500, {
            error: 'agent_debug_proxy_error',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      })
    },
  }
}

export default defineConfig({
  root: here,
  // 独立依赖缓存，避免和 electron-vite / 其它 mock 页面共用缓存互相覆盖。
  cacheDir: resolve(here, 'node_modules/.vite-agent-debug'),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.AGENT_DEBUG_PORT ?? 5199),
    strictPort: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve(here, 'src/renderer/src') },
  },
  plugins: [react(), agentDebugGatewayPlugin()],
  build: {
    // 与 Electron 的 out/renderer 隔离，方便单独 `vite build` 验证调试页。
    outDir: resolve(here, 'out/agent-debug'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'agent-debug': resolve(here, 'debug/agent-debug.html'),
        'agent-dashboard': resolve(here, 'debug/agent-dashboard.html'),
      },
    },
  },
})
