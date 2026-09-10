import type {
  AgentStatusSnapshot,
  AgentWorkspaceRunStatus,
  AgentWorkspaceState,
  AgentWorkspaceStatus,
} from '@nxcore/agent-contract'
import {
  Activity,
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

import './AgentStatusPage.css'
import { PelicanRider } from './PelicanRider'
import { subscribeRider, type RiderMode } from './riderTicker'

type StatusFilter = 'all' | AgentWorkspaceState

const EMPTY_SNAPSHOT: AgentStatusSnapshot = {
  generatedAt: new Date(0).toISOString(),
  summary: { total: 0, running: 0, idle: 0, error: 0 },
  agents: [],
}

const SPRITE_COLORS = ['#bc554c', '#c28645', '#6673b8', '#bd6571', '#4f8eaa', '#8b6aad', '#3f8f6d', '#a8683f']
const ROAD_START = 8
const ROAD_END = 92
const ZONE_GAP = 2.5
const TRANSIT_TOP = '93%'
const SWIM_TRANSIT_TOP = '48.2%'

// Formation depths: sprinters and cruisers alternate rows inside their zone,
// broken-down riders pull over on the shoulder. Riders changing speed swing
// out to the front corridor (TRANSIT_TOP) until they merge into their slot.
const LANE_NEAR = { lane: 'near', laneTop: '88.5%' }
const LANE_FAR = { lane: 'far', laneTop: '71%' }
const LANE_SHOULDER = { lane: 'shoulder', laneTop: '61%' }
// Idle pelicans leave the road and paddle on the sea in two depth rows.
// Back-row heads sit around the horizon; the front row rides low near the
// shoreline so the two rows read as clearly separated depths.
const SEA_FRONT = { lane: 'sea-front', laneTop: '51.5%' }
const SEA_BACK = { lane: 'sea-back', laneTop: '45%' }

// Gentle in-place sway so each formation feels alive without leaving its zone.
const SWAY_BY_STATE: Record<AgentWorkspaceState, { omega: number; amp: number }> = {
  running: { omega: 0.55, amp: 1.3 },
  idle: { omega: 0.22, amp: 1.7 },
  error: { omega: 0, amp: 0 },
}
// Catching up is brisk, easing off and drifting back is lazy.
const CATCH_UP_K = 1.0
const DROP_BACK_K = 0.3
const HOLD_K = 0.55
const TRANSIT_TRIGGER = 4

function stateLabel(state: AgentWorkspaceState, t: Translate): string {
  if (state === 'running') return t('surface:agentStatus.working')
  if (state === 'error') return t('surface:agentStatus.needsAttention')
  return t('surface:agentStatus.ready')
}

function riderSpeed(state: AgentWorkspaceState): number {
  if (state === 'running') return 1.05
  if (state === 'idle') return 0.34
  return 0
}

function elapsedLabel(date: string | null, t: Translate): string {
  if (!date) return t('surface:agentStatus.noRunHistory')
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime())
  if (elapsed < 60_000) return t('surface:agentStatus.justNow')
  if (elapsed < 3_600_000) return t('surface:agentStatus.countMinutesAgo', { count: Math.floor(elapsed / 60_000) })
  if (elapsed < 86_400_000) return t('surface:agentStatus.countHoursAgo', { count: Math.floor(elapsed / 3_600_000) })
  return t('surface:agentStatus.countDaysAgo', { count: Math.floor(elapsed / 86_400_000) })
}

function runStatusLabel(status: AgentWorkspaceRunStatus, t: Translate): string {
  if (status === 'accepted') return t('surface:agentStatus.accepted')
  if (status === 'running') return t('surface:agentStatus.runRunning')
  if (status === 'completed') return t('surface:agentStatus.completed')
  if (status === 'failed') return t('surface:agentStatus.failed')
  if (status === 'cancelled') return t('surface:agentStatus.cancelled')
  if (status === 'timed_out') return t('surface:agentStatus.timedOut')
  return t('surface:agentStatus.interrupted')
}

