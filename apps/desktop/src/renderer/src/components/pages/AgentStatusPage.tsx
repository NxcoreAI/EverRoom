import type {
  AgentStatusSnapshot,
  AgentWorkspaceRunStatus,
  AgentWorkspaceState,
  AgentWorkspaceStatus,
} from '@nxcore/agent-contract'
import {
  Activity,
  Armchair,
  Check,
  CircleAlert,
  Clock3,
  Coffee,
  CookingPot,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

import './AgentStatusPage.css'

type StatusFilter = 'all' | AgentWorkspaceState

const EMPTY_SNAPSHOT: AgentStatusSnapshot = {
  generatedAt: new Date(0).toISOString(),
  summary: { total: 0, running: 0, idle: 0, error: 0 },
  agents: [],
}

const SPRITE_COLORS = ['#2f8d72', '#c28645', '#6673b8', '#bd6571', '#4f8eaa', '#8b6aad']
const SPRITE_COLUMNS = ['20%', '50%', '80%']

function spritePosition(index: number, count: number): { left: string; top: string } {
  const row = Math.floor(index / SPRITE_COLUMNS.length)
  const rows = Math.max(1, Math.ceil(count / SPRITE_COLUMNS.length))
  const top = rows === 1 ? 60 : 38 + (row * 44) / (rows - 1)
  return { left: SPRITE_COLUMNS[index % SPRITE_COLUMNS.length]!, top: `${top}%` }
}

function elapsedLabel(date: string | null, t: Translate): string {
  if (!date) return t('surface:agentStatus.noRunHistory')
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime())
  if (elapsed < 60_000) return t('surface:agentStatus.justNow')
  if (elapsed < 3_600_000) return t('surface:agentStatus.countMinutesAgo', { count: Math.floor(elapsed / 60_000) })
  if (elapsed < 86_400_000) return t('surface:agentStatus.countHoursAgo', { count: Math.floor(elapsed / 3_600_000) })
  return t('surface:agentStatus.countDaysAgo', { count: Math.floor(elapsed / 86_400_000) })
}

function stateLabel(state: AgentWorkspaceState, t: Translate): string {
  if (state === 'running') return t('surface:agentStatus.working')
  if (state === 'error') return t('surface:agentStatus.needsAttention')
  return t('surface:agentStatus.ready')
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

function OfficeSprite({
  agent,
  index,
  count,
  selected,
  onSelect,
  t,
}: {
  agent: AgentWorkspaceStatus
  index: number
  count: number
  selected: boolean
  onSelect: () => void
  t: Translate
}) {
  const position = spritePosition(index, count)
  const color = SPRITE_COLORS[index % SPRITE_COLORS.length]!
  return (
    <button
      type="button"
      className="office-sprite"
      data-state={agent.state}
      data-selected={String(selected)}
      style={{ left: position.left, top: position.top, '--sprite-color': color } as CSSProperties}
      title={`${agent.name} · ${stateLabel(agent.state, t)}`}
      onClick={onSelect}
    >
      <span className="office-sprite-bubble">{agent.state === 'idle' ? agent.name : stateLabel(agent.state, t)}</span>
      <span className="office-sprite-head"><i /></span>
      <span className="office-sprite-body"><i /><i /></span>
      <span className="office-sprite-shadow" />
    </button>
  )
}

function OfficeScene({
  agents,
  selectedAgentId,
  onSelect,
  t,
}: {
  agents: AgentWorkspaceStatus[]
  selectedAgentId: string | null
  onSelect: (agentId: string) => void
  t: Translate
}) {
  return (
    <section className="office-scene" aria-label={t('surface:agentStatus.agentOffice')}>
      <div className="office-wall" aria-hidden="true">
        <div className="office-window"><i /><i /><i /><i /></div>
        <div className="office-wall-shelf"><i /><i /><i /><i /></div>
        <div className="office-clock"><i /></div>
      </div>
      <div className="office-sign"><Activity aria-hidden="true" /> EVERROOM OFFICE</div>

      <div className="office-zone office-kitchen" aria-hidden="true">
        <span><CookingPot />{t('surface:agentStatus.supplyStation')}</span><div className="office-counter" /><div className="office-fridge" />
      </div>
      <div className="office-zone office-coffee" aria-hidden="true">
        <span><Coffee />{t('surface:agentStatus.lounge')}</span><div className="office-sofa" /><div className="office-table" />
      </div>
      <div className="office-zone office-lounge" aria-hidden="true">
        <span><Armchair />{t('surface:agentStatus.readingCorner')}</span><div className="office-chair" /><div className="office-plant"><i /><i /><i /></div>
      </div>
      <div className="office-workstations">
        <div className="office-zone-label"><Monitor aria-hidden="true" />{t('surface:agentStatus.agentWorkstations')}</div>
        <div className="office-desks">{agents.map((agent) => <i key={`seat-${agent.agentId}`} />)}</div>
        {agents.map((agent, index) => (
          <OfficeSprite
            key={agent.agentId}
            agent={agent}
            index={index}
            count={agents.length}
            selected={agent.agentId === selectedAgentId}
            onSelect={() => onSelect(agent.agentId)}
            t={t}
          />
        ))}
      </div>
      <div className="office-floor-path" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </section>
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
        <OfficeScene agents={visibleAgents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} t={t} />
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
