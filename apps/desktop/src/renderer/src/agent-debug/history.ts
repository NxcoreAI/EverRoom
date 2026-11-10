/**
 * 调试页历史浏览相关的纯函数：范围三态、来源判断、会话推导/筛选/分组、snapshot 查询参数。
 * 不依赖 React / DOM，便于单测；UI 与 api 客户端共用这里的定义。
 *
 * 会话可辨认性（2026-10-24 增强）：
 * - 标题会重复/缺失，光看标题分不清对话；所有会话标签统一带「首次 run 开始时间 + sessionId 前 8 位」；
 * - 标题缺失时用该会话首条 run 的任务摘要兜底（比 pageLabel 的 "Home"/"Room" 更有辨识度）；
 * - run 列表在「全部会话」下按会话分组，组头可点击直接筛选到该会话。
 */
import type { AgentDebugArchiveInfo, AgentDebugRun, AgentDebugRunOrigin } from '@nxcore/agent-contract'

import { formatBytes, formatMonthDayTime, formatRelativeTime, truncate } from './format'

/** 顶栏「范围」三态：全部（本次 + 历史）/ 本次（仅内存）/ 历史（仅归档）。 */
export type RangeMode = 'all' | 'live' | 'archive'

/** snapshot 的 `archived` 查询参数。 */
export type ArchivedQuery = 'include' | 'exclude' | 'only'

export interface SnapshotQuery {
  /** snapshot 请求的 run 条数上限（Gateway 限制 1–300，默认 150）。 */
  runs?: number
  /** 归档数据范围，缺省 include。 */
  archived?: ArchivedQuery
}

/** snapshot 默认条数；历史模式用更大的 300 覆盖更多历史 run。 */
export const SNAPSHOT_RUNS_DEFAULT = 150
export const SNAPSHOT_RUNS_HISTORY = 300

/** 会话筛选下拉里「全部会话」的哨兵值（空字符串表示「无会话」，不能复用）。 */
export const ALL_SESSIONS = '__all__'

/** 会话主名在下拉/组头里的最大字符数（完整标题放 title 属性）。 */
export const SESSION_NAME_MAX = 18

export const RANGE_MODES: ReadonlyArray<{ id: RangeMode; label: string; hint: string }> = [
  { id: 'all', label: '全部', hint: '包含本次进程与磁盘归档的 run' },
  { id: 'live', label: '本次', hint: '只显示本次 Gateway 进程内存里的 run' },
  { id: 'archive', label: '历史', hint: '只显示磁盘归档里的历史 run' },
]

/** 旧 Gateway 不带 `origin`，缺省按 live 处理。 */
export function originOf(run: Pick<AgentDebugRun, 'origin'>): AgentDebugRunOrigin {
  return run.origin === 'archive' ? 'archive' : 'live'
}

export function isArchivedRun(run: Pick<AgentDebugRun, 'origin'>): boolean {
  return originOf(run) === 'archive'
}

/** 按范围三态过滤快照 run；缺失 `origin` 的旧数据按 live 处理。 */
export function filterRunsByOrigin(runs: readonly AgentDebugRun[], mode: RangeMode): AgentDebugRun[] {
  if (mode === 'all') return [...runs]
  const wantArchive = mode === 'archive'
  return runs.filter((run) => isArchivedRun(run) === wantArchive)
}

/** 会话标识：sessionId 去空白；无会话为空字符串。 */
export function sessionKeyOf(run: Pick<AgentDebugRun, 'sessionId'>): string {
  return run.sessionId?.trim() ?? ''
}

/** sessionId 前 8 位（展示用短 id；无会话为空）。 */
export function sessionShortId(sessionId: string | null | undefined): string {
  const key = sessionId?.trim() ?? ''
  return key ? key.slice(0, 8) : ''
}

/**
 * 会话展示名（run 行/详情用）：sessionTitle → pageLabel → sessionId 前 8 位 → 「无会话」。
 * 会话标题缺失但需要更强辨识度时，用 {@link sessionPrimaryOf}（会退回任务摘要）。
 */
export function sessionLabelOf(run: Pick<AgentDebugRun, 'sessionId' | 'sessionTitle' | 'pageLabel'>): string {
  const title = run.sessionTitle?.trim()
  if (title) return title
  const page = run.pageLabel?.trim()
  if (page) return page
  const key = sessionKeyOf(run)
  return key ? key.slice(0, 8) : '无会话'
}

/**
 * 会话可辨认主名（下拉/组头用）：sessionTitle → 首条 run 任务摘要 → pageLabel →
 * sessionId 前 8 位 → 「无会话」。
 */