function StateMark({ state }: { state: AgentWorkspaceState }) {
  if (state === 'running') return <LoaderCircle aria-hidden="true" />
  if (state === 'error') return <CircleAlert aria-hidden="true" />
  return <Check aria-hidden="true" />
}

function bubbleDetail(agent: AgentWorkspaceStatus, t: Translate): string {
  if (agent.state === 'running') return agent.currentRun?.task ?? stateLabel('running', t)
  if (agent.state === 'error') return stateLabel('error', t)
  return agent.description || stateLabel('idle', t)
}

function CoastRider({
  agent,
  seed,
  slot,
  selected,
  onSelect,
  t,
}: {
  agent: AgentWorkspaceStatus
  seed: number
  slot: { x: number; depth: { lane: string; laneTop: string }; scale: number; mode: RiderMode }
  selected: boolean
  onSelect: () => void
  t: Translate
}) {
  const { x: slotX, depth, scale, mode } = slot
  const color = SPRITE_COLORS[seed % SPRITE_COLORS.length]!
  const buttonRef = useRef<HTMLButtonElement>(null!)
  const rideX = useRef(slotX)
  const transiting = useRef(false)
  const lastTime = useRef<number | null>(null)

  useEffect(() => {
    const sway = SWAY_BY_STATE[agent.state]!
    return subscribeRider((time) => {
      const dt = lastTime.current === null ? 0 : Math.max(0, Math.min(time - lastTime.current, 0.05))
      lastTime.current = time
      const target = slotX + Math.sin(time * sway.omega + seed * 1.7) * sway.amp
      const drift = slotX - rideX.current
      const k = drift > 0.5 ? CATCH_UP_K : drift < -0.5 ? DROP_BACK_K : HOLD_K
      rideX.current += (target - rideX.current) * Math.min(1, k * dt)

      const button = buttonRef.current
      const parent = button.parentElement
      if (parent) {
        const dx = ((rideX.current - slotX) / 100) * parent.clientWidth
        button.style.setProperty('--ride-dx', `${dx.toFixed(1)}px`)
      }

      const shouldTransit = Math.abs(rideX.current - slotX) > TRANSIT_TRIGGER
      if (shouldTransit !== transiting.current) {
        transiting.current = shouldTransit
        button.dataset.transit = String(shouldTransit)
        button.style.top = shouldTransit ? (mode === 'swimming' ? SWIM_TRANSIT_TOP : TRANSIT_TOP) : depth.laneTop
      }
    })
  }, [agent.state, slotX, depth.laneTop, seed])

  return (
    <button
      ref={buttonRef}
      type="button"
      className="coast-rider"
      data-state={agent.state}
      data-mode={mode}
      data-lane={depth.lane}
      data-selected={String(selected)}
      style={{ left: `${slotX}%`, top: depth.laneTop, '--sprite-color': color, '--rider-scale': scale } as CSSProperties}
      title={`${agent.name} · ${stateLabel(agent.state, t)}`}
      onClick={onSelect}
    >
      <span className="coast-rider-tag">
        <span className="coast-rider-tag-name"><i aria-hidden="true" />{agent.name}</span>
        <small>{bubbleDetail(agent, t)}</small>
      </span>
      <PelicanRider speed={riderSpeed(agent.state)} seed={seed} mode={mode} />
    </button>
  )
}

