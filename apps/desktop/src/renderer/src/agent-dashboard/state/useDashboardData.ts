/**
 * 看板数据层：来源发现 → 快照轮询 → 选中 run 的事件增量拉取 → 派生 insight。
 * 与调试台共用同一套同源代理（`/@agent-debug/*`）与来源排序规则，token 不出 dev server。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'

import {
  errorMessage,
  loadRunEvents,
  loadSnapshot,
  loadSources,
  type DebugSource,
} from '../../agent-debug/api'
import { pickSourceId, orderDebugSources } from '../../agent-debug/sources'
import { snapshotQueryFor, type RangeMode } from '../../agent-debug/history'
import { buildTrace } from '../insight/buildTrace'
import { pickDefaultRun } from './defaultRun'
import type { PriceSpec } from '../insight/pricing'
import type { TraceInsight } from '../insight/types'

const SOURCES_POLL_MS = 15_000
const SNAPSHOT_POLL_MS = 6_000
const RUNNING_EVENTS_POLL_MS = 2_500
const EVENT_PAGE_LIMIT = 1_000
const MAX_EVENT_PAGES = 6

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface DashboardData {
  sources: DebugSource[]
  sourceId: string | null
  selectSource: (sourceId: string) => void
  source: DebugSource | null
  sourcesWarning: string | null
  runs: AgentDebugRun[]
  runsState: LoadState
  runsError: string | null
  range: RangeMode
  setRange: (mode: RangeMode) => void
  selectedRunId: string | null
  selectRun: (runId: string) => void
  selectedRun: AgentDebugRun | null
  events: AgentDebugEvent[]
  eventsState: LoadState
  eventsError: string | null
  /** 事件是否已完整拉取（running run 还在增长）。 */
  eventsLive: boolean
  insight: TraceInsight | null
  refresh: () => void
  lastSyncedAt: number | null
}

/** 事件按 seq upsert（服务端会合并相邻 delta 并复用 seq，不能只追加）。 */
function upsertEvents(previous: readonly AgentDebugEvent[], incoming: readonly AgentDebugEvent[]): AgentDebugEvent[] {
  if (incoming.length === 0) return [...previous]
  const bySeq = new Map<number, AgentDebugEvent>()
  for (const event of previous) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * 拉完一个 run 的全部事件：先按 afterSeq 增量，直到追上 latestSeq；
 * 页面级上限防止超大 run 拖死面板（超出时保留最新一段并标注）。
 */
async function fetchAllEvents(sourceId: string, runId: string): Promise<AgentDebugEvent[]> {
  let collected: AgentDebugEvent[] = []
  let afterSeq = 0
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const response = await loadRunEvents(sourceId, runId, afterSeq, EVENT_PAGE_LIMIT)
    collected = upsertEvents(collected, response.events)
    if (response.latestSeq <= afterSeq || response.events.length === 0) break
    afterSeq = response.latestSeq
    if (response.events.length < EVENT_PAGE_LIMIT) break
  }
  return collected
}

