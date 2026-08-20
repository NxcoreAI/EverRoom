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

function elapsedLabel(date: string | null): string {
  if (!date) return '暂无运行记录'
  const elapsed = Math.max(0, Date.now() - new Date(date).getTime())
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return `${Math.floor(elapsed / 86_400_000)} 天前`
}

function stateLabel(state: AgentWorkspaceState): string {
  if (state === 'running') return '工作中'
  if (state === 'error') return '需关注'
  return '就绪'
}

function runStatusLabel(status: AgentWorkspaceRunStatus): string {
  if (status === 'accepted') return '已接收'
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'timed_out') return '超时'
  return '已中断'
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
}: {
  agent: AgentWorkspaceStatus
  index: number
  count: number
  selected: boolean
  onSelect: () => void
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
      title={`${agent.name} · ${stateLabel(agent.state)}`}
      onClick={onSelect}
    >
      <span className="office-sprite-bubble">{agent.state === 'running' ? '工作中' : agent.state === 'error' ? '需要关注' : agent.name}</span>
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
}: {
  agents: AgentWorkspaceStatus[]
  selectedAgentId: string | null
  onSelect: (agentId: string) => void
}) {
  return (
    <section className="office-scene" aria-label="Agent 办公室">
      <div className="office-wall" aria-hidden="true">
        <div className="office-window"><i /><i /><i /><i /></div>
        <div className="office-wall-shelf"><i /><i /><i /><i /></div>
        <div className="office-clock"><i /></div>
      </div>
      <div className="office-sign"><Activity aria-hidden="true" /> EVERROOM OFFICE</div>

      <div className="office-zone office-kitchen" aria-hidden="true">
        <span><CookingPot />补给站</span><div className="office-counter" /><div className="office-fridge" />
      </div>
      <div className="office-zone office-coffee" aria-hidden="true">
        <span><Coffee />休息区</span><div className="office-sofa" /><div className="office-table" />
      </div>
      <div className="office-zone office-lounge" aria-hidden="true">
        <span><Armchair />阅读角</span><div className="office-chair" /><div className="office-plant"><i /><i /><i /></div>
      </div>
      <div className="office-workstations">
        <div className="office-zone-label"><Monitor aria-hidden="true" />Agent 工位</div>
        <div className="office-desks">{agents.map((agent) => <i key={`seat-${agent.agentId}`} />)}</div>
        {agents.map((agent, index) => (
          <OfficeSprite
            key={agent.agentId}
            agent={agent}
            index={index}
            count={agents.length}
            selected={agent.agentId === selectedAgentId}
            onSelect={() => onSelect(agent.agentId)}
          />
        ))}
      </div>
      <div className="office-floor-path" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </section>
  )
}

export function AgentStatusPage() {
  const [snapshot, setSnapshot] = useState<AgentStatusSnapshot>(EMPTY_SNAPSHOT)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (quiet = false) => {
    const api = window.nxcore?.agent
    if (!api) {
      setError('Agent 服务仅在 EverRoom 桌面端中可用。')
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
      setError(cause instanceof Error ? cause.message : '无法读取 Agent 状态。')
    } finally {
      setRefreshing(false)
    }
  }, [])

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
          <span className="agent-status-eyebrow"><Activity aria-hidden="true" /> Agent office</span>
          <h1>Agent 办公室</h1>
        </div>
        <div className="agent-status-actions">
          <span>{snapshot.summary.running > 0 ? `${snapshot.summary.running} 个 Agent 正在工作` : '所有 Agent 均可调度'}</span>
          <button type="button" title="刷新 Agent 状态" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={refreshing ? 'agent-status-spin' : undefined} />
          </button>
        </div>
      </header>

      {error ? <div className="agent-status-error"><CircleAlert aria-hidden="true" />{error}</div> : null}

      <section className="agent-status-summary" aria-label="Agent 状态摘要">
        <div><strong>{snapshot.summary.total}</strong><span>Agent</span></div>
        <div data-tone="running"><strong>{snapshot.summary.running}</strong><span>工作中</span></div>
        <div data-tone="idle"><strong>{snapshot.summary.idle}</strong><span>就绪</span></div>
        <div data-tone="error"><strong>{snapshot.summary.error}</strong><span>需关注</span></div>
      </section>

      <div className="agent-office-layout">
        <OfficeScene agents={visibleAgents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} />
      </div>

      <section className="agent-office-toolbar">
        <div className="agent-office-filter-label"><span>办公室视图</span><strong>{visibleAgents.length} 个 Agent 在场</strong></div>
        <div className="agent-status-filters" aria-label="筛选 Agent 状态">
          {(['all', 'running', 'idle', 'error'] as const).map((value) => (
            <button key={value} type="button" data-active={String(filter === value)} onClick={() => setFilter(value)}>
              {value === 'all' ? '全部' : stateLabel(value)}
            </button>
          ))}
        </div>
        <div className="agent-office-legend"><span data-state="running"><i />工作中</span><span data-state="idle"><i />就绪</span><span data-state="error"><i />需关注</span></div>
      </section>

      <section className="agent-recent-activity">
        <header><div><h2>最近活动</h2><span>各 Agent 最近一次运行</span></div><span>更新于 {new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></header>
        <div>
          {recentRuns.map((agent) => (
            <button type="button" key={agent.agentId} onClick={() => setSelectedAgentId(agent.agentId)}>
              <i data-state={agent.state}><StateMark state={agent.state} /></i>
              <span><strong>{agent.lastRun?.task}</strong><small>{agent.name} · {agent.workspace.id}</small></span>
              <em>{agent.lastRun ? runStatusLabel(agent.lastRun.status) : ''}</em>
              <time><Clock3 aria-hidden="true" />{elapsedLabel(agent.updatedAt)}</time>
            </button>
          ))}
          {!recentRuns.length ? <div className="agent-activity-empty"><Sparkles aria-hidden="true" /><span>还没有 Agent 运行记录。</span></div> : null}
        </div>
      </section>
    </div>
  )
}