const GULLS = 'M240 96q7-9 14 0q7-9 14 0M560 58q6-8 12 0q6-8 12 0M905 128q5-6 10 0q5-6 10 0'
const ROAD_MARKS = 'M0 430H58M211 433H232M385 429H470M710 432H744M946 429H1018M1180 432H1211M60 560H150M320 563H420M640 560H760M1000 563H1110'
const ROAD_MARKS_WHITE = 'M100 500H232M517 500H649M934 500H1066'
const ROAD_MARKS_SMALL = 'M160 384h21M490 393h17M827 382h32M1105 394h15'
const GRASS_TUFTS = 'M0 330l-4-15M0 330l7-10M16 330l4-20M16 330l-7-9M598 336l-3-12M598 336l7-19M610 336l8-12M316 349h13M326 352h21M978 343h18'
const WATER_LINES = 'M-210 221H-128M85 250H203M300 210H350M411 276H466M762 233H807M1017 258H1113M1271 214H1337M1485 250H1603M1700 210H1750'
const COAST_FAR = 'M0 190Q80 158 170 172Q260 186 340 168Q420 152 505 176Q580 190 660 190ZM760 190Q830 168 905 174Q985 180 1050 162Q1120 148 1190 170Q1270 190 1350 190Z'
const COAST_NEAR = 'M120 190Q210 172 300 180Q390 188 470 178Q540 190 620 190ZM880 190Q950 176 1030 182Q1110 188 1180 178Q1250 186 1320 190Z'