export function sessionPrimaryOf(run: Pick<AgentDebugRun, 'sessionId' | 'sessionTitle' | 'pageLabel' | 'task'>): string {
  const title = run.sessionTitle?.trim()
  if (title) return title
  const task = run.task?.trim()
  if (task) return task
  const page = run.pageLabel?.trim()
  if (page) return page
  const key = sessionKeyOf(run)
  return key ? key.slice(0, 8) : '无会话'
}

/** run 的活动时间（排序/分组用）：最近事件时间，缺省开始时间。 */
export function runActivityTime(run: Pick<AgentDebugRun, 'lastEventAt' | 'startedAt'>): number {
  const time = Date.parse(run.lastEventAt ?? run.startedAt)
  return Number.isFinite(time) ? time : 0
}

/** run 开始时间（毫秒；非法为 0）。 */
function runStartTime(run: Pick<AgentDebugRun, 'startedAt'>): number {
  const time = Date.parse(run.startedAt)
  return Number.isFinite(time) ? time : 0
}

/** run 排序：运行中永远最前，其余按最近活动时间倒序（与原 RunList 行为一致）。 */
export function sortRunsByActivity(runs: readonly AgentDebugRun[]): AgentDebugRun[] {
  return [...runs].sort((left, right) => {
    const leftRunning = left.status === 'running' ? 0 : 1
    const rightRunning = right.status === 'running' ? 0 : 1
    if (leftRunning !== rightRunning) return leftRunning - rightRunning
    return runActivityTime(right) - runActivityTime(left)
  })
}

export interface SessionOption {
  /** 会话标识（ALL_SESSIONS / 空字符串「无会话」/ 完整 sessionId）。 */
  key: string
  /** 下拉/组头用的紧凑标签：主名 · 首次时间 · #短id（无会话/全部只有主名）。 */
  label: string
  /** hover title：完整主名、完整 sessionId、时间范围与 run 数。 */
  title: string
  /** 未截断的主名（标题 / 任务摘要 / pageLabel / 短 id / 无会话）。 */
  primary: string
  /** sessionId 前 8 位；无会话 / 全部为空字符串。 */
  shortId: string
  count: number
  /** 该会话最早一条 run 的开始时间（ISO）；无 run 为 null。 */
  startedAt: string | null
  /** 该会话最近活动时间（ISO）；无 run 为 null。 */
  lastAt: string | null
  /** 该会话是否含运行中 run（组排序用）。 */
  running: boolean
}

interface SessionAccumulator {
  key: string
  primary: string | null
  /** 主名是否来自 sessionTitle（后续 run 有标题时优先补全）。 */
  primaryIsTitle: boolean
  shortId: string
  /** 首条 run 的 pageLabel（"Home"/"Room" 等），只用于 hover title 补充上下文。 */
  page: string | null
  count: number
  startedAtMs: number | null
  lastAtMs: number | null
  running: boolean
}

/** 构造 title 属性：完整主名 + 时间范围 + 完整 sessionId + run 数。 */
function optionTitle(primary: string, fullSessionId: string | null, session: SessionAccumulator): string {
  const parts = [primary]
  if (session.startedAtMs !== null) parts.push(`首次 ${new Date(session.startedAtMs).toISOString()}`)
  if (session.lastAtMs !== null && session.lastAtMs !== session.startedAtMs) {
    parts.push(`最近 ${new Date(session.lastAtMs).toISOString()}`)
  }
  if (session.page) parts.push(`page ${session.page}`)
  if (fullSessionId) parts.push(`会话 ${fullSessionId}`)
  parts.push(`${session.count} 个 run`)
  if (session.running) parts.push('运行中')
  return parts.join(' · ')
}

function optionLabel(primary: string, shortId: string, startedAtMs: number | null): string {
  const name = truncate(primary, SESSION_NAME_MAX)
  const time = startedAtMs === null ? null : formatMonthDayTime(new Date(startedAtMs).toISOString())
  const suffix = [time, shortId ? `#${shortId}` : null].filter(Boolean).join(' · ')
  return suffix ? `${name} · ${suffix}` : name
}

/**
 * 由当前 run 推导会话筛选项：
 * 第一项固定「全部会话」，其余按 runs 里首次出现的顺序（列表本身已按活跃度排序），
 * 「无会话」永远排最后。标签带首次时间与短 id，标题重复/缺失时也能区分。
 */
