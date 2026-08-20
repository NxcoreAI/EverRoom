import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import {
  Activity,
  Armchair,
  ArrowUpRight,
  Brain,
  Check,
  Circle,
  Clock3,
  Coffee,
  CookingPot,
  Database,
  FileText,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Sparkles,
  Toilet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { pageLabelKey } from '@/data/navigation'
import './AgentStatusPage.css'

const OFFICE_ZONES = ['desk', 'coffee', 'kitchen', 'lounge', 'restroom'] as const

type OfficeZone = typeof OFFICE_ZONES[number]
type ExecutionState = 'loading' | 'idle' | 'running' | 'error'

interface AgentStatusData {
  state: ExecutionState
  sessions: AgentSession[]
  active: AgentSessionSnapshot | null
  error: string | null
}

const INITIAL_DATA: AgentStatusData = { state: 'loading', sessions: [], active: null, error: null }

function elapsedLabel(date: string | null | undefined, locale: AppLocale, t: Translate): string {
  if (!date) return t('surface:agentStatus.justNow')
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime())
  if (elapsed < 60_000) return t('surface:agentStatus.justNow')
  if (elapsed < 3_600_000) return t('surface:agentStatus.countMinutesAgo', { count: Math.floor(elapsed / 60_000).toLocaleString(locale) })
  if (elapsed < 86_400_000) return t('surface:agentStatus.countHoursAgo', { count: Math.floor(elapsed / 3_600_000).toLocaleString(locale) })
  return t('surface:agentStatus.countDaysAgo', { count: Math.floor(elapsed / 86_400_000).toLocaleString(locale) })
}

function stateCopy(state: ExecutionState, t: Translate): string {
  if (state === 'running') return t('surface:agentStatus.working')
  if (state === 'loading') return t('surface:agentStatus.syncing')
  if (state === 'error') return t('surface:agentStatus.connectionError')
  return t('surface:agentStatus.freeToRoam')
}

function HorseMascot() {
  const { t } = useLocale()
  return (
    <svg viewBox="0 0 132 112" role="img" aria-label={t('surface:agentStatus.executionAgentHorseCharacter')}>
      <ellipse className="horse-shadow" cx="67" cy="102" rx="39" ry="7" />
      <g className="horse-body">
        <path className="horse-leg horse-leg-a" d="M38 72c-2 10-4 18-3 27" />
        <path className="horse-leg horse-leg-b" d="M51 77c4 8 7 16 9 23" />
        <path className="horse-leg horse-leg-c" d="M75 77c0 9 0 17-1 24" />
        <path className="horse-leg horse-leg-d" d="M86 71c5 8 9 17 12 25" />
        <path className="horse-tail" d="M32 52C16 48 18 34 7 29c17-2 25 8 31 18" />
        <ellipse className="horse-fill" cx="60" cy="57" rx="34" ry="23" />
        <path className="horse-neck" d="M77 49c5-14 5-30 17-39 10 3 18 13 17 25L91 61Z" />
        <path className="horse-head" d="M91 13c11-9 27-5 34 5-4 10-14 14-28 9Z" />
        <path className="horse-muzzle" d="M116 17c8 0 12 3 11 7-3 5-9 6-15 3" />
        <path className="horse-ear" d="m94 12-2-10 8 8m8 1 6-8v12" />
        <path className="horse-mane" d="M91 16c-7 8-8 19-8 29" />
        <circle className="horse-eye" cx="109" cy="16" r="2.5" />
        <path className="horse-saddle" d="M42 36h35l8 21H39Z" />
        <path className="horse-badge" d="M59 41v12m-6-6h12" />
      </g>
    </svg>
  )
}

function DeskAgent({ kind, label }: { kind: 'data' | 'memory' | 'document'; label: string }) {
  const Icon = kind === 'data' ? Database : kind === 'memory' ? Brain : FileText
  return (
    <div className="office-desk-agent" data-kind={kind}>
      <span className="office-agent-label">{label}</span>
      <div className="office-monitor"><i /><Monitor aria-hidden="true" /></div>
      <div className="office-agent-body"><Icon aria-hidden="true" /><i /></div>
      <div className="office-desk"><i /><i /></div>
    </div>
  )
}