function CoastScene({
  agents,
  runningCount,
  selectedAgentId,
  onSelect,
  t,
}: {
  agents: AgentWorkspaceStatus[]
  runningCount: number
  selectedAgentId: string | null
  onSelect: (agentId: string) => void
  t: Translate
}) {
  const groups = useMemo(() => {
    const byState: Record<AgentWorkspaceState, AgentWorkspaceStatus[]> = { running: [], idle: [], error: [] }
    for (const agent of agents) byState[agent.state].push(agent)
    return byState
  }, [agents])
  // Speed-ordered formation: idle pelicans paddle on the sea; on the road,
  // error riders park at the back and sprinters lead up front.
  const slots = useMemo(() => {
    const map = new Map<string, { x: number; depth: { lane: string; laneTop: string }; scale: number; mode: RiderMode }>()
    groups.idle.forEach((agent, index) => {
      map.set(agent.agentId, {
        x: 10 + (80 * (index + 0.5)) / groups.idle.length,
        depth: index % 2 === 0 ? SEA_FRONT : SEA_BACK,
        scale: groups.idle.length >= 7 ? 0.58 : 0.7,
        mode: 'swimming',
      })
    })
    const road = (['error', 'running'] as const).filter((state) => groups[state].length > 0)
    const roadTotal = road.reduce((sum, state) => sum + groups[state].length, 0)
    const roadScale = roadTotal > 12 ? 0.62 : roadTotal > 9 ? 0.8 : 1
    const usable = ROAD_END - ROAD_START - ZONE_GAP * Math.max(0, road.length - 1)
    let cursor = ROAD_START
    for (const state of road) {
      const count = groups[state].length
      const width = (usable * count) / roadTotal
      groups[state].forEach((agent, index) => {
        const depth = state === 'error' ? LANE_SHOULDER : index % 2 === 0 ? LANE_NEAR : LANE_FAR
        map.set(agent.agentId, { x: cursor + (width * (index + 0.5)) / count, depth, scale: roadScale, mode: 'riding' })
      })
      cursor += width + ZONE_GAP
    }
    return map
  }, [groups])
  const scrollDuration = runningCount > 0 ? Math.max(18, 84 / runningCount) : 95

  return (
    <section className="coast-scene" aria-label={t('surface:agentStatus.agentOffice')} style={{ '--scroll-dur': `${scrollDuration}s` } as CSSProperties}>
      <svg className="coast-scene-art" viewBox="0 0 1440 620" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <path id="coast-cloud" d="M0 39C-7 24 8 12 25 17C31-5 67-5 76 17C91 10 111 20 112 35C125 35 137 43 138 49H-11C-11 44-6 40 0 39Z" fill="#f6faf1" />
        </defs>

        <rect x="-10" y="-10" width="1460" height="640" fill="#deeee8" />
        <circle cx="1150" cy="92" r="58" fill="#f6cb69" opacity=".35" />
        <circle cx="1150" cy="92" r="44" fill="#f6cb69" />

        <g className="coast-scroll coast-scroll-clouds">
          <g opacity=".92">
            <use href="#coast-cloud" x="150" y="46" />
            <use href="#coast-cloud" transform="translate(620 96) scale(.8)" />
            <use href="#coast-cloud" x="1010" y="36" />
            <use href="#coast-cloud" transform="translate(1330 110) scale(.7)" />
            <use href="#coast-cloud" transform="translate(470 132) scale(.6)" />
            <use href="#coast-cloud" x="1950" y="46" />
            <use href="#coast-cloud" transform="translate(2420 96) scale(.8)" />
            <use href="#coast-cloud" x="2810" y="36" />
            <use href="#coast-cloud" transform="translate(3130 110) scale(.7)" />
            <use href="#coast-cloud" transform="translate(2270 132) scale(.6)" />
          </g>
        </g>
        <g className="coast-scroll coast-scroll-gulls">
          <path d={GULLS} fill="none" stroke="#5c7a70" strokeWidth="2.4" strokeLinecap="round" />
          <path d={GULLS} fill="none" stroke="#5c7a70" strokeWidth="2.4" strokeLinecap="round" transform="translate(1800 0)" />
        </g>

        <rect x="-10" y="190" width="1460" height="112" fill="#8ec8c0" />
        <path d="M-10 190H1450" fill="none" stroke="#79b6b0" strokeWidth="2" />
        <g className="coast-scroll coast-scroll-coast">
          <path d={COAST_FAR} fill="#b5d2b7" />
          <path d={COAST_NEAR} fill="#a0c6ac" />
          <Lighthouse x={300} y={172} />
          <path d={COAST_FAR} fill="#b5d2b7" transform="translate(1350 0)" />
          <path d={COAST_NEAR} fill="#a0c6ac" transform="translate(1350 0)" />
          <Lighthouse x={1650} y={172} />
        </g>
        <g className="coast-scroll coast-scroll-water">
          <path d={WATER_LINES} fill="none" stroke="#c5e2d4" strokeWidth="3" strokeLinecap="round" />
          <path d={WATER_LINES} fill="none" stroke="#c5e2d4" strokeWidth="3" strokeLinecap="round" transform="translate(1400 0)" />
        </g>

        <rect x="-10" y="300" width="1460" height="54" fill="#c4d9b9" />
        <path d="M-10 301Q60 296 130 301T270 301T410 301T550 301T690 301T830 301T970 301T1110 301T1250 301T1390 301T1530 301" fill="none" stroke="#f4f7ec" strokeWidth="3" />
        <g className="coast-scroll coast-scroll-grass">
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d={GRASS_TUFTS} stroke="#78a895" strokeWidth="3" />
            <path d={GRASS_TUFTS} stroke="#aac8a9" strokeWidth="3" transform="translate(1440 0)" />
          </g>
          <g fill="#f8faf1">
            <circle cx="205" cy="344" r="1.9" /><circle cx="722" cy="338" r="1.6" /><circle cx="1238" cy="346" r="1.9" />
            <circle cx="1645" cy="344" r="1.9" /><circle cx="2162" cy="338" r="1.6" /><circle cx="2678" cy="346" r="1.9" />
          </g>
          <g fill="#f4cd6d">
            <circle cx="455" cy="340" r="1.5" /><circle cx="1005" cy="342" r="1.4" /><circle cx="1895" cy="340" r="1.5" /><circle cx="2445" cy="342" r="1.4" />
          </g>
          <Umbrella x={1080} y={338} />
          <Umbrella x={2520} y={338} />
        </g>

        <rect x="-10" y="352" width="1460" height="270" fill="#f1f3e9" />
        <path d="M-10 352H1450" fill="none" stroke="#fcfcf4" strokeWidth="5" />
        <g className="coast-scroll coast-scroll-road">
          <g fill="none" strokeLinecap="round">
            <path d={ROAD_MARKS} stroke="#d5dfcc" strokeWidth="3" />
            <path d={ROAD_MARKS_WHITE} stroke="#fffefa" strokeWidth="7" />
            <path d={ROAD_MARKS_SMALL} stroke="#d5dfcc" strokeWidth="2" />
            <path d={ROAD_MARKS} stroke="#d5dfcc" strokeWidth="3" transform="translate(1440 0)" />
            <path d={ROAD_MARKS_WHITE} stroke="#fffefa" strokeWidth="7" transform="translate(1440 0)" />
            <path d={ROAD_MARKS_SMALL} stroke="#d5dfcc" strokeWidth="2" transform="translate(1440 0)" />
          </g>
          <MilePost x={700} y={374} />
          <MilePost x={2140} y={374} />
        </g>
      </svg>

      <div className="coast-masthead" aria-hidden="true">
        <div>
          <p>EVERROOM COASTLINE</p>
          <h2>Pelicans on a roll.</h2>
        </div>
        <div className="coast-edition">A SEASIDE LOOP<br />AGENT PELOTON · NO. 001</div>
      </div>

      <div className="coast-agent-layer">
        {agents.map((agent, seed) => {
          const slot = slots.get(agent.agentId)
          if (!slot) return null
          return (
            <CoastRider
              key={agent.agentId}
              agent={agent}
              seed={seed}
              slot={slot}
              selected={agent.agentId === selectedAgentId}
              onSelect={() => onSelect(agent.agentId)}
              t={t}
            />
          )
        })}
      </div>
    </section>
  )
}

