/**
 * 调试页到 Gateway 的 HTTP 客户端：全部走同源 Vite 代理 `/@agent-debug/*`，
 * Bearer token 只存在于 dev server 的 Node 进程里。
 */
import type { AgentDebugRunEvents, AgentDebugSnapshot } from '@nxcore/agent-contract'

import { snapshotSearchParams, type SnapshotQuery } from './history'

/** 数据来源类型：live = 代理到 Gateway；archive = dev server 直读磁盘归档（只读，无需 EverRoom 运行）。 */
export type DebugSourceBackend = 'live' | 'archive'

export interface DebugSource {
  id: string
  label: string
  baseUrl: string
  version: string
  /** 缺省 `live`（旧版 dev server 不返回该字段）。 */
  backend: DebugSourceBackend
  /** live 来源：manifest 里的 Gateway 进程是否还活着；archive 来源恒可用。缺省 true。 */
  available: boolean
  /** archive 来源的归档目录绝对路径（仅展示）；live / 未知为 null。 */
  archiveDir: string | null
  /** archive 来源索引里的 run 条数；live 为 0。 */
  runCount: number
  /** archive 来源最新一条 run 的开始时间；未知为 null。 */
  latestStartedAt: string | null
}

export interface SourcesResult {
  sources: DebugSource[]
  /** manifest 缺失/无效时 dev server 通过响应头带回来的可读提示（无则 null）。 */
  warning: string | null
}

const DEBUG_ROOT = '/@agent-debug'

function errorDetail(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const message = record.message
    if (typeof message === 'string' && message.trim()) return message
    const error = record.error
    if (typeof error === 'string' && error.trim()) return error
  }
  return ''
}

async function responseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const body: unknown = await response.json()
    detail = errorDetail(body)
  } catch {
    // 非 JSON 响应（例如上游返回 HTML 错误页）只保留状态码。
  }
  return new Error(`${response.status} ${response.statusText}${detail ? ` · ${detail}` : ''}`)
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await responseError(response)
  return (await response.json()) as T
}

export function gatewayBase(sourceId: string): string {
  return `${DEBUG_ROOT}/gateway/${encodeURIComponent(sourceId)}`
}

/** 单条 sources 响应解析：新字段一律按缺省值兼容旧版 dev server。 */
function parseSource(item: unknown): DebugSource[] {
  if (!item || typeof item !== 'object') return []
  const record = item as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.baseUrl !== 'string') return []
  const runCount = typeof record.runCount === 'number' && Number.isFinite(record.runCount) && record.runCount > 0
    ? Math.trunc(record.runCount)
    : 0
  return [{
    id: record.id,
    label: typeof record.label === 'string' && record.label ? record.label : record.id,
    baseUrl: record.baseUrl,
    version: typeof record.version === 'string' ? record.version : '',
    backend: record.backend === 'archive' ? 'archive' : 'live',
    available: record.available !== false,
    archiveDir: typeof record.archiveDir === 'string' && record.archiveDir ? record.archiveDir : null,
    runCount,
    latestStartedAt: typeof record.latestStartedAt === 'string' && record.latestStartedAt
      ? record.latestStartedAt
      : null,
  }]
}

export async function loadSources(): Promise<SourcesResult> {
  const response = await fetch(`${DEBUG_ROOT}/sources`, { cache: 'no-store' })
  if (!response.ok) throw await responseError(response)
  const data: unknown = await response.json()
  const sources = Array.isArray(data) ? data.flatMap(parseSource) : []
  const rawWarning = response.headers.get('x-agent-debug-warning')
  let warning: string | null = null
  if (rawWarning) {
    try {
      warning = decodeURIComponent(rawWarning)
    } catch {
      warning = rawWarning
    }
  }
  return { sources, warning }
}

/**
 * 拉取快照。`query.archived` 控制归档范围：include（默认，本次 + 历史）/
 * exclude（仅本次进程）/ only（仅历史）；历史模式由调用方传 `runs: 300`。
 */
export async function loadSnapshot(sourceId: string, query: SnapshotQuery = {}): Promise<AgentDebugSnapshot> {
  const response = await fetch(
    `${gatewayBase(sourceId)}/v1/agent-debug/snapshot?${snapshotSearchParams(query)}`,
    { cache: 'no-store' },
  )
  return readJson<AgentDebugSnapshot>(response)
}

export async function loadRunEvents(
  sourceId: string,
  runId: string,
  afterSeq: number,
  limit = 1000,
): Promise<AgentDebugRunEvents> {
  const query = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit) })
  const response = await fetch(
    `${gatewayBase(sourceId)}/v1/agent-debug/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
    { cache: 'no-store' },
  )
  return readJson<AgentDebugRunEvents>(response)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