export function AgentStatusPage({ onFocusAgent }: { onFocusAgent: () => void }) {
  const { locale, t } = useLocale()
  const [data, setData] = useState<AgentStatusData>(INITIAL_DATA)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [horseZone, setHorseZone] = useState<OfficeZone>('coffee')

  const refresh = useCallback(async (quiet = false) => {
    const api = window.nxcore?.agent
    if (!api) {
      setData({ state: 'error', sessions: [], active: null, error: t('surface:agentStatus.theAgentServiceIsOnlyAvailableInThe') })
      return
    }
    if (!quiet) setRefreshing(true)
    try {
      const sessions = (await api.listSessions())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const runningSession = sessions.find((session) => session.status === 'running')
      const active = runningSession ? await api.getSession(runningSession.id) : null
      setData({ state: active?.activeRun ? 'running' : 'idle', sessions, active, error: null })
      setUpdatedAt(new Date())
      if (active?.activeRun) setHorseZone('desk')
    } catch (cause) {
      setData((current) => ({ ...current, state: 'error', error: cause instanceof Error ? cause.message : t('surface:agentStatus.failedToLoadAgentStatus') }))
    } finally {
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const completedCount = useMemo(
    () => data.sessions.filter((session) => session.status === 'idle' && session.title).length,
    [data.sessions],
  )
  const recentSessions = data.sessions.filter((session) => session.title).slice(0, 3)
  const activeRun = data.active?.activeRun
  const currentTask = activeRun?.prompt || data.active?.session.title || t('surface:agentStatus.waitingForTheNextTask')

  const moveHorse = (zone: OfficeZone) => {
    if (data.state === 'running') return
    setHorseZone(zone)
  }

  return (
    <div className="page agent-office-page">
      <header className="agent-office-header">
        <div>
          <span className="agent-office-eyebrow"><Activity aria-hidden="true" /> {t('surface:agentStatus.agentOffice')}</span>
          <h1>{t('surface:agentStatus.everroomOffice')}</h1>
        </div>
        <div className="agent-office-actions">
          <span>{updatedAt ? t('surface:agentStatus.updatedTime', { time: updatedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) }) : t('surface:agentStatus.connecting')}</span>
          <button type="button" title={t('surface:agentStatus.refreshAgentStatus')} aria-label={t('surface:agentStatus.refreshAgentStatus')} onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={refreshing ? 'agent-office-spin' : undefined} />
          </button>
        </div>
      </header>

      <div className="agent-office-layout">
        <section className="office-scene" data-horse-zone={horseZone} data-running={String(data.state === 'running')}>
          <div className="office-back-wall" aria-hidden="true">
            <span className="office-window"><i /><i /><i /><i /></span>
            <span className="office-clock"><i /></span>
          </div>

          <button className="office-zone office-kitchen" data-active={String(horseZone === 'kitchen')} type="button" onClick={() => moveHorse('kitchen')}>
            <span><CookingPot aria-hidden="true" /> {t('surface:agentStatus.kitchen')}</span>
            <div className="kitchen-counter"><i /><i /><i /></div>
            <div className="kitchen-fridge"><i /><i /></div>
          </button>

          <button className="office-zone office-coffee" data-active={String(horseZone === 'coffee')} type="button" onClick={() => moveHorse('coffee')}>
            <span><Coffee aria-hidden="true" /> {t('surface:agentStatus.cafe')}</span>
            <div className="coffee-table"><i /><i /><i /></div>
            <div className="coffee-sofa"><i /><i /></div>
          </button>

          <button className="office-zone office-restroom" data-active={String(horseZone === 'restroom')} type="button" onClick={() => moveHorse('restroom')}>
            <span><Toilet aria-hidden="true" /> {t('surface:agentStatus.restroom')}</span>
            <div className="restroom-stall"><i /></div>
            <div className="restroom-sink"><i /></div>
          </button>

          <button className="office-zone office-lounge" data-active={String(horseZone === 'lounge')} type="button" onClick={() => moveHorse('lounge')}>
            <span><Armchair aria-hidden="true" /> {t('surface:agentStatus.lounge')}</span>
            <div className="lounge-rug" />
            <div className="lounge-chair"><i /></div>
            <div className="lounge-plant"><i /><i /><i /></div>
          </button>

          <button className="office-zone office-workstations" data-active={String(horseZone === 'desk')} type="button" onClick={() => moveHorse('desk')}>
            <span><Monitor aria-hidden="true" /> {t('surface:agentStatus.agentWorkstations')}</span>
            <DeskAgent kind="data" label={t('surface:agentStatus.dataAgent')} />
            <DeskAgent kind="memory" label={t('surface:agentStatus.memoryAgent')} />
            <DeskAgent kind="document" label={t('surface:agentStatus.documentAgent')} />
            <div className="execution-desk">
              <span>{t('surface:agentStatus.executionAgent')}</span><Monitor aria-hidden="true" /><i /><i />
            </div>
          </button>

          <div className="horse-agent" aria-live="polite">
            <span>{t(data.state === 'running' ? 'surface:agentStatus.workingOnATask' : horseZone === 'desk' ? 'surface:agentStatus.readyToWork' : 'surface:agentStatus.takingABreak')}</span>
            <HorseMascot />
          </div>
          <div className="office-path" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        </section>

        <aside className="office-status-panel">
          <section className="primary-agent-status" data-state={data.state}>
            <header>
              <div className="status-orb"><Sparkles aria-hidden="true" /></div>
              <div><span>{t('surface:agentStatus.primaryAgent')}</span><h2>{t('surface:agentStatus.executionAgent')}</h2></div>
              <strong>{data.state === 'running' || data.state === 'loading' ? <LoaderCircle aria-hidden="true" /> : <Circle aria-hidden="true" />}{stateCopy(data.state, t)}</strong>
            </header>
            <div className="primary-task">
              <span>{t(data.state === 'running' ? 'surface:agentStatus.currentMission' : 'surface:agentStatus.readyForWork')}</span>
              <h3>{currentTask}</h3>
              <p>{data.state === 'running' ? t('surface:agentStatus.workingOnATaskInThePageWorkspace', { page: t(pageLabelKey(data.active?.session.pageLabel ?? 'Everroom')) }) : t('surface:agentStatus.selectAnOfficeAreaToMoveTheExecution')}</p>
            </div>
            <div className="primary-metrics">
              <div><strong>{data.state === 'running' ? '1' : '0'}</strong><span>{t('surface:agentStatus.inProgress')}</span></div>
              <div><strong>{completedCount.toLocaleString(locale)}</strong><span>{t('surface:agentStatus.completed')}</span></div>
              <div><strong>{data.sessions.length.toLocaleString(locale)}</strong><span>{t('surface:agentStatus.totalSessions')}</span></div>
            </div>
            <button type="button" onClick={onFocusAgent}><Sparkles aria-hidden="true" />{t('surface:agentStatus.startANewTask')}</button>
          </section>

          <section className="support-agent-status">
            <header><h2>{t('surface:agentStatus.agentStatus')}</h2><span>{t('surface:agentStatus.countOnline', { count: 3 })}</span></header>
            <div><i data-tone="data"><Database /></i><span><strong>{t('surface:agentStatus.dataAgent')}</strong><small>{t('surface:agentStatus.sourcesReady')}</small></span><Check /></div>
            <div><i data-tone="memory"><Brain /></i><span><strong>{t('surface:agentStatus.memoryAgent')}</strong><small>{t('surface:agentStatus.memoryServiceReady')}</small></span><Check /></div>
            <div><i data-tone="document"><FileText /></i><span><strong>{t('surface:agentStatus.documentAgent')}</strong><small>{t('surface:agentStatus.documentToolsReady')}</small></span><Check /></div>
          </section>
        </aside>
      </div>

      <section className="agent-activity">
        <header>
          <div><h2>{t('surface:agentStatus.recentActivity')}</h2><span>{data.error ?? t('surface:agentStatus.executionHistoryIsStoredInTheLocalGateway')}</span></div>
          <button type="button">{t('surface:agentStatus.allActivity')} <ArrowUpRight aria-hidden="true" /></button>
        </header>
        <div className="agent-activity-list">
          {recentSessions.length ? recentSessions.map((session) => (
            <div className="agent-activity-row" key={session.id}>
              <i data-running={String(session.status === 'running')}>{session.status === 'running' ? <LoaderCircle /> : <Check />}</i>
              <div><strong>{session.title}</strong><small>{t(pageLabelKey(session.pageLabel))} · {session.runtimeId}</small></div>
              <time><Clock3 />{elapsedLabel(session.updatedAt, locale, t)}</time>
            </div>
          )) : (
            <div className="agent-activity-empty"><Sparkles /><div><strong>{t('surface:agentStatus.noExecutionHistoryYet')}</strong><span>{t('surface:agentStatus.startTheFirstTaskFromTheAgentPanel')}</span></div></div>
          )}
        </div>
      </section>
    </div>
  )
}