function Lighthouse({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M-7 0L-5-24H5L7 0Z" fill="#f6f3e6" stroke="#8fae9a" strokeWidth="1.5" />
      <path d="M-6.6-8H6.6L6-16H-6Z" fill="#de725e" />
      <path d="M-5-24L-4.4-30H4.4L5-24Z" fill="#4c6b60" />
      <circle cx="0" cy="-27" r="1.9" fill="#f6cb69" />
    </g>
  )
}

function Umbrella({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <line x1="0" y1="-26" x2="0" y2="0" stroke="#8a6a52" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M-15-26A15 15 0 0 1 15-26Z" fill="#de725e" stroke="#b3584c" strokeWidth="1.2" />
      <path d="M-15-26A15 15 0 0 1 -4-40L-4-26Z" fill="#f6f0dd" />
      <path d="M4-40A15 15 0 0 1 15-26L4-26Z" fill="#f6f0dd" />
      <rect x="22" y="-6" width="24" height="7" rx="2.5" fill="#8ec8c0" transform="rotate(-4 34 -2)" />
      <rect x="22" y="-3.5" width="24" height="2.4" rx="1.2" fill="#f6f0dd" transform="rotate(-4 34 -2)" />
      <circle cx="-20" cy="-3" r="4" fill="#f4cd6d" stroke="#d3a94e" strokeWidth="1" />
    </g>
  )
}

function MilePost({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="-2" y="0" width="4" height="14" fill="#f6f0dd" stroke="#c9c2ab" strokeWidth="1" />
      <rect x="-4.5" y="-4" width="9" height="5" rx="1" fill="#de725e" stroke="#b3584c" strokeWidth="1" />
    </g>
  )
}

