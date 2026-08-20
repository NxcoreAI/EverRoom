import {
  Brain,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  FileText,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  PlugZap,
  Radio,
  RefreshCw,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import type { ConnectorSyncJob, ConnectorSyncRun } from '../../../../shared/connector-sync'
import type { PageId } from '@/data/navigation'
import { buildOfficeAgents, type OfficeAgent, type OfficeAgentStatus, type OfficeActivity } from '../office/officeModel'
import { PageHeader } from './PageHeader'
import './OfficePage.css'

type StatusFilter = 'all' | OfficeAgentStatus

const ICONS = { message: MessageSquare, plug: PlugZap, file: FileText, brain: Brain, radio: Radio, list: ListChecks }
const STATUS_LABELS: Record<OfficeAgentStatus, string> = {
  idle: '空闲', running: '运行中', waiting: '等待中', blocked: '已阻塞', error: '异常', offline: '离线',
}
const ACTIVITY_LABELS: Record<OfficeActivity['status'], string> = {
  running: '进行中', waiting: '等待中', completed: '已完成', failed: '失败',
}
function formatTime(value: string | null): string {
  if (!value) return '暂无活动'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无活动'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function StatusIcon({ status }: { status: OfficeAgentStatus }) {
  if (status === 'running') return <LoaderCircle className="office-status-icon is-spinning" aria-hidden="true" />
  if (status === 'error' || status === 'blocked') return <CircleAlert className="office-status-icon" aria-hidden="true" />
  if (status === 'waiting') return <CircleDashed className="office-status-icon" aria-hidden="true" />
  return <CheckCircle2 className="office-status-icon" aria-hidden="true" />
}

function ActivityStatusIcon({ status }: { status: OfficeActivity['status'] }) {
  if (status === 'running') return <LoaderCircle className="office-activity-status-icon is-spinning" aria-hidden="true" />
  if (status === 'failed') return <CircleAlert className="office-activity-status-icon" aria-hidden="true" />
  if (status === 'waiting') return <CircleDashed className="office-activity-status-icon" aria-hidden="true" />
  return <CheckCircle2 className="office-activity-status-icon" aria-hidden="true" />
}

function OfficeAgentCard({ agent, onActivityOpen }: { agent: OfficeAgent; onActivityOpen: (activity: OfficeActivity) => void }) {
  const AgentIcon = ICONS[agent.icon]
  return (
    <article className="office-agent-card" data-status={agent.status}>
      <header className="office-agent-card-header">
        <div className="office-agent-identity">
          <span className="office-agent-avatar"><AgentIcon aria-hidden="true" strokeWidth={1.8} /></span>
          <div><h2>{agent.name}</h2><p>{agent.description}</p></div>
        </div>
        <div className="office-agent-state" data-status={agent.status}>
          <StatusIcon status={agent.status} />
          <span>{STATUS_LABELS[agent.status]}</span>
        </div>
      </header>

      <div className="office-agent-metrics">
        <span><strong>{agent.activities.length}</strong> 个活动</span>
        {agent.sessionCount > 0 ? <span><strong>{agent.sessionCount}</strong> 个会话</span> : null}
        {agent.sourceCount > 0 ? <span><strong>{agent.sourceCount}</strong> 个来源</span> : null}
        <time>{formatTime(agent.updatedAt)}</time>
      </div>

      <div className="office-activity-list">
        {agent.activities.slice(0, 4).map((activity) => (
          <button key={activity.id} type="button" className="office-activity-row" onClick={() => onActivityOpen(activity)}>
            <ActivityStatusIcon status={activity.status} />
            <span className="office-activity-copy"><strong>{activity.title}</strong><small>{activity.detail}</small></span>
            <span className="office-activity-state" data-status={activity.status}>{ACTIVITY_LABELS[activity.status]}</span>
          </button>
        ))}
        {agent.activities.length === 0 ? <div className="office-agent-empty">当前没有活动</div> : null}
        {agent.activities.length > 4 ? <div className="office-more-activities">还有 {agent.activities.length - 4} 个活动</div> : null}
      </div>
    </article>
  )
}

export function OfficePage({ onNavigate, onFocusAgent }: { onNavigate: (page: PageId) => void; onFocusAgent: () => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [snapshots, setSnapshots] = useState<AgentSessionSnapshot[]>([])
  const [jobs, setJobs] = useState<ConnectorSyncJob[]>([])
  const [runsByJob, setRunsByJob] = useState<Map<string, ConnectorSyncRun[]>>(new Map())
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (background = false) => {
    if (!window.nxcore) {
      setError('办公室需要在 Everroom 桌面版中运行。')
      setLoading(false)
      return
    }
    if (background) setRefreshing(true)
    else setLoading(true)
    try {
      const [nextSessions, nextJobs] = await Promise.all([
        window.nxcore.agent.listSessions(),
        window.nxcore.cliConnectorSync.jobs(),
      ])
      const nextSnapshots = await Promise.all(nextSessions.map((session) => window.nxcore!.agent.getSession(session.id).catch(() => null)))
      const runGroups = await Promise.all(nextJobs.filter((job) => job.status !== 'archived').map(async (job) => {
        try { return [job.id, await window.nxcore!.cliConnectorSync.runs(job.id)] as const } catch { return [job.id, [] as ConnectorSyncRun[]] as const }
      }))
      setSessions(nextSessions)
      setSnapshots(nextSnapshots.filter((snapshot): snapshot is AgentSessionSnapshot => Boolean(snapshot)))
      setJobs(nextJobs)
      setRunsByJob(new Map(runGroups))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取 Agent 活动。')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => void reload(true), 5_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const agents = useMemo(() => buildOfficeAgents(sessions, snapshots, jobs, runsByJob), [jobs, runsByJob, sessions, snapshots])
  const visibleAgents = useMemo(() => filter === 'all' ? agents : agents.filter((agent) => agent.status === filter), [agents, filter])
  const activeCount = agents.filter((agent) => agent.status === 'running' || agent.status === 'waiting').length
  const activityCount = agents.reduce((total, agent) => total + agent.activities.length, 0)

  const openActivity = (activity: OfficeActivity) => {
    if (activity.agentId === 'core.connector') onNavigate('connectors')
    else onFocusAgent()
  }

  return (
    <div className="page office-page" data-testid="office-page">
      <PageHeader
        title="办公室"
        description="查看所有 Agent 的当前工作与活动"
        extraAction={<button type="button" className="icon-button office-refresh-button" title="刷新活动" aria-label="刷新活动" onClick={() => void reload(true)} disabled={refreshing}><RefreshCw className={refreshing ? 'is-spinning' : ''} /></button>}
      />

      <section className="office-overview" aria-label="办公室概览">
        <div><span className="office-overview-label">当前活跃</span><strong>{activeCount}</strong><small>个 Agent</small></div>
        <div><span className="office-overview-label">活动总数</span><strong>{activityCount}</strong><small>项活动</small></div>
        <div className="office-overview-note"><Users aria-hidden="true" /><span>同一职责下的多个会话和连接器已归并展示</span></div>
      </section>

      <nav className="office-filters" aria-label="Agent 状态筛选">
        {([['all', '全部'], ['running', '运行中'], ['waiting', '等待中'], ['error', '异常'], ['idle', '空闲']] as const).map(([value, label]) => (
          <button key={value} type="button" data-active={String(filter === value)} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </nav>

      {error ? <div className="office-alert" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></div> : null}
      {loading ? <div className="office-loading"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取 Agent 活动</div> : null}
      {!loading && visibleAgents.length === 0 ? <div className="office-empty"><PlugZap aria-hidden="true" /><strong>没有匹配的 Agent</strong><span>切换筛选条件查看其他状态。</span></div> : null}
      {!loading ? <section className="office-agent-grid" aria-label="Agent 列表">{visibleAgents.map((agent) => <OfficeAgentCard key={agent.id} agent={agent} onActivityOpen={openActivity} />)}</section> : null}
    </div>
  )
}
