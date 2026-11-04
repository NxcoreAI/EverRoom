/**
 * Agent 调试台离线归档读取器（Vite dev server 侧，**只读**）。
 *
 * Gateway 运行期间会把终态 run 写到
 * `<dataDir>/agent-debug/<source>/{index.json,runs/<YYYYMMDD>/<runId>.ndjson}`
 * （见 gateway 的 `agent-debug/archive.ts`）。EverRoom/Gateway 没起来时，调试页
 * 通过本模块直接读这些文件，返回与 Gateway 相同形状的 `AgentDebugSnapshot` /
 * `AgentDebugRunEvents`，让页面无需任何改动就能回看历史。
 *
 * 约束：
 * - 只读：索引缺失/损坏时在内存里扫 `runs/**\/*.ndjson` 首行重建，**绝不写** index.json
 *   （Gateway 可能同时在写这个文件）；
 * - `index.json`（1.4MB / 586 runs 量级）按 mtime 缓存，dev server 生命周期内复用；
 * - 索引条目里的相对路径必须 resolve 后仍落在归档目录内（防目录穿越）；
 * - 事件坏行（进程中断留下的半行 / 磁盘损坏）跳过，不影响其余事件。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type {
  AgentDebugAgent,
  AgentDebugArchiveInfo,
  AgentDebugEvent,
  AgentDebugRun,
  AgentDebugSnapshot,
} from '@nxcore/agent-contract'

export const ARCHIVE_INDEX_FILE = 'index.json'
export const ARCHIVE_RUNS_DIR = 'runs'
export const ARCHIVE_INDEX_VERSION = 1

/** 与 Gateway 一致的 `archived` 过滤语义（归档来源没有「本次」进程 run）。 */
export type AgentDebugArchivedFilter = 'include' | 'only' | 'exclude'

const ERROR_RUN_STATUSES = new Set<string>(['failed', 'interrupted', 'timed_out'])

/** 重建索引时每个 ndjson 最多读取的首行字节数（防御超长坏行）。 */
const FIRST_LINE_MAX_BYTES = 1024 * 1024

/** index.json 里的一条归档记录。 */
export interface ArchiveIndexEntry {
  /** 归档时的终态 run 元数据（不含 origin / sessionTitle）。 */
  run: AgentDebugRun
  /** 相对归档根目录的 ndjson 路径，始终 `/` 分隔。 */
  file: string
  bytes: number
}

export interface DebugArchiveEventPage {
  events: AgentDebugEvent[]
  latestSeq: number
}

/** `/@agent-debug/sources` 里 archive 来源的展示字段（不含 token / 内部实例）。 */
export interface ArchiveSourceDescriptor {
  id: string
  label: string
  baseUrl: ''
  version: ''
  backend: 'archive'
  available: true
  archiveDir: string
  runCount: number
  latestStartedAt: string | null
}

/** 目录发现结果：展示字段 + 复用的读取器实例。 */
export interface DiscoveredArchiveSource {
  id: string
  label: string
  /** 归档根目录绝对路径（resolve 后）。 */
  dir: string
  runCount: number
  latestStartedAt: string | null
  source: DebugArchiveSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归档 run 的最小形状校验（与 Gateway archive.ts 保持一致）。 */
export function readRunRecord(value: unknown): AgentDebugRun | null {
  if (!isRecord(value)) return null
  if (typeof value.runId !== 'string' || value.runId.length === 0) return null
  if (typeof value.startedAt !== 'string' || value.startedAt.length === 0) return null
  if (typeof value.status !== 'string' || value.status.length === 0) return null
  // 归档文件由 Gateway 写入：结构可信，最小校验后按契约类型使用。
  return value as unknown as AgentDebugRun
}

function readEventRecord(value: unknown): AgentDebugEvent | null {
  if (!isRecord(value)) return null
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return null
  if (typeof value.type !== 'string' || typeof value.occurredAt !== 'string') return null
  return value as unknown as AgentDebugEvent
}

function readIndexEntry(value: unknown): ArchiveIndexEntry | null {
  if (!isRecord(value)) return null
  const run = readRunRecord(value.run)
  if (!run) return null
  if (typeof value.file !== 'string' || value.file.length === 0) return null
  const bytes = typeof value.bytes === 'number' && Number.isFinite(value.bytes) ? value.bytes : 0
  return { run, file: value.file, bytes }
}

/**
 * 解析 index.json：`version === 1` 且每条记录形状合法才算可用；
 * 返回 null 表示索引缺失/损坏，调用方应扫描 ndjson 首行重建。
 * 任意一条残缺都视为整体损坏（避免半坏索引丢历史）。
 */
export function parseIndex(raw: string): ArchiveIndexEntry[] | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== ARCHIVE_INDEX_VERSION || !Array.isArray(value.runs)) return null
  const entries: ArchiveIndexEntry[] = []
  for (const item of value.runs) {
    const entry = readIndexEntry(item)
    if (!entry) return null
    entries.push(entry)
  }
  return entries
}