export function AgentStatusPage() {
  const { t, formatDate } = useLocale()
  const [snapshot, setSnapshot] = useState<AgentStatusSnapshot>(EMPTY_SNAPSHOT)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (quiet = false) => {
    const api = window.nxcore?.agent
    if (!api) {
      setError(t('surface:agentStatus.theAgentServiceIsOnlyAvailableInThe'))
      return
    }
    if (!quiet) setRefreshing(true)
    try {
      const next = await api.getStatus()
      setSnapshot(next)
      setError(null)
      setSelectedAgentId((current) => (
        current && next.agents.some(({ agentId }) => agentId === current)
          ? current
          : next.agents[0]?.agentId ?? null
      ))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('surface:agentStatus.failedToLoadAgentStatus'))
    } finally {
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 3_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const visibleAgents = useMemo(
    () => snapshot.agents.filter((agent) => filter === 'all' || agent.state === filter),
    [filter, snapshot.agents],
  )
  const recentRuns = useMemo(
    () => [...snapshot.agents]
      .filter((agent) => agent.lastRun)
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')),
    [snapshot.agents],
  )

  return (
    <div className="page agent-status-page">
      <header className="agent-status-header">
        <div>
          <span className="agent-status-eyebrow"><Activity aria-hidden="true" /> {t('surface:agentStatus.everroomOffice')}</span>
          <h1>{t('surface:agentStatus.agentOffice')}</h1>
        </div>
        <div className="agent-status-actions">
          <span>{snapshot.summary.running > 0 ? t('surface:agentStatus.countAgentsWorking', { count: snapshot.summary.running }) : t('surface:agentStatus.allAgentsAvailable')}</span>
          <button type="button" aria-label={t('surface:agentStatus.refreshAgentStatus')} title={t('surface:agentStatus.refreshAgentStatus')} onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={refreshing ? 'agent-status-spin' : undefined} />
          </button>
        </div>
      </header>

      {error ? <div className="agent-status-error"><CircleAlert aria-hidden="true" />{error}</div> : null}

      <section className="agent-status-summary" aria-label={t('surface:agentStatus.statusSummary')}>
        <div><strong>{snapshot.summary.total}</strong><span>Agent</span></div>
        <div data-tone="running"><strong>{snapshot.summary.running}</strong><span>{stateLabel('running', t)}</span></div>
        <div data-tone="idle"><strong>{snapshot.summary.idle}</strong><span>{stateLabel('idle', t)}</span></div>
        <div data-tone="error"><strong>{snapshot.summary.error}</strong><span>{stateLabel('error', t)}</span></div>
      </section>

      <div className="agent-office-layout">
        <CoastScene agents={visibleAgents} runningCount={snapshot.summary.running} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} t={t} />
      </div>

      <section className="agent-office-toolbar">
        <div className="agent-office-filter-label"><span>{t('surface:agentStatus.officeView')}</span><strong>{t('surface:agentStatus.countAgentsPresent', { count: visibleAgents.length })}</strong></div>
        <div className="agent-status-filters" aria-label={t('surface:agentStatus.filterAgentStatus')}>
          {(['all', 'running', 'idle', 'error'] as const).map((value) => (
            <button key={value} type="button" data-active={String(filter === value)} onClick={() => setFilter(value)}>
              {value === 'all' ? t('surface:agentStatus.all') : stateLabel(value, t)}
            </button>
          ))}
        </div>
        <div className="agent-office-legend"><span data-state="running"><i />{stateLabel('running', t)}</span><span data-state="idle"><i />{stateLabel('idle', t)}</span><span data-state="error"><i />{stateLabel('error', t)}</span></div>
      </section>

      <section className="agent-recent-activity">
        <header><div><h2>{t('surface:agentStatus.recentActivity')}</h2><span>{t('surface:agentStatus.latestRunForEachAgent')}</span></div><span>{t('surface:agentStatus.updatedTime', { time: formatDate(snapshot.generatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}</span></header>
        <div>
          {recentRuns.map((agent) => (
            <button type="button" key={agent.agentId} onClick={() => setSelectedAgentId(agent.agentId)}>
              <i data-state={agent.state}><StateMark state={agent.state} /></i>
              <span><strong>{agent.lastRun?.task}</strong><small>{agent.name} · {agent.workspace.id}</small></span>
              <em>{agent.lastRun ? runStatusLabel(agent.lastRun.status, t) : ''}</em>
              <time><Clock3 aria-hidden="true" />{elapsedLabel(agent.updatedAt, t)}</time>
            </button>
          ))}
          {!recentRuns.length ? <div className="agent-activity-empty"><Sparkles aria-hidden="true" /><span>{t('surface:agentStatus.noAgentRunHistory')}</span></div> : null}
        </div>
      </section>
    </div>
  )
}