export function buildSessionOptions(runs: readonly AgentDebugRun[]): SessionOption[] {
  const byKey = new Map<string, SessionAccumulator>()
  let noSession: SessionAccumulator | null = null
  for (const run of runs) {
    const key = sessionKeyOf(run)
    const startedAtMs = runStartTime(run)
    const lastAtMs = runActivityTime(run) || startedAtMs
    const running = run.status === 'running'
    if (!key) {
      if (!noSession) {
        noSession = {
          key: '',
          primary: null,
          primaryIsTitle: false,
          shortId: '',
          page: null,
          count: 0,
          startedAtMs: null,
          lastAtMs: null,
          running: false,
        }
      }
      noSession.count += 1
      noSession.startedAtMs = noSession.startedAtMs === null ? startedAtMs : Math.min(noSession.startedAtMs, startedAtMs)
      noSession.lastAtMs = noSession.lastAtMs === null ? lastAtMs : Math.max(noSession.lastAtMs, lastAtMs)
      if (running) noSession.running = true
      continue
    }
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, {
        key,
        primary: sessionPrimaryOf(run),
        primaryIsTitle: Boolean(run.sessionTitle?.trim()),
        shortId: sessionShortId(key),
        page: run.pageLabel?.trim() || null,
        count: 1,
        startedAtMs,
        lastAtMs,
        running,
      })
      continue
    }
    existing.count += 1
    existing.startedAtMs = existing.startedAtMs === null ? startedAtMs : Math.min(existing.startedAtMs, startedAtMs)
    existing.lastAtMs = existing.lastAtMs === null ? lastAtMs : Math.max(existing.lastAtMs, lastAtMs)
    if (running) existing.running = true
    if (!existing.page && run.pageLabel?.trim()) existing.page = run.pageLabel.trim()
    // 首条 run 没有标题时，后续 run 的标题可用于补全主名（只补标题，不覆盖已有标题）。
    const title = run.sessionTitle?.trim()
    if (title && !existing.primaryIsTitle) {
      existing.primary = title
      existing.primaryIsTitle = true
    }
  }

  const options: SessionOption[] = [{
    key: ALL_SESSIONS,
    label: '全部会话',
    title: `所有会话（${runs.length} 个 run）`,
    primary: '全部会话',
    shortId: '',
    count: runs.length,
    startedAt: null,
    lastAt: null,
    running: runs.some((run) => run.status === 'running'),
  }]
  for (const session of byKey.values()) {
    const primary = session.primary ?? '无标题会话'
    options.push({
      key: session.key,
      label: optionLabel(primary, session.shortId, session.startedAtMs),
      title: optionTitle(primary, session.key, session),
      primary,
      shortId: session.shortId,
      count: session.count,
      startedAt: session.startedAtMs === null ? null : new Date(session.startedAtMs).toISOString(),
      lastAt: session.lastAtMs === null ? null : new Date(session.lastAtMs).toISOString(),
      running: session.running,
    })
  }
  if (noSession) {
    const session = noSession
    const primary = '无会话'
    const label = optionLabel(primary, '', session.startedAtMs)
    options.push({
      key: '',
      label,
      title: optionTitle(primary, null, session),
      primary,
      shortId: '',
      count: session.count,
      startedAt: session.startedAtMs === null ? null : new Date(session.startedAtMs).toISOString(),
      lastAt: session.lastAtMs === null ? null : new Date(session.lastAtMs).toISOString(),
      running: session.running,
    })
  }
  return options
}

export interface SessionGroup {
  option: SessionOption
  /** 组内 run（已按活跃度排序：运行中优先，其次最近活动）。 */
  runs: AgentDebugRun[]
}

/**
 * 按会话分组（「全部会话」视图用）：组按「是否含运行中 → 最近活动时间」排序；
 * 组内按 {@link sortRunsByActivity} 排序。「无会话」组排最后。
 */
export function groupRunsBySession(runs: readonly AgentDebugRun[]): SessionGroup[] {
  const options = buildSessionOptions(runs)
  const byKey = new Map<string, AgentDebugRun[]>()
  for (const run of runs) {
    const key = sessionKeyOf(run)
    const list = byKey.get(key)
    if (list) list.push(run)
    else byKey.set(key, [run])
  }
  const groups: SessionGroup[] = []
  for (const option of options) {
    if (option.key === ALL_SESSIONS) continue
    const groupRuns = byKey.get(option.key)
    if (!groupRuns || groupRuns.length === 0) continue
    groups.push({ option, runs: sortRunsByActivity(groupRuns) })
  }
  groups.sort((left, right) => {
    const leftRunning = left.option.running ? 0 : 1
    const rightRunning = right.option.running ? 0 : 1
    if (leftRunning !== rightRunning) return leftRunning - rightRunning
    if (left.option.key === '') return 1
    if (right.option.key === '') return -1
    const leftAt = Date.parse(left.option.lastAt ?? left.option.startedAt ?? '')
    const rightAt = Date.parse(right.option.lastAt ?? right.option.startedAt ?? '')
    return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0)
  })
  return groups
}

