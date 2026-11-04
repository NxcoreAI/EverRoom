import type { AgentDebugEvent, AgentDebugRun, AgentDebugSnapshot } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorMessage, loadRunEvents, loadSnapshot, loadSources, type DebugSource } from './api'
import { AgentList, type AgentKindTab } from './components/AgentList'
import { RunDetail } from './components/RunDetail'
import { RunList } from './components/RunList'
import {
  ALL_SESSIONS,
  archiveSummaryOf,
  buildSessionOptions,
  emptyRunsText,
  filterRunsByOrigin,
  filterRunsBySession,
  latestArchivedRunId,
  RANGE_MODES,
  snapshotQueryFor,
  type RangeMode,
} from './history'
import { mergeRunEvents, reduceRunTimeline, type DebugFilters } from './reducer'
import {
  isArchiveSource,
  orderDebugSources,
  pickSourceId,
  sourceConnectionLabel,
  sourceConnectionTitle,
  sourceLabel,
  sourceTitle,
} from './sources'

const SNAPSHOT_INTERVAL_MS = 1200
const EVENTS_INTERVAL_MS = 400
const EVENTS_PAGE_LIMIT = 1000
const SOURCES_RETRY_MS = 3000
const SOURCES_REFRESH_MS = 15_000

type ConnectionState = 'connecting' | 'online' | 'offline'

const EMPTY_RUNS: AgentDebugRun[] = []
const EMPTY_EVENTS: AgentDebugEvent[] = []
const EMPTY_AGENTS: AgentDebugSnapshot['agents'] = []
const DEFAULT_FILTERS: DebugFilters = { reasoning: true, tool: true, message: true, system: true }

const FILTER_DEFS = [
  { key: 'reasoning', label: '思考' },
  { key: 'tool', label: '工具' },
  { key: 'message', label: '消息' },
  { key: 'system', label: '系统' },
] as const

interface SnapshotState {
  sourceId: string
  snapshot: AgentDebugSnapshot
}

interface RunEventsState {
  sourceId: string | null
  runId: string | null
  events: AgentDebugEvent[]
  latestSeq: number
  run: AgentDebugRun | null
  error: string | null
  loaded: boolean
}

const EMPTY_RUN_EVENTS: RunEventsState = {
  sourceId: null,
  runId: null,
  events: [],
  latestSeq: 0,
  run: null,
  error: null,
  loaded: false,
}