/** 解析 ndjson 首行里的 run 记录（`{ kind: "run", run }`）。 */
export function parseRunLine(line: string): AgentDebugRun | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(value) || value.kind !== 'run') return null
  return readRunRecord(value.run)
}

/** 解析 ndjson 里的一行事件（`{ kind: "event", event }`）；坏行返回 null。 */
export function parseEventLine(line: string): AgentDebugEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(value) || value.kind !== 'event') return null
  return readEventRecord(value.event)
}

/** 把索引/索引里的相对路径安全地解析到归档目录内（防止损坏索引指向目录外）。 */
export function resolveArchivePath(root: string, file: string): string | null {
  const rootDir = resolve(root)
  const absolute = resolve(rootDir, file)
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`
  return absolute.startsWith(rootWithSep) ? absolute : null
}

/** archive 来源 id：`archive-` + sha1(归档目录) 前 12 位（目录不变则跨重启稳定）。 */
export function archiveSourceId(dir: string): string {
  return `archive-${createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)}`
}

function mtimeMsOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 读取文件首行（只在重建索引时用，避免把几十 MB 的 ndjson 整个读进内存）。
 * 单行超过 {@link FIRST_LINE_MAX_BYTES} 时截断返回（JSON 解析会失败并跳过该文件）。
 */
function readFirstLineSync(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (total < FIRST_LINE_MAX_BYTES) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      const slice = buffer.subarray(0, read)
      const newline = slice.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(Buffer.from(slice.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(slice))
      total += read
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

interface IndexCache {
  /** index.json 的 mtime；null 表示文件缺失/不可读。 */
  indexMtimeMs: number | null
  /** 索引缺失/损坏时按 runs 目录重建：记录目录签名用于判断是否需要重扫；索引可用时为 null。 */
  rebuildSignature: string | null
  entries: ArchiveIndexEntry[]
}

/**
 * 只读归档读取器。
 *
 * - 构造时不读盘：首次访问时才解析索引（缺失/损坏时内存重建，不写盘）；
 * - `index.json` 按 mtime 缓存；重建结果按 runs 目录（含子目录）mtime 签名缓存；
 * - 所有异常都降级为空结果，绝不影响 dev server。
 */
export class DebugArchiveSource {
  /** 归档根目录（绝对路径）。 */
  readonly dir: string
  private cache: IndexCache | null = null

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  /** archive 来源 id（`archive-` + sha1 前 12 位）。 */
  get id(): string {
    return archiveSourceId(this.dir)
  }

  /** 归档概况。离线读取拿不到 Gateway 的保留配置：`retentionDays` 固定为 0（未知）。 */
  info(): AgentDebugArchiveInfo {
    const entries = this.loadIndex()
    let bytes = 0
    let oldestStartedAt: number | null = null
    for (const entry of entries) {
      bytes += entry.bytes
      const startedAt = Date.parse(entry.run.startedAt)
      if (Number.isFinite(startedAt) && (oldestStartedAt === null || startedAt < oldestStartedAt)) {
        oldestStartedAt = startedAt
      }
    }
    return {
      enabled: true,
      retentionDays: 0,
      runCount: entries.length,
      bytes,
      oldestStartedAt: oldestStartedAt === null ? null : new Date(oldestStartedAt).toISOString(),
    }
  }

  /** 索引里最新一条 run 的 startedAt；空归档为 null。 */
  latestStartedAt(): string | null {
    let latest = Number.NEGATIVE_INFINITY
    let value: string | null = null
    for (const entry of this.loadIndex()) {
      const startedAt = Date.parse(entry.run.startedAt)
      if (Number.isFinite(startedAt) && startedAt > latest) {
        latest = startedAt
        value = entry.run.startedAt
      }
    }
    return value
  }

  /**
   * 历史 run：按 startedAt 倒序、截断 `limit` 条；
   * 补 `origin: "archive"` 与 `sessionTitle: null`（离线不读业务库，占位字段始终存在）。
   */
  listRuns(limit: number, excludeRunIds?: ReadonlySet<string>): AgentDebugRun[] {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
    return this.loadIndex()
      .filter((entry) => !excludeRunIds?.has(entry.run.runId))
      .sort((left, right) => Date.parse(right.run.startedAt) - Date.parse(left.run.startedAt))
      .slice(0, max)
      .map((entry) => this.toArchiveRun(entry.run))
  }

  getRun(runId: string): AgentDebugRun | null {
    const entry = this.loadIndex().find((candidate) => candidate.run.runId === runId)
    return entry ? this.toArchiveRun(entry.run) : null
  }

  /**
   * 按需读取归档事件：`seq > afterSeq`、按 seq 升序、截断 `limit`；
   * `latestSeq` 为文件内最大 seq；坏行跳过。
   */
  readEvents(runId: string, afterSeq = 0, limit = 1_000): DebugArchiveEventPage | null {
    const entry = this.loadIndex().find((candidate) => candidate.run.runId === runId)
    if (!entry) return null
    const absoluteFile = resolveArchivePath(this.dir, entry.file)
    if (!absoluteFile) return null

    let content: string
    try {
      content = readFileSync(absoluteFile, 'utf8')
    } catch {
      return null
    }

    const events: AgentDebugEvent[] = []
    let latestSeq = 0
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
    for (const line of content.split('\n')) {
      const event = parseEventLine(line)
      if (!event) continue
      if (event.seq > latestSeq) latestSeq = event.seq
      if (event.seq > afterSeq && events.length < max) events.push(event)
    }
    return { events, latestSeq }
  }

  /**
   * 由归档 run 聚合 Agent 目录（§2.3）：
   * agentId 去重、名称/类型取该 Agent 最新一条 run；最新一条终态为
   * 失败/中断/超时则 `error`，否则 `idle`；`activeRunCount` 恒 0（归档只有终态 run）。
   */
  agents(): AgentDebugAgent[] {
    interface LatestRun {
      run: AgentDebugRun
      startedAt: number
    }
    const latest = new Map<string, LatestRun>()
    for (const entry of this.loadIndex()) {
      const startedAt = Date.parse(entry.run.startedAt)
      const current = latest.get(entry.run.agentId)
      if (!current || startedAt >= current.startedAt) latest.set(entry.run.agentId, { run: entry.run, startedAt })
    }
    return [...latest.entries()]
      .map(([id, { run }]): AgentDebugAgent => ({
        id,
        name: run.agentName || id,
        description: '',
        kind: run.agentKind,
        state: ERROR_RUN_STATUSES.has(run.status) ? 'error' : 'idle',
        activeRunCount: 0,
        lastRunAt: run.completedAt ?? run.startedAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  /**
   * 组装与 Gateway 同形状的快照。
   * `archived=exclude` 时 run 列表为空（归档来源没有「本次」进程 run）；
   * `include` / `only` 都返回归档 run（startedAt 倒序、截断 `runs` 条）。
   */
  snapshot(runs = 150, archived: AgentDebugArchivedFilter = 'include'): AgentDebugSnapshot {
    const limit = Number.isFinite(runs) ? Math.max(0, Math.floor(runs)) : 0
    return {
      generatedAt: new Date().toISOString(),
      agents: this.agents(),
      runs: archived === 'exclude' ? [] : this.listRuns(limit),
      droppedRuns: 0,
      archive: this.info(),
    }
  }

  /** `/@agent-debug/sources` 里的 archive 来源描述（label 由调用方/目录名决定）。 */
  descriptor(label = `历史归档 · ${basename(this.dir)}`): ArchiveSourceDescriptor {
    const info = this.info()
    return {
      id: this.id,
      label,
      baseUrl: '',
      version: '',
      backend: 'archive',
      available: true,
      archiveDir: this.dir,
      runCount: info.runCount,
      latestStartedAt: this.latestStartedAt(),
    }
  }

  /** 存档 run 补齐离线可用字段；只读副本，不改缓存里的索引对象。 */
  private toArchiveRun(run: AgentDebugRun): AgentDebugRun {
    return { ...run, origin: 'archive', sessionTitle: null }
  }

  private loadIndex(): ArchiveIndexEntry[] {
    const indexPath = join(this.dir, ARCHIVE_INDEX_FILE)
    const indexMtime = mtimeMsOf(indexPath)
    const indexMtimeMs = indexMtime === -1 ? null : indexMtime

    const cached = this.cache
    if (cached && cached.indexMtimeMs === indexMtimeMs) {
      if (cached.rebuildSignature === null) return cached.entries
      const signature = this.runsDirSignature()
      if (signature === cached.rebuildSignature) return cached.entries
    }

    if (indexMtimeMs !== null) {
      try {
        const entries = parseIndex(readFileSync(indexPath, 'utf8'))
        if (entries) {
          this.cache = { indexMtimeMs, rebuildSignature: null, entries }
          return entries
        }
      } catch {
        // 读失败/损坏：走内存重建。
      }
    }

    const signature = this.runsDirSignature()
    const entries = this.rebuildIndex()
    this.cache = { indexMtimeMs, rebuildSignature: signature, entries }
    return entries
  }

  /** runs 目录（含子目录）mtime 签名：新增/删除归档文件会改变所在目录 mtime。 */
  private runsDirSignature(): string {
    const parts: string[] = []
    const walk = (directory: string): void => {
      let dirents
      try {
        dirents = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      parts.push(`${relative(this.dir, directory)}@${mtimeMsOf(directory)}`)
      for (const dirent of dirents) {
        if (dirent.isDirectory()) walk(join(directory, dirent.name))
      }
    }
    walk(join(this.dir, ARCHIVE_RUNS_DIR))
    return parts.sort().join('|')
  }

  /** 扫描 `runs/**\/*.ndjson` 首行重建索引（只读，不写盘）；坏文件只跳过自身。 */
  private rebuildIndex(): ArchiveIndexEntry[] {
    const files: string[] = []
    const walk = (directory: string): void => {
      let dirents
      try {
        dirents = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const full = join(directory, dirent.name)
        if (dirent.isDirectory()) walk(full)
        else if (dirent.isFile() && dirent.name.endsWith('.ndjson')) files.push(full)
      }
    }
    walk(join(this.dir, ARCHIVE_RUNS_DIR))

    // 同 runId 以最后遇到的文件为准（与 Gateway 索引 Map 语义一致）。
    const byRunId = new Map<string, ArchiveIndexEntry>()
    for (const file of files) {
      let run: AgentDebugRun | null = null
      try {
        run = parseRunLine(readFirstLineSync(file))
      } catch {
        run = null
      }
      if (!run) continue
      byRunId.set(run.runId, {
        run,
        file: relative(this.dir, file).split(sep).join('/'),
        bytes: fileSizeOf(file),
      })
    }
    return [...byRunId.values()]
  }
}

