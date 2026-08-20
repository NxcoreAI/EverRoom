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
import './AgentStatusPage.css'

const PAGE_LABELS = ['首页', 'Context Room', '文档', '现实感知', '数据源', '文件', '记忆', 'Wiki', '任务', '日记', '设置']
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
  if (!date) return t('刚刚')
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime())
  if (elapsed < 60_000) return t('刚刚')
  if (elapsed < 3_600_000) return t('{count} 分钟前', { count: Math.floor(elapsed / 60_000).toLocaleString(locale) })
  if (elapsed < 86_400_000) return t('{count} 小时前', { count: Math.floor(elapsed / 3_600_000).toLocaleString(locale) })
  return t('{count} 天前', { count: Math.floor(elapsed / 86_400_000).toLocaleString(locale) })
}

function stateCopy(state: ExecutionState, t: Translate): string {
  if (state === 'running') return t('正在执行')
  if (state === 'loading') return t('正在同步')
  if (state === 'error') return t('连接异常')
  return t('自由活动')
}

function HorseMascot() {
  const { t } = useLocale()
  return (
    <svg viewBox="0 0 132 112" role="img" aria-label={t('执行 Agent 马形角色')}>
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
      setData({ state: 'error', sessions: [], active: null, error: t('Agent 服务仅在 Everroom 桌面端中可用。') })
      return
    }
    if (!quiet) setRefreshing(true)
    try {
      const pages = await Promise.all(PAGE_LABELS.map((label) => api.listSessions(label)))
      const sessions = Array.from(new Map(pages.flat().map((session) => [session.id, session])).values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const runningSession = sessions.find((session) => session.status === 'running')
      const active = runningSession ? await api.getSession(runningSession.id) : null
      setData({ state: active?.activeRun ? 'running' : 'idle', sessions, active, error: null })
      setUpdatedAt(new Date())
      if (active?.activeRun) setHorseZone('desk')
    } catch (cause) {
      setData((current) => ({ ...current, state: 'error', error: cause instanceof Error ? cause.message : t('无法读取 Agent 状态。') }))
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
  const currentTask = activeRun?.prompt || data.active?.session.title || t('等待下一项工作')

  const moveHorse = (zone: OfficeZone) => {
    if (data.state === 'running') return
    setHorseZone(zone)
  }

  return (
    <div className="page agent-office-page">
      <header className="agent-office-header">
        <div>
          <span className="agent-office-eyebrow"><Activity aria-hidden="true" /> {t('Agent 办公室')}</span>
          <h1>{t('Everroom 办公室')}</h1>
        </div>
        <div className="agent-office-actions">
          <span>{updatedAt ? t('更新于 {time}', { time: updatedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) }) : t('正在连接')}</span>
          <button type="button" title={t('刷新 Agent 状态')} aria-label={t('刷新 Agent 状态')} onClick={() => void refresh()} disabled={refreshing}>
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
            <span><CookingPot aria-hidden="true" /> {t('厨房')}</span>
            <div className="kitchen-counter"><i /><i /><i /></div>
            <div className="kitchen-fridge"><i /><i /></div>
          </button>

          <button className="office-zone office-coffee" data-active={String(horseZone === 'coffee')} type="button" onClick={() => moveHorse('coffee')}>
            <span><Coffee aria-hidden="true" /> {t('咖啡厅')}</span>
            <div className="coffee-table"><i /><i /><i /></div>
            <div className="coffee-sofa"><i /><i /></div>
          </button>

          <button className="office-zone office-restroom" data-active={String(horseZone === 'restroom')} type="button" onClick={() => moveHorse('restroom')}>
            <span><Toilet aria-hidden="true" /> {t('洗手间')}</span>
            <div className="restroom-stall"><i /></div>
            <div className="restroom-sink"><i /></div>
          </button>

          <button className="office-zone office-lounge" data-active={String(horseZone === 'lounge')} type="button" onClick={() => moveHorse('lounge')}>
            <span><Armchair aria-hidden="true" /> {t('休息区')}</span>
            <div className="lounge-rug" />
            <div className="lounge-chair"><i /></div>
            <div className="lounge-plant"><i /><i /><i /></div>
          </button>

          <button className="office-zone office-workstations" data-active={String(horseZone === 'desk')} type="button" onClick={() => moveHorse('desk')}>
            <span><Monitor aria-hidden="true" /> {t('Agent 工位')}</span>
            <DeskAgent kind="data" label={t('数据 Agent')} />
            <DeskAgent kind="memory" label={t('记忆 Agent')} />
            <DeskAgent kind="document" label={t('文档 Agent')} />
            <div className="execution-desk">
              <span>{t('执行 Agent')}</span><Monitor aria-hidden="true" /><i /><i />
            </div>
          </button>

          <div className="horse-agent" aria-live="polite">
            <span>{t(data.state === 'running' ? '正在执行任务' : horseZone === 'desk' ? '准备开工' : '摸鱼巡游中')}</span>
            <HorseMascot />
          </div>
          <div className="office-path" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        </section>

        <aside className="office-status-panel">
          <section className="primary-agent-status" data-state={data.state}>
            <header>
              <div className="status-orb"><Sparkles aria-hidden="true" /></div>
              <div><span>{t('主 Agent')}</span><h2>{t('执行 Agent')}</h2></div>
              <strong>{data.state === 'running' || data.state === 'loading' ? <LoaderCircle aria-hidden="true" /> : <Circle aria-hidden="true" />}{stateCopy(data.state, t)}</strong>
            </header>
            <div className="primary-task">
              <span>{t(data.state === 'running' ? '当前任务' : '工作就绪')}</span>
              <h3>{currentTask}</h3>
              <p>{data.state === 'running' ? t('正在 {page} 工作区处理任务。', { page: t(data.active?.session.pageLabel ?? 'Everroom') }) : t('点击办公室区域，可以让执行 Agent 在不同空间活动。')}</p>
            </div>
            <div className="primary-metrics">
              <div><strong>{data.state === 'running' ? '1' : '0'}</strong><span>{t('进行中')}</span></div>
              <div><strong>{completedCount.toLocaleString(locale)}</strong><span>{t('已完成')}</span></div>
              <div><strong>{data.sessions.length.toLocaleString(locale)}</strong><span>{t('总会话')}</span></div>
            </div>
            <button type="button" onClick={onFocusAgent}><Sparkles aria-hidden="true" />{t('发起新任务')}</button>
          </section>

          <section className="support-agent-status">
            <header><h2>{t('Agent 状态')}</h2><span>{t('{count} 个在线', { count: 3 })}</span></header>
            <div><i data-tone="data"><Database /></i><span><strong>{t('数据 Agent')}</strong><small>{t('数据源已就绪')}</small></span><Check /></div>
            <div><i data-tone="memory"><Brain /></i><span><strong>{t('记忆 Agent')}</strong><small>{t('记忆服务已就绪')}</small></span><Check /></div>
            <div><i data-tone="document"><FileText /></i><span><strong>{t('文档 Agent')}</strong><small>{t('文档能力已就绪')}</small></span><Check /></div>
          </section>
        </aside>
      </div>

      <section className="agent-activity">
        <header>
          <div><h2>{t('最近活动')}</h2><span>{data.error ?? t('执行记录保留在本地 Gateway')}</span></div>
          <button type="button">{t('全部记录')} <ArrowUpRight aria-hidden="true" /></button>
        </header>
        <div className="agent-activity-list">
          {recentSessions.length ? recentSessions.map((session) => (
            <div className="agent-activity-row" key={session.id}>
              <i data-running={String(session.status === 'running')}>{session.status === 'running' ? <LoaderCircle /> : <Check />}</i>
              <div><strong>{session.title}</strong><small>{t(session.pageLabel)} · {session.runtimeId}</small></div>
              <time><Clock3 />{elapsedLabel(session.updatedAt, locale, t)}</time>
            </div>
          )) : (
            <div className="agent-activity-empty"><Sparkles /><div><strong>{t('还没有执行记录')}</strong><span>{t('从右侧 Agent 面板发起第一个任务。')}</span></div></div>
          )}
        </div>
      </section>
    </div>
  )
}