export function App() {
  const [sources, setSources] = useState<DebugSource[]>([])
  const [sourcesReady, setSourcesReady] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [snapshotState, setSnapshotState] = useState<SnapshotState | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [filters, setFilters] = useState<DebugFilters>(DEFAULT_FILTERS)
  const [rangeMode, setRangeMode] = useState<RangeMode>('all')
  const [sessionFilter, setSessionFilter] = useState<string>(ALL_SESSIONS)
  const [selectedAgentId, setSelectedAgentId] = useState<string>('all')
  const [kindTab, setKindTab] = useState<AgentKindTab>('all')
  const [followLatest, setFollowLatest] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [eventsState, setEventsState] = useState<RunEventsState>(EMPTY_RUN_EVENTS)

  const eventsRef = useRef(eventsState)
  useEffect(() => {
    eventsRef.current = eventsState
  }, [eventsState])

  const currentSource = sources.find((source) => source.id === sourceId) ?? null
  const selectedArchiveSource = isArchiveSource(currentSource)
  // 下拉顺序：可用 live → 历史归档 → 不可用 live（死来源沉底，与默认选中优先级一致）。
  const orderedSources = useMemo(() => orderDebugSources(sources), [sources])

  // 选中历史归档来源时范围落到「历史」：归档没有本次进程的 run，「本次」也不可点。
  useEffect(() => {
    if (sourceId && selectedArchiveSource) setRangeMode('archive')
  }, [sourceId, selectedArchiveSource])

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), [])

  // ── sources：启动即拉取，空结果 3s 重试（等 Desktop 启动）、有结果 15s 刷新（等重启换端口） ──
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      let nextDelay = SOURCES_RETRY_MS
      try {
        const result = await loadSources()
        if (cancelled) return
        setSources(result.sources)
        setSourcesReady(true)
        setSourcesError(result.warning ?? (result.sources.length === 0 ? '未发现 gateway runtime manifest' : null))
        nextDelay = result.sources.length > 0 ? SOURCES_REFRESH_MS : SOURCES_RETRY_MS
        // 当前来源仍可用则保持；live 变不可用（EverRoom 退出）时自动落到历史归档。
        setSourceId((current) => pickSourceId(result.sources, current))
      } catch (error) {
        if (cancelled) return
        setSourcesReady(true)
        setSourcesError(errorMessage(error))
      } finally {
        if (!cancelled) timer = window.setTimeout(() => { void load() }, nextDelay)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshNonce])

  // ── snapshot：1200ms；暂停时只做一次（手动刷新仍可拍快照）；范围切换后立即重新拉 ──
  useEffect(() => {
    if (!sourceId) return undefined
    const query = snapshotQueryFor(rangeMode)
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const next = await loadSnapshot(sourceId, query)
        if (cancelled) return
        setSnapshotState({ sourceId, snapshot: next })
        setConnection('online')
        setConnectionError(null)
      } catch (error) {
        if (cancelled) return
        setConnection('offline')
        setConnectionError(errorMessage(error))
      }
      if (!cancelled && !paused) timer = window.setTimeout(() => { void tick() }, SNAPSHOT_INTERVAL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sourceId, paused, refreshNonce, rangeMode])

  // 切换来源后丢弃旧快照（避免把上一个 Gateway 的 run 当成当前来源）。
  const snapshot = snapshotState && snapshotState.sourceId === sourceId ? snapshotState.snapshot : null
  const agents = snapshot?.agents ?? EMPTY_AGENTS
  const runs = snapshot?.runs ?? EMPTY_RUNS

  // 归档概况：快照未回时不渲染；旧 Gateway 不返回 archive 字段，同样视为历史不可用。
  const archiveSummary = useMemo(() => {
    if (!snapshot) return null
    if (!snapshot.archive) {
      return {
        enabled: false,
        text: '历史未启用',
        title: '当前 Gateway 未返回归档信息（旧版本），历史 run 不可浏览',
      }
    }
    return archiveSummaryOf(snapshot.archive)
  }, [snapshot])
  const archiveDisabled = archiveSummary !== null && !archiveSummary.enabled

  // 范围三态在客户端再过滤一次：切模式后新快照回来前，不会短暂展示错误来源的 run。
  const modeRuns = useMemo(() => filterRunsByOrigin(runs, rangeMode), [runs, rangeMode])

  // 归档被关闭时不留「历史」模式（例如运行中通过 env 关掉了归档）。
  useEffect(() => {
    if (archiveDisabled && rangeMode === 'archive') setRangeMode('all')
  }, [archiveDisabled, rangeMode])

  // ── 选中 Agent / run 的自动跟随 ──
  const selectedAgent = selectedAgentId === 'all'
    ? null
    : agents.find((agent) => agent.id === selectedAgentId) ?? null

  useEffect(() => {
    if (selectedAgentId !== 'all' && snapshot && !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId('all')
    }
  }, [agents, selectedAgentId, snapshot])

  const agentRuns = useMemo(
    () => (selectedAgentId === 'all' ? modeRuns : modeRuns.filter((run) => run.agentId === selectedAgentId)),
    [modeRuns, selectedAgentId],
  )

  // 会话筛选下拉选项由当前（按 Agent 过滤后的）runs 推导，筛选本身在客户端完成。
  const sessionOptions = useMemo(() => buildSessionOptions(agentRuns), [agentRuns])

  // 切换 Agent / 范围后，丢弃已不存在的会话筛选键，回到「全部会话」。
  useEffect(() => {
    if (!sessionOptions.some((option) => option.key === sessionFilter)) setSessionFilter(ALL_SESSIONS)
  }, [sessionOptions, sessionFilter])

  const visibleRuns = useMemo(
    () => filterRunsBySession(agentRuns, sessionFilter),
    [agentRuns, sessionFilter],
  )

  const emptyText = emptyRunsText({
    mode: rangeMode,
    sessionFiltered: sessionFilter !== ALL_SESSIONS,
    agentFiltered: selectedAgentId !== 'all',
  })

  useEffect(() => {
    setSelectedRunId((current) => {
      if (visibleRuns.length === 0) return null
      if (followLatest) {
        const active = visibleRuns.find((run) => run.status === 'running')
        if (active) return active.runId
      }
      if (current && visibleRuns.some((run) => run.runId === current)) return current
      // 历史模式默认选中最新一条历史 run（归档 run 全是终态，不参与「跟随运行中」）。
      if (rangeMode === 'archive') {
        const latestArchived = latestArchivedRunId(visibleRuns)
        if (latestArchived) return latestArchived
      }
      const running = visibleRuns.find((run) => run.status === 'running')
      return running?.runId ?? visibleRuns[0]!.runId
    })
  }, [visibleRuns, followLatest, rangeMode])

  const selectedRunInSnapshot = selectedRunId !== null && modeRuns.some((run) => run.runId === selectedRunId)

  // ── 选中 run 的增量事件：运行中 400ms，终态/暂停后停止；归档 run 全是终态，只拉一次 ──
  useEffect(() => {
    if (!sourceId || !selectedRunId || !selectedRunInSnapshot) return undefined
    const runId = selectedRunId
    if (eventsRef.current.sourceId !== sourceId || eventsRef.current.runId !== runId) {
      setEventsState({ ...EMPTY_RUN_EVENTS, sourceId, runId, run: modeRuns.find((run) => run.runId === runId) ?? null })
      eventsRef.current = { ...EMPTY_RUN_EVENTS, sourceId, runId }
    }
    let cancelled = false
    let timer: number | undefined
    let afterSeq = eventsRef.current.sourceId === sourceId && eventsRef.current.runId === runId
      ? eventsRef.current.latestSeq
      : 0

    const tick = async (): Promise<void> => {
      try {
        let incoming: AgentDebugEvent[] = []
        let latestRun: AgentDebugRun | null = null
        // afterSeq 推进到「本页最后一条已拿到的事件」而不是响应的 latestSeq：
        // 一页被 limit 截断时 latestSeq 是缓冲里最大 seq，直接跳过去会漏事件。
        let cursor = afterSeq
        for (let round = 0; round < 12; round += 1) {
          const response = await loadRunEvents(sourceId, runId, cursor, EVENTS_PAGE_LIMIT)
          latestRun = response.run
          if (response.events.length === 0) {
            cursor = Math.max(cursor, response.latestSeq)
            break
          }
          incoming = mergeRunEvents(incoming, response.events)
          let pageLastSeq = cursor
          for (const event of response.events) pageLastSeq = Math.max(pageLastSeq, event.seq)
          cursor = pageLastSeq
          if (response.events.length < EVENTS_PAGE_LIMIT) break
        }
        afterSeq = cursor
        if (cancelled) return
        setEventsState((previous) => previous.sourceId === sourceId && previous.runId === runId
          ? {
            ...previous,
            events: mergeRunEvents(previous.events, incoming),
            latestSeq: Math.max(previous.latestSeq, afterSeq),
            run: latestRun ?? previous.run,
            error: null,
            loaded: true,
          }
          : {
            ...EMPTY_RUN_EVENTS,
            sourceId,
            runId,
            events: incoming,
            latestSeq: afterSeq,
            run: latestRun,
            loaded: true,
          })
        if (!cancelled && !paused && latestRun?.status === 'running') {
          timer = window.setTimeout(() => { void tick() }, EVENTS_INTERVAL_MS)
        }
      } catch (error) {
        if (cancelled) return
        setEventsState((previous) => previous.sourceId === sourceId && previous.runId === runId
          ? { ...previous, error: errorMessage(error), loaded: true }
          : previous)
        if (!cancelled && !paused) timer = window.setTimeout(() => { void tick() }, 1500)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
    // runs 只用于首帧补齐 run 元数据，进依赖会造成每次 snapshot 重置增量拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, selectedRunId, selectedRunInSnapshot, paused, refreshNonce])

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    if (eventsState.sourceId === sourceId && eventsState.runId === selectedRunId && eventsState.run) {
      return eventsState.run
    }
    return modeRuns.find((run) => run.runId === selectedRunId) ?? null
  }, [eventsState.run, eventsState.runId, eventsState.sourceId, modeRuns, selectedRunId, sourceId])

  const activeEvents = eventsState.sourceId === sourceId && eventsState.runId === selectedRunId
    ? eventsState.events
    : EMPTY_EVENTS
  const activeEventsError = eventsState.sourceId === sourceId && eventsState.runId === selectedRunId
    ? eventsState.error
    : null
  const timeline = useMemo(() => reduceRunTimeline(activeEvents), [activeEvents])

  // 历史归档来源的连接态与 Gateway 无关：显示「历史归档 · 只读」，title 给归档目录。
  const archiveConnectionLabel = sourceConnectionLabel(currentSource)
  const connectionLabel = archiveConnectionLabel ?? (sourcesReady && sources.length === 0
    ? '未发现 Gateway'
    : paused
      ? '已暂停'
      : connection === 'online'
        ? '在线'
        : connection === 'offline'
          ? '离线'
          : '连接中')
  const connectionTitle = archiveConnectionLabel
    ? [sourceConnectionTitle(currentSource), paused ? '轮询已暂停' : null].filter(Boolean).join(' · ')
    : connectionError ?? (paused ? '轮询已暂停' : '')

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-label">来源</span>
        <select
          className="source-select"
          value={sourceId ?? ''}
          disabled={orderedSources.length === 0}
          onChange={(event) => setSourceId(event.target.value || null)}
          title={currentSource ? sourceTitle(currentSource) : '未发现 gateway runtime manifest / 本地历史归档'}
        >
          {orderedSources.length === 0 ? <option value="">未发现 Gateway</option> : null}
          {orderedSources.map((source) => (
            <option key={source.id} value={source.id} title={sourceTitle(source)}>
              {sourceLabel(source)}
            </option>
          ))}
        </select>
        <span className="conn" data-state={paused ? 'paused' : connection} title={connectionTitle}>
          {connectionLabel}
        </span>
        {connection === 'offline' && connectionError ? (
          <span className="conn-error" title={connectionError}>{connectionError}</span>
        ) : null}
        <span className="topbar-label topbar-label--range">范围</span>
        <div className="topbar-range" role="group" aria-label="Run 范围">
          {RANGE_MODES.map((definition) => {
            // 归档来源没有「本次」进程的 run；live Gateway 未启用归档时「历史」不可点。
            const archiveModeDisabled = definition.id === 'archive' && archiveDisabled
            const liveModeDisabled = definition.id === 'live' && selectedArchiveSource
            const disabled = archiveModeDisabled || liveModeDisabled
            const title = liveModeDisabled
              ? `${definition.hint}（归档来源没有本次进程的 run）`
              : archiveModeDisabled
                ? `${definition.hint}（历史归档未启用）`
                : definition.hint
            return (
              <button
                key={definition.id}
                type="button"
                className="text-btn"
                data-active={rangeMode === definition.id}
                aria-pressed={rangeMode === definition.id}
                disabled={disabled}
                onClick={() => setRangeMode(definition.id)}
                title={title}
              >
                {definition.label}
              </button>
            )
          })}
        </div>
        {archiveSummary ? (
          <span className="archive-summary" title={archiveSummary.title}>{archiveSummary.text}</span>
        ) : null}
        <div className="topbar-spacer" />
        <div className="topbar-filters" role="group" aria-label="事件过滤">
          {FILTER_DEFS.map((definition) => (
            <button
              key={definition.key}
              type="button"
              className="text-btn"
              data-active={filters[definition.key]}
              aria-pressed={filters[definition.key]}
              onClick={() => setFilters((previous) => ({ ...previous, [definition.key]: !previous[definition.key] }))}
              title={`${filters[definition.key] ? '隐藏' : '显示'}${definition.label}事件`}
            >
              {definition.label}
            </button>
          ))}
        </div>
        <button type="button" className="text-btn" onClick={refresh} title="立即重新拉取 sources / snapshot / 事件">
          刷新
        </button>
        <button
          type="button"
          className="text-btn text-btn--accent"
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
          title={paused ? '恢复轮询' : '暂停所有轮询'}
        >
          {paused ? '继续' : '暂停'}
        </button>
      </header>

      {!sourcesReady ? (
        <div className="boot">正在检测 Gateway 与本地历史归档</div>
      ) : sources.length === 0 ? (
        <EmptySources error={sourcesError} onRefresh={refresh} />
      ) : (
        <main className="main">
          <AgentList
            agents={agents}
            runs={modeRuns}
            kindTab={kindTab}
            onKindTabChange={setKindTab}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
          />
          <RunList
            runs={visibleRuns}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            agentTitle={selectedAgent ? selectedAgent.name : '全部 Agent'}
            showAgent={selectedAgentId === 'all'}
            followLatest={followLatest}
            onToggleFollow={() => setFollowLatest((value) => !value)}
            sessionFilter={sessionFilter}
            sessionOptions={sessionOptions}
            onSessionFilterChange={setSessionFilter}
            emptyText={emptyText}
            browseKey={`${rangeMode}|${selectedAgentId}|${sessionFilter}`}
          />
          {selectedRun ? (
            <RunDetail
              key={selectedRun.runId}
              run={selectedRun}
              events={activeEvents}
              model={timeline}
              filters={filters}
              eventsError={activeEventsError}
            />
          ) : (
            <section className="col col--detail">
              <div className="empty">
                <p className="empty-text">
                  {snapshot
                    ? rangeMode === 'archive'
                      ? '历史归档里还没有可回看的 run；归档只保存终态 run。'
                      : '选择一个 run 查看时间线、事件与输出。'
                    : connectionError ?? (selectedArchiveSource ? '正在读取历史归档' : '正在连接 Gateway')}
                </p>
              </div>
            </section>
          )}
        </main>
      )}
    </div>
  )
}

function EmptySources({ error, onRefresh }: { error: string | null; onRefresh: () => void }) {
  const detail = error && error !== '未发现 gateway runtime manifest' ? error : null
  return (
    <main className="empty">
      <div className="empty-text">
        <p>未发现 Gateway，也没有可读的本地历史归档。</p>
        <p>
          EverRoom 未运行：先启动 EverRoom 跑一个 Agent 任务，run 结束后会写入磁盘归档，
          下次打开调试页即可直接回看历史 run。
        </p>
        <p>
          已有归档目录时设置 <code>NXCORE_DATA_DIR=/path/to/dataDir</code>：
          调试页会读取 <code>dataDir/agent-debug/&lt;source&gt;/index.json</code> 与 <code>runs/*.ndjson</code>。
        </p>
        <p>
          或用 manifest 指向运行中的 Gateway：
          <code>EVERROOM_AGENT_DEBUG_MANIFEST=/path/to/runtime/gateway.json pnpm debug:agents</code>
        </p>
        {detail ? <p>{detail}</p> : null}
        <button type="button" className="text-btn" onClick={onRefresh}>重新检测</button>
      </div>
    </main>
  )
}
