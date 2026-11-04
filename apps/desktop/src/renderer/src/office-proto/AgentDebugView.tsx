/**
 * 「Agent 调试」面板（独立窗口页面，入口见 debugEntry.tsx / debug.html）：
 * 左侧 Agent 列表（内置 / 子 Agent / 外部连接 / 本地 Agent），右侧按选中项展示
 * 系统上下文、各种上下文、工具上下文与运行记录。
 *
 * 入口：Agent 页头部的「调试」按钮 → 主进程打开独立窗口（单例）。
 * 数据：window.nxcore.agentDebug（网关 /v1/agent-debug/*，由主进程桥转发）；
 * 外部连接复用既有 window.nxcore.agentAccess，本地 Agent 复用 agent.discoverLocalAgents。
 * 纯只读，风格极简；顶部栏同时承担窗口拖拽区（Windows 自绘按钮见 WindowControls）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { WindowControls } from '@/components/WindowControls'
import type { AgentConnectionDto } from '@/shared/agent-access'
import type {
  AgentDebugAgentDetail,
  AgentDebugAgentSummary,
  AgentDebugAgentsResponse,
  AgentDebugAgentResponse,
  AgentDebugUsageResponse,
} from '@/shared/agent-debug'
import type { LocalAgentInstallation } from '@/shared/local-agents'
import type { NxcoreDesktopApi } from '@/shared/sources'

import {
  AgentDetailTab,
  ExternalConnectionPanel,
  LocalAgentPanel,
  type AgentDebugTab,
  type ConnectionDebugData,
} from './AgentDebugPanels'
import './agent-debug-view.css'

type AgentDebugApi = {
  listAgents(): Promise<AgentDebugAgentsResponse>
  getAgent(id: string): Promise<AgentDebugAgentResponse>
  listUsage(id: string, limit?: number): Promise<AgentDebugUsageResponse>
}

type Selection =
  | { group: 'builtin' | 'subagent'; id: string }
  | { group: 'external'; id: string }
  | { group: 'local'; id: string }

const TABS: Array<{ key: AgentDebugTab; label: string }> = [
  { key: 'system', label: '系统上下文' },
  { key: 'context', label: '上下文' },
  { key: 'tools', label: '工具' },
  { key: 'usage', label: '使用记录' },
]

function agentDebugApi(): AgentDebugApi | undefined {
  const api = window.nxcore as (NxcoreDesktopApi & { agentDebug?: AgentDebugApi }) | undefined
  return api?.agentDebug
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 运行中条目的已运行时长（列表/头部实时刷新用）。 */
function formatElapsed(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return null
  const seconds = Math.max(0, Math.round((now - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function AgentDebugView({ onClose }: { onClose: () => void }) {
  const [summaries, setSummaries] = useState<AgentDebugAgentSummary[]>([])
  const [connections, setConnections] = useState<AgentConnectionDto[]>([])
  const [localAgents, setLocalAgents] = useState<LocalAgentInstallation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bridgeMissing, setBridgeMissing] = useState(false)

  const [selection, setSelection] = useState<Selection | null>(null)
  const [tab, setTab] = useState<AgentDebugTab>('system')
  const [detail, setDetail] = useState<AgentDebugAgentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [usage, setUsage] = useState<AgentDebugUsageResponse | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [connectionDebug, setConnectionDebug] = useState<ConnectionDebugData | null>(null)
  const [connectionDebugLoading, setConnectionDebugLoading] = useState(false)
  const [connectionDebugError, setConnectionDebugError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 首屏：三组数据各自独立失败，不因一个数据源挂掉而整页报错。
  useEffect(() => {
    let cancelled = false
    const api = agentDebugApi()
    setBridgeMissing(!api)
    setLoading(true)
    setLoadError(null)
    void Promise.allSettled([
      api ? api.listAgents() : Promise.reject(new Error('bridge_missing')),
      window.nxcore?.agentAccess?.listConnections() ?? Promise.resolve({ connections: [] as AgentConnectionDto[] }),
      window.nxcore?.agent?.discoverLocalAgents() ?? Promise.resolve([] as LocalAgentInstallation[]),
    ]).then(([agentsResult, connectionsResult, localResult]) => {
      if (cancelled) return
      const nextSummaries = agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value?.agents)
        ? agentsResult.value.agents
        : []
      const nextConnections = connectionsResult.status === 'fulfilled' && Array.isArray(connectionsResult.value?.connections)
        ? connectionsResult.value.connections
        : []
      const nextLocal = localResult.status === 'fulfilled' && Array.isArray(localResult.value)
        ? localResult.value
        : []
      setSummaries(nextSummaries)
      setConnections(nextConnections)
      setLocalAgents(nextLocal)
      if (!api && nextConnections.length === 0 && nextLocal.length === 0) {
        setLoadError('未能加载 Agent 列表：桌面服务未就绪。')
      }
      const first = nextSummaries[0]
      if (first) {
        setSelection({ group: first.kind === 'subagent' ? 'subagent' : 'builtin', id: first.id })
      } else if (nextConnections[0]) {
        setSelection({ group: 'external', id: nextConnections[0].id })
      } else if (nextLocal[0]) {
        setSelection({ group: 'local', id: nextLocal[0].id })
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // 选中项变化：Agent 取详情；外部连接取旧的调试数据（提交 + 调用）。
  useEffect(() => {
    if (!selection) return undefined
    setTab('system')
    if (selection.group === 'builtin' || selection.group === 'subagent') {
      const api = agentDebugApi()
      if (!api) return undefined
      let cancelled = false
      setDetail(null)
      setDetailLoading(true)
      setDetailError(null)
      void api.getAgent(selection.id)
        .then((response) => { if (!cancelled) setDetail(response.agent) })
        .catch((error: unknown) => { if (!cancelled) setDetailError(errorMessage(error)) })
        .finally(() => { if (!cancelled) setDetailLoading(false) })
      return () => { cancelled = true }
    }
    if (selection.group === 'external') {
      const access = window.nxcore?.agentAccess
      if (!access) return undefined
      let cancelled = false
      setConnectionDebug(null)
      setConnectionDebugLoading(true)
      setConnectionDebugError(null)
      void Promise.all([access.submissions(selection.id), access.events(selection.id)])
        .then(([submissions, events]) => {
          if (cancelled) return
          setConnectionDebug({
            submissions: Array.isArray(submissions?.submissions) ? submissions.submissions : [],
            events: Array.isArray(events?.events) ? events.events : [],
          })
        })
        .catch((error: unknown) => { if (!cancelled) setConnectionDebugError(errorMessage(error)) })
        .finally(() => { if (!cancelled) setConnectionDebugLoading(false) })
      return () => { cancelled = true }
    }
    return undefined
  }, [selection])

  // 实时运行态：窗口可见时每 2s 刷新一次列表（state / activeRunCount / currentRun）。
  useEffect(() => {
    const api = agentDebugApi()
    if (!api) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void api.listAgents()
        .then((response) => {
          if (Array.isArray(response?.agents)) setSummaries(response.agents)
        })
        .catch(() => undefined)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [])

  // 秒级时钟：只为了让「运行中 · 已运行 12m」这类文案走动。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  // 使用记录：选中 Agent 后拉取并每 2.5s 刷新（运行中的记录会实时更新耗时/工具次数）。
  useEffect(() => {
    const isAgentSelection = selection?.group === 'builtin' || selection?.group === 'subagent'
    if (!selection || !isAgentSelection) {
      setUsage(null)
      setUsageError(null)
      setUsageLoading(false)
      return undefined
    }
    const api = agentDebugApi()
    if (!api?.listUsage) {
      setUsage(null)
      return undefined
    }
    let cancelled = false
    setUsage(null)
    setUsageLoading(true)
    setUsageError(null)
    const load = () => {
      void api.listUsage(selection.id, 20)
        .then((response) => {
          if (cancelled) return
          setUsage(response)
          setUsageError(null)
        })
        .catch((error: unknown) => {
          if (!cancelled) setUsageError(errorMessage(error))
        })
        .finally(() => {
          if (!cancelled) setUsageLoading(false)
        })
    }
    load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load()
    }, 2_500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selection])

  const runningIds = useMemo(
    () => new Set(summaries
      .filter((agent) => agent.state === 'running' || agent.activeRunCount > 0)
      .map((agent) => agent.id)),
    [summaries],
  )
  const runningAgents = useMemo(
    () => summaries.filter((agent) => runningIds.has(agent.id)),
    [summaries, runningIds],
  )
  const groupItems = useMemo(() => ({
    builtin: summaries.filter((agent) => agent.kind === 'builtin' && !runningIds.has(agent.id)),
    subagent: summaries.filter((agent) => agent.kind === 'subagent' && !runningIds.has(agent.id)),
  }), [summaries, runningIds])

  const select = useCallback((next: Selection) => setSelection(next), [])

  const summary = selection && (selection.group === 'builtin' || selection.group === 'subagent')
    ? summaries.find((agent) => agent.id === selection.id) ?? null
    : null
  const connection = selection?.group === 'external'
    ? connections.find((item) => item.id === selection.id) ?? null
    : null
  const localAgent = selection?.group === 'local'
    ? localAgents.find((item) => item.id === selection.id) ?? null
    : null

  const isAgent = selection?.group === 'builtin' || selection?.group === 'subagent'
  const agent = isAgent ? detail ?? summary : null
  // 列表轮询比详情更新得更勤：运行态以 summary 为准，避免详情缓存显示旧状态。
  const liveRun = summary?.currentRun ?? detail?.currentRun ?? null

  return (
    <div className="op-agent-debug-view" aria-label="Agent 调试">
      <header className="op-agent-debug-view-bar drag-region">
        <button
          type="button"
          className="op-agent-debug-back no-drag"
          title="关闭窗口（Esc）"
          aria-label="关闭窗口"
          onClick={onClose}
        >
          <ArrowLeft size={15} aria-hidden="true" strokeWidth={1.8} />
          <span>返回</span>
        </button>
        <span className="op-agent-debug-title">Agent 调试</span>
        <span className="op-agent-debug-subtitle">只读 · 运行时实际装配</span>
        <div className="op-agent-debug-view-actions no-drag">
          <WindowControls />
        </div>
      </header>

      <div className="op-agent-debug-body">
        <aside className="op-agent-debug-rail">
          <div className="op-agent-debug-rail-head">
            <span>Agent</span>
            <span className="op-agent-debug-count">
              {summaries.length + connections.length + localAgents.length}
            </span>
          </div>

          {bridgeMissing ? (
            <p className="op-agent-debug-hint">桌面服务未就绪：内置 / 子 Agent 不可用。</p>
          ) : null}
          {loadError ? <p className="op-agent-debug-error">{loadError}</p> : null}

          {runningAgents.length > 0 ? (
            <RailGroup
              title="运行中"
              live
              items={runningAgents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                tone: 'running',
                meta: formatElapsed(agent.currentRun?.startedAt, now),
                active: (selection?.group === 'builtin' || selection?.group === 'subagent') && selection.id === agent.id,
                onSelect: () => select({ group: agent.kind === 'subagent' ? 'subagent' : 'builtin', id: agent.id }),
              }))}
            />
          ) : null}

          {groupItems.builtin.length > 0 ? (
            <RailGroup
              title="内置 Agent"
              items={groupItems.builtin.map((agent) => ({
                id: agent.id,
                name: agent.name,
                tone: agent.state,
                active: selection?.group === 'builtin' && selection.id === agent.id,
                onSelect: () => select({ group: 'builtin', id: agent.id }),
              }))}
            />
          ) : null}

          {groupItems.subagent.length > 0 ? (
            <RailGroup
              title="子 Agent"
              items={groupItems.subagent.map((agent) => ({
                id: agent.id,
                name: agent.name,
                tone: agent.state,
                active: selection?.group === 'subagent' && selection.id === agent.id,
                onSelect: () => select({ group: 'subagent', id: agent.id }),
              }))}
            />
          ) : null}

          {connections.length > 0 ? (
            <RailGroup
              title="外部连接"
              items={connections.map((item) => ({
                id: item.id,
                name: item.name,
                tone: item.status === 'active' ? 'running' : item.status === 'paused' ? 'idle' : 'error',
                active: selection?.group === 'external' && selection.id === item.id,
                onSelect: () => select({ group: 'external', id: item.id }),
              }))}
            />
          ) : null}

          {localAgents.length > 0 ? (
            <RailGroup
              title="本地 Agent"
              items={localAgents.map((item) => ({
                id: item.id,
                name: item.displayName,
                tone: item.callable ? 'running' : 'idle',
                active: selection?.group === 'local' && selection.id === item.id,
                onSelect: () => select({ group: 'local', id: item.id }),
              }))}
            />
          ) : null}

          {loading ? <p className="op-agent-debug-hint">加载中…</p> : null}
        </aside>

        <section className="op-agent-debug-main">
          {!selection ? (
            <EmptyState loading={loading} />
          ) : (
            <>
              <header className="op-agent-debug-head">
                <h2>{agent?.name ?? connection?.name ?? localAgent?.displayName ?? selection.id}</h2>
                <p className="op-agent-debug-desc">
                  {agent?.description
                    ?? (connection ? `外部 Agent 连接 · ${connection.tool}` : null)
                    ?? localAgent?.card.description
                    ?? '—'}
                </p>
                <div className="op-agent-debug-meta">
                  {agent ? (
                    <>
                      <span>{agent.kind === 'subagent' ? '子 Agent' : '内置 Agent'}</span>
                      {agent.runtime ? <><b>·</b><span>{agent.runtime}</span></> : null}
                      {agent.model ? <><b>·</b><span>{agent.model}</span></> : null}
                      <b>·</b>
                      <span className="op-agent-debug-state">{agent.state === 'running' ? '运行中' : '待命'}</span>
                      <b>·</b>
                      <span>{agent.toolCount} 个工具</span>
                    </>
                  ) : null}
                  {connection ? (
                    <>
                      <span>{connection.status === 'active' ? '使用中' : connection.status === 'paused' ? '已暂停' : '已吊销'}</span>
                      <b>·</b>
                      <span>{connection.tokenPrefix}</span>
                    </>
                  ) : null}
                  {localAgent ? (
                    <>
                      <span>{localAgent.provider}</span>
                      {localAgent.version ? <><b>·</b><span>v{localAgent.version}</span></> : null}
                      <b>·</b>
                      <span>{localAgent.status}</span>
                    </>
                  ) : null}
                </div>
                {liveRun ? (
                  <p className="op-agent-debug-live">
                    <i className="op-agent-debug-live-dot" aria-hidden="true" />
                    <span>运行中</span>
                    <span>·</span>
                    <span>{liveRun.task || '（无任务描述）'}</span>
                    <span>·</span>
                    <span>已运行 {formatElapsed(liveRun.startedAt, now) ?? '—'}</span>
                  </p>
                ) : null}
              </header>

              {isAgent ? (
                <nav className="op-agent-debug-tabs" role="tablist">
                  {TABS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.key}
                      className={tab === item.key ? 'is-active' : ''}
                      onClick={() => setTab(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
              ) : null}

              <div className="op-agent-debug-content">
                {isAgent ? (
                  detailLoading ? <p className="op-agent-debug-hint">加载上下文…</p>
                    : detailError ? <p className="op-agent-debug-error">{detailError}</p>
                      : detail ? (
                        <AgentDetailTab
                          detail={detail}
                          tab={tab}
                          usage={usage}
                          usageLoading={usageLoading}
                          usageError={usageError}
                        />
                      )
                        : <p className="op-agent-debug-hint">暂无数据</p>
                ) : null}

                {selection.group === 'external' && connection ? (
                  <ExternalConnectionPanel
                    connection={connection}
                    debug={connectionDebug}
                    loading={connectionDebugLoading}
                    error={connectionDebugError}
                  />
                ) : null}

                {selection.group === 'local' && localAgent ? (
                  <LocalAgentPanel installation={localAgent} />
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function RailGroup({
  title,
  live = false,
  items,
}: {
  title: string
  live?: boolean
  items: Array<{ id: string; name: string; tone: string; active: boolean; meta?: string | null; onSelect: () => void }>
}) {
  return (
    <div className={`op-agent-debug-group${live ? ' is-live' : ''}`}>
      <div className="op-agent-debug-group-title">
        {live ? <i className="op-agent-debug-live-dot" aria-hidden="true" /> : null}
        {title}
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`op-agent-debug-item${item.active ? ' is-active' : ''}`}
          onClick={item.onSelect}
          title={item.name}
        >
          <span className="op-agent-debug-item-name">{item.name}</span>
          {item.meta ? <span className="op-agent-debug-item-meta">{item.meta}</span> : null}
          <span className={`op-agent-debug-dot is-${item.tone}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

function EmptyState({ loading }: { loading: boolean }) {
  if (loading) return <p className="op-agent-debug-hint">加载中…</p>
  return (
    <div className="op-agent-debug-empty">
      <p>没有可调试的 Agent。</p>
      <span>内置 Agent 来自网关运行时；外部连接与本地 Agent 分别来自 Agent 连接和本机发现。</span>
    </div>
  )
}