/** 在选项里查当前筛选值（未知值返回 null）。 */
export function findSessionOption(
  options: readonly SessionOption[],
  sessionKey: string,
): SessionOption | null {
  return options.find((option) => option.key === sessionKey) ?? null
}

/** 客户端会话筛选：ALL_SESSIONS / null 表示不过滤；空字符串筛选「无会话」。 */
export function filterRunsBySession(
  runs: readonly AgentDebugRun[],
  sessionKey: string | null | undefined,
): AgentDebugRun[] {
  if (sessionKey === ALL_SESSIONS || sessionKey === null || sessionKey === undefined) return [...runs]
  return runs.filter((run) => sessionKeyOf(run) === sessionKey)
}

/** 范围三态 → snapshot 查询参数：历史模式请求 300 条且只含归档。 */
export function snapshotQueryFor(mode: RangeMode): SnapshotQuery {
  if (mode === 'archive') return { runs: SNAPSHOT_RUNS_HISTORY, archived: 'only' }
  if (mode === 'live') return { runs: SNAPSHOT_RUNS_DEFAULT, archived: 'exclude' }
  return { runs: SNAPSHOT_RUNS_DEFAULT, archived: 'include' }
}

/** snapshot 查询串（稳定顺序：runs 在前、archived 在后），缺省值按契约补全。 */
export function snapshotSearchParams(query: SnapshotQuery = {}): string {
  const params = new URLSearchParams()
  params.set('runs', String(query.runs ?? SNAPSHOT_RUNS_DEFAULT))
  params.set('archived', query.archived ?? 'include')
  return params.toString()
}

/** 历史模式下默认选中的 run：归档 run 里 startedAt 最新的一条（无则 null）。 */
export function latestArchivedRunId(runs: readonly AgentDebugRun[]): string | null {
  let latestId: string | null = null
  let latestAt = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    if (!isArchivedRun(run)) continue
    const parsed = Date.parse(run.startedAt)
    const startedAt = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
    if (latestId === null || startedAt > latestAt) {
      latestId = run.runId
      latestAt = startedAt
    }
  }
  return latestId
}

export interface ArchiveSummary {
  /** 归档是否启用；false 时历史模式入口置灰。 */
  enabled: boolean
  /** 顶栏 muted 文本；归档概况缺失（旧 Gateway / 首次快照未回）时为 null。 */
  text: string
  /** hover title：字节数与最旧时间。 */
  title: string
}

/** 归档概况 → 顶栏文本；`archive` 缺失返回 null（不渲染）。 */
export function archiveSummaryOf(
  info: AgentDebugArchiveInfo | null | undefined,
  now = Date.now(),
): ArchiveSummary | null {
  if (!info) return null
  if (!info.enabled) {
    return {
      enabled: false,
      text: '历史未启用',
      title: '历史归档已关闭（NXCORE_AGENT_DEBUG_ARCHIVE=0），run 结束后不会写入磁盘',
    }
  }
  const oldest = info.oldestStartedAt ? formatRelativeTime(info.oldestStartedAt, now) : '—'
  const oldestDetail = info.oldestStartedAt ? ` · 最旧 ${oldest}（${info.oldestStartedAt}）` : ''
  // retentionDays<=0 表示「离线读取时未知保留策略」（archive 来源没有 Gateway 配置），只报条数。
  const text = info.retentionDays > 0
    ? `历史 ${info.runCount} 条 · 保留 ${info.retentionDays} 天`
    : `历史 ${info.runCount} 条 · 只读`
  return {
    enabled: true,
    text,
    title: `归档 ${formatBytes(info.bytes)}${oldestDetail}`,
  }
}

export interface EmptyRunsContext {
  mode: RangeMode
  /** 是否正在按会话筛选（而非「全部会话」）。 */
  sessionFiltered: boolean
  /** 是否正在看单个 Agent（而非「全部 Agent」）。 */
  agentFiltered: boolean
}

/** run 列表空态文案：区分「无本次 run」与「无历史记录」。 */
export function emptyRunsText(context: EmptyRunsContext): string {
  if (context.sessionFiltered) return '该会话暂无 run'
  if (context.mode === 'archive') return '暂无历史记录'
  if (context.mode === 'live') return '本次暂无 run'
  return context.agentFiltered ? '该 Agent 暂无 run' : '暂无 run'
}