export function useDashboardData(price: PriceSpec | null): DashboardData {
  const [sources, setSources] = useState<DebugSource[]>([])
  const [sourcesWarning, setSourcesWarning] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [runs, setRuns] = useState<AgentDebugRun[]>([])
  const [runsState, setRunsState] = useState<LoadState>('idle')
  const [runsError, setRunsError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeMode>('all')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [events, setEvents] = useState<AgentDebugEvent[]>([])
  const [eventsState, setEventsState] = useState<LoadState>('idle')
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [eventsLive, setEventsLive] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const sourceIdRef = useRef<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const eventsRef = useRef<AgentDebugEvent[]>([])
  const runningRef = useRef(false)
  const sourcesRef = useRef<DebugSource[]>([])
  /** 已在某个 live 来源上尝试过「失败后回落到归档」，避免来回切换。 */
  const fallbackTriedRef = useRef<string | null>(null)

  // 来源发现：15s 一轮，进程退出/重启后自动切换（与调试台同一策略）。
  useEffect(() => {
    let disposed = false
    const tick = async (): Promise<void> => {
      try {
        const result = await loadSources()
        if (disposed) return
        const ordered = orderDebugSources(result.sources)
        setSources(ordered)
        setSourcesWarning(result.warning)
        const nextId = pickSourceId(ordered, sourceIdRef.current)
        if (nextId !== sourceIdRef.current) {
          sourceIdRef.current = nextId
          setSourceId(nextId)
        }
      } catch (error) {
        if (!disposed) setSourcesWarning(errorMessage(error))
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), SOURCES_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  const selectSource = useCallback((nextId: string) => {
    sourceIdRef.current = nextId
    setSourceId(nextId)
    setSelectedRunId(null)
    runIdRef.current = null
    setEvents([])
  }, [])

  // 快照轮询：来源或范围变化立即拉，之后 6s 一轮。
  useEffect(() => {
    if (!sourceId) return
    let disposed = false
    let timer: number | null = null
    const tick = async (): Promise<void> => {
      setRunsState((state) => (state === 'ready' ? state : 'loading'))
      try {
        const snapshot = await loadSnapshot(sourceId, snapshotQueryFor(range))
        if (disposed) return
        setRuns(snapshot.runs)
        setRunsState('ready')
        setRunsError(null)
        setLastSyncedAt(Date.now())
        const currentId = runIdRef.current
        const stillExists = snapshot.runs.some((run) => run.runId === currentId)
        if (!stillExists) {
          const next = pickDefaultRun(snapshot.runs)
          runIdRef.current = next?.runId ?? null
          setSelectedRunId(next?.runId ?? null)
        }
      } catch (error) {
        if (disposed) return
        setRunsState('error')
        setRunsError(errorMessage(error))
        // live 来源拉不动（Gateway 版本旧 / 接口 404 / 进程刚开始退出）时，
        // 若本机有历史归档就自动回落，避免看板停在一个死来源上。
        const archive = sourcesRef.current.find((item) => item.backend === 'archive' && item.available)
        if (archive && fallbackTriedRef.current !== sourceId) {
          fallbackTriedRef.current = sourceId
          sourceIdRef.current = archive.id
          setSourceId(archive.id)
          setSelectedRunId(null)
          runIdRef.current = null
        }
      }
      if (!disposed) timer = window.setTimeout(() => void tick(), SNAPSHOT_POLL_MS)
    }
    void tick()
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [sourceId, range, refreshToken])

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  )
  runningRef.current = selectedRun?.status === 'running'

  // 事件拉取：切 run 全量拉，running run 增量轮询。
  useEffect(() => {
    if (!sourceId || !selectedRunId) {
      setEvents([])
      setEventsState('idle')
      return
    }
    let disposed = false
    let timer: number | null = null
    setEvents([])
    setEventsState('loading')
    setEventsError(null)

    const loadFull = async (): Promise<void> => {
      try {
        const loaded = await fetchAllEvents(sourceId, selectedRunId)
        if (disposed) return
        setEvents(loaded)
        setEventsState('ready')
      } catch (error) {
        if (disposed) return
        setEventsState('error')
        setEventsError(errorMessage(error))
      }
    }

    const pollIncremental = async (): Promise<void> => {
      // 只让「运行中」的 run 走增量轮询；终态 run 的事件不会变，无需重复请求。
      if (!runningRef.current) {
        setEventsLive(false)
        return
      }
      setEventsLive(true)
      try {
        const lastSeq = eventsRef.current.reduce((max, event) => Math.max(max, event.seq), 0)
        const response = await loadRunEvents(sourceId, selectedRunId, lastSeq, EVENT_PAGE_LIMIT)
        if (disposed || response.events.length === 0) return
        setEvents((previous) => upsertEvents(previous, response.events))
      } catch {
        // 增量失败不打断面板：下一轮轮询会补上。
      }
    }

    void loadFull().then(() => {
      if (disposed) return
      timer = window.setInterval(() => void pollIncremental(), RUNNING_EVENTS_POLL_MS)
    })

    return () => {
      disposed = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [sourceId, selectedRunId, refreshToken])

  eventsRef.current = events

  const selectRun = useCallback((runId: string) => {
    runIdRef.current = runId
    setSelectedRunId(runId)
  }, [])

  const insight = useMemo(() => {
    if (!selectedRun) return null
    return buildTrace(selectedRun, events, { price })
  }, [selectedRun, events, price])

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), [])

  sourcesRef.current = sources

  const source = useMemo(
    () => sources.find((item) => item.id === sourceId) ?? null,
    [sources, sourceId],
  )

  return {
    sources,
    sourceId,
    selectSource,
    source,
    sourcesWarning,
    runs,
    runsState,
    runsError,
    range,
    setRange,
    selectedRunId,
    selectRun,
    selectedRun,
    events,
    eventsState,
    eventsError,
    eventsLive,
    insight,
    refresh,
    lastSyncedAt,
  }
}