/** 归档 source 目录名 → 中文语义名（`main` → 主网关、`cursor-completion` → 补全服务）；其它目录名原样。 */
export const ARCHIVE_SOURCE_NAMES: Readonly<Record<string, string>> = {
  main: '主网关',
  'cursor-completion': '补全服务',
}

/** 归档 source 目录的展示名（目录名经 {@link ARCHIVE_SOURCE_NAMES} 映射，未知目录原样）。 */
export function archiveSourceDisplayName(dir: string): string {
  const name = basename(dir)
  return ARCHIVE_SOURCE_NAMES[name] ?? name
}

/** `/@agent-debug/sources` 里 archive 来源的展示 label（如「历史归档 · 主网关」；不含「· 只读」）。 */
export function archiveSourceLabel(dir: string, prefix = '历史归档'): string {
  return `${prefix} · ${archiveSourceDisplayName(dir)}`
}

/**
 * 目录发现：扫描 `<dataDir>/agent-debug/*` 子目录，有 `index.json` 或 `runs/`
 * 才算一个归档来源；resolve 后去重（同一目录只出现一次）。
 *
 * @param dataDir 数据目录（manifest 的 `dirname(dirname(path))`）
 * @param label   展示前缀，最终 label 为 `${label} · ${source 目录语义名}`（默认「历史归档」）
 * @param sourceFor 读取器工厂；dev server 用它复用按目录缓存的实例（默认每次新建）
 */
export function discoverArchiveSources(
  dataDir: string,
  label = '历史归档',
  sourceFor: (dir: string) => DebugArchiveSource = (dir) => new DebugArchiveSource(dir),
): DiscoveredArchiveSource[] {
  const root = join(resolve(dataDir), 'agent-debug')
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const seen = new Set<string>()
  const discovered: DiscoveredArchiveSource[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const dir = resolve(root, dirent.name)
    if (seen.has(dir)) continue
    if (!existsSync(join(dir, ARCHIVE_INDEX_FILE)) && !existsSync(join(dir, ARCHIVE_RUNS_DIR))) continue
    seen.add(dir)
    const source = sourceFor(dir)
    discovered.push({
      id: source.id,
      label: archiveSourceLabel(dir, label),
      dir,
      runCount: source.info().runCount,
      latestStartedAt: source.latestStartedAt(),
      source,
    })
  }

  return discovered.sort((left, right) => {
    const leftAt = left.latestStartedAt ? Date.parse(left.latestStartedAt) : Number.NaN
    const rightAt = right.latestStartedAt ? Date.parse(right.latestStartedAt) : Number.NaN
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1
    return left.dir.localeCompare(right.dir)
  })
}
