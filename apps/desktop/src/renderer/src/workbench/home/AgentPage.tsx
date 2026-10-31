import type { ReactNode } from 'react'
import { Bot, Bug, RotateCw, Server } from 'lucide-react'

import { relativeTimeLabel } from '../types'
import { workbenchToast } from '../shell/toast'
import { Badge, Button, PageHeader, Spinner, type BadgeTone } from '../ui/primitives'
import { HomeNote, HomeSection } from './parts'
import {
  useAgentOverview,
  type LocalAgentView,
  type Loadable,
  type McpView,
  type RuntimeAgentView,
  type RuntimeAgentState,
  type RuntimeView,
  type UsageView,
} from './useAgentOverview'

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  custom: '自定义渠道',
}

const LOCAL_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  verified: { label: '已验证', tone: 'success' },
  history_available: { label: '有历史记录', tone: 'success' },
  discovered: { label: '已发现', tone: 'neutral' },
  unavailable: { label: '不可用', tone: 'warning' },
  unknown: { label: '状态未知', tone: 'neutral' },
}

const RUNTIME_STATE_META: Record<RuntimeAgentState, { label: string; tone: BadgeTone }> = {
  running: { label: '运行中', tone: 'running' },
  idle: { label: '空闲', tone: 'success' },
  error: { label: '异常', tone: 'danger' },
  unknown: { label: '状态未知', tone: 'neutral' },
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** Agent 页：真实 `agent.*` / `mcp.listServers` 状态，无 mock 记忆/人格/技能。 */
export function AgentPage() {
  const overview = useAgentOverview()

  const openDebugWindow = () => {
    const open = window.nxcore?.agentDebug?.openWindow
    if (!open) {
      workbenchToast('当前环境不支持打开 Agent 调试窗口')
      return
    }
    void open().catch((error) => {
      workbenchToast(error instanceof Error && error.message ? error.message : '打开调试窗口失败')
    })
  }

  const canOpenDebug = typeof window.nxcore?.agentDebug?.openWindow === 'function'
  const runtimeReady = overview.runtime.status === 'ready' ? overview.runtime.value : null
  const localReady = overview.localAgents.status === 'ready' ? overview.localAgents.value : null
  const mcpReady = overview.mcp.status === 'ready' ? overview.mcp.value : null
  const usageReady = overview.usage.status === 'ready' ? overview.usage.value : null

  return (
    <div className="wb-home-scroll">
      <PageHeader
        eyebrow="Agent"
        title="智能体"
        subtitle="主 Agent、本机 Agent、MCP 工具与近 7 天用量的真实状态。"
        actions={(
          <Button variant="secondary" icon={<Bug size={15} />} disabled={!canOpenDebug} onClick={openDebugWindow}>
            打开调试窗口
          </Button>
        )}
      />

      <HomeSection title="工作台 Agent" count={runtimeReady?.summary.total}>
        <RuntimeBlock
          state={overview.runtime}
          onRetry={overview.reload}
          render={(runtime) => <RuntimeContent runtime={runtime} />}
        />
      </HomeSection>

      <HomeSection title="本机 Agent" count={localReady?.length}>
        <LocalAgentBlock
          state={overview.localAgents}
          onRetry={overview.reload}
          render={(agents) => <LocalAgentContent agents={agents} />}
        />
      </HomeSection>

      <HomeSection title="MCP 工具" count={mcpReady?.servers.length}>
        <McpBlock state={overview.mcp} onRetry={overview.reload} render={(view) => <McpContent view={view} />} />
      </HomeSection>

      {overview.usage.status === 'error' ? (
        <HomeSection title="近 7 天用量">
          <HomeNote>
            用量数据暂不可用
            <Button variant="ghost" size="sm" icon={<RotateCw size={12} />} onClick={overview.reload}>重试</Button>
          </HomeNote>
        </HomeSection>
      ) : null}
      {usageReady ? (
        <HomeSection title="近 7 天用量">
          <UsageContent usage={usageReady} />
        </HomeSection>
      ) : null}
    </div>
  )
}

/* ───────────────── 通用块状态 ───────────────── */

function LoadingBlock() {
  return <div className="wb-home-state"><Spinner /> 正在读取…</div>
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <HomeNote>
      {message}
      <Button variant="ghost" size="sm" icon={<RotateCw size={12} />} onClick={onRetry}>重试</Button>
    </HomeNote>
  )
}

function RuntimeBlock({
  state, onRetry, render,
}: {
  state: Loadable<RuntimeView>
  onRetry: () => void
  render: (runtime: RuntimeView) => ReactNode
}) {
  if (state.status === 'loading') return <LoadingBlock />
  if (state.status === 'error') return <ErrorBlock message="Agent 服务暂不可用 · 检查桌面服务是否已启动。" onRetry={onRetry} />
  return <>{render(state.value)}</>
}

function LocalAgentBlock({
  state, onRetry, render,
}: {
  state: Loadable<LocalAgentView[]>
  onRetry: () => void
  render: (agents: LocalAgentView[]) => ReactNode
}) {
  if (state.status === 'loading') return <LoadingBlock />
  if (state.status === 'error') return <ErrorBlock message="本机 Agent 探测暂不可用。" onRetry={onRetry} />
  return <>{render(state.value)}</>
}

function McpBlock({
  state, onRetry, render,
}: {
  state: Loadable<McpView>
  onRetry: () => void
  render: (view: McpView) => ReactNode
}) {
  if (state.status === 'loading') return <LoadingBlock />
  if (state.status === 'error') return <ErrorBlock message="MCP 配置暂不可用。" onRetry={onRetry} />
  return <>{render(state.value)}</>
}

/* ───────────────── 各块内容 ───────────────── */

function RuntimeContent({ runtime }: { runtime: RuntimeView }) {
  return (
    <>
      <div className="wb-home-stat-grid">
        <StatCard label="Agent 总数" value={runtime.summary.total} />
        <StatCard label="运行中" value={runtime.summary.running} tone="running" />
        <StatCard label="空闲" value={runtime.summary.idle} />
        <StatCard label="异常" value={runtime.summary.error} tone={runtime.summary.error > 0 ? 'danger' : undefined} />
      </div>
      {runtime.agents.length === 0 ? (
        <HomeNote>网关还没有注册任何工作台 Agent。</HomeNote>
      ) : (
        <div className="wb-home-card-grid">
          {runtime.agents.map((agent) => <RuntimeAgentCard key={agent.id} agent={agent} />)}
        </div>
      )}
    </>
  )
}

function RuntimeAgentCard({ agent }: { agent: RuntimeAgentView }) {
  const meta = RUNTIME_STATE_META[agent.state]
  const runLabel = agent.currentRunTask
    ? `正在处理：${agent.currentRunTask}`
    : agent.activeRunCount > 0
      ? `${agent.activeRunCount} 个任务运行中`
      : agent.lastRunAt
        ? `上次运行 ${relativeTimeLabel(agent.lastRunAt)}`
        : '还没有运行记录'
  return (
    <article className="wb-home-agent-card">
      <span className="wb-home-agent-avatar" aria-hidden="true"><Bot size={16} /></span>
      <div className="wb-home-agent-main">
        <div className="wb-home-agent-title">
          <strong className="wb-home-truncate">{agent.name}</strong>
          <Badge tone={meta.tone} dot={agent.state === 'running'}>{meta.label}</Badge>
          {agent.kind === 'developer' ? <Badge tone="neutral">开发者</Badge> : null}
        </div>
        <span className="wb-home-agent-desc">{agent.description || '内置工作台 Agent'}</span>
        <span className="wb-home-agent-meta">{runLabel}</span>
      </div>
    </article>
  )
}

function LocalAgentContent({ agents }: { agents: LocalAgentView[] }) {
  if (agents.length === 0) {
    return <HomeNote>没有检测到本机 Agent · 安装 Codex / Claude Code 等 CLI 后会自动发现。</HomeNote>
  }
  return (
    <div className="wb-home-list">
      {agents.map((agent) => {
        const meta = LOCAL_STATUS_META[agent.status] ?? LOCAL_STATUS_META.unknown
        return (
          <div key={agent.id} className="wb-home-row is-static">
            <span className="wb-home-agent-avatar" aria-hidden="true"><Bot size={15} /></span>
            <span className="wb-home-row-main">
              <span className="wb-home-row-title">
                <span className="wb-home-truncate">{agent.displayName}</span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                {agent.callable ? <Badge tone="accent">可调用</Badge> : null}
              </span>
              <span className="wb-home-row-sub">
                {[
                  PROVIDER_LABELS[agent.provider] ?? agent.provider,
                  agent.version ? `v${agent.version}` : null,
                  agent.executablePath,
                ].filter((part): part is string => Boolean(part)).join(' · ')}
              </span>
              {agent.error ? <span className="wb-home-row-sub is-danger">{agent.error}</span> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function McpContent({ view }: { view: McpView }) {
  if (view.servers.length === 0) {
    return <HomeNote>还没有配置 MCP 服务 · 可在设置页添加 MCP 服务器后，这里会显示工具数量。</HomeNote>
  }
  return (
    <>
      <div className="wb-home-stat-grid is-compact">
        <StatCard label="MCP 服务" value={view.servers.length} />
        <StatCard label="已启用" value={view.enabledCount} />
        <StatCard label="已停用" value={view.servers.length - view.enabledCount} />
      </div>
      <div className="wb-home-list">
        {view.servers.slice(0, 8).map((server) => (
          <div key={server.name} className="wb-home-row is-static">
            <span className="wb-home-agent-avatar" aria-hidden="true"><Server size={15} /></span>
            <span className="wb-home-row-main">
              <span className="wb-home-row-title">
                <span className="wb-home-truncate">{server.name}</span>
                {server.disabled ? <Badge tone="neutral">已停用</Badge> : <Badge tone="success">已启用</Badge>}
              </span>
              <span className="wb-home-row-sub">
                {[server.url ? `http · ${server.url}` : server.command ? `stdio · ${server.command}` : '未配置启动命令']
                  .concat(server.lifecycle ? [server.lifecycle] : [])
                  .join(' · ')}
              </span>
            </span>
          </div>
        ))}
      </div>
      {view.servers.length > 8 ? (
        <HomeNote>仅显示前 8 个 MCP 服务，共 {view.servers.length} 个。</HomeNote>
      ) : null}
      {view.configPath ? <p className="wb-home-footnote">配置文件：{view.configPath}</p> : null}
    </>
  )
}

function UsageContent({ usage }: { usage: UsageView | null }) {
  if (!usage) return <HomeNote>网关未返回用量数据。</HomeNote>
  if (usage.totalTokens === 0 && usage.cacheHitTokens === 0) {
    return <HomeNote>近 7 天还没有用量记录。</HomeNote>
  }
  return (
    <>
      <div className="wb-home-stat-grid is-compact">
        <StatCard label="输入 tokens" value={usage.inputTokens} formatted />
        <StatCard label="输出 tokens" value={usage.outputTokens} formatted />
        <StatCard label="缓存命中 tokens" value={usage.cacheHitTokens} formatted />
      </div>
      <p className="wb-home-footnote">
        {[usage.provider, usage.model].filter((part): part is string => Boolean(part)).join(' · ') || '内置 Agent'}
        {' · '}近 7 天
      </p>
    </>
  )
}

function StatCard({
  label, value, tone, formatted = false,
}: {
  label: string
  value: number
  tone?: 'running' | 'danger'
  formatted?: boolean
}) {
  return (
    <div className="wb-home-stat">
      <span className={`wb-home-stat-value${tone ? ` is-${tone}` : ''}`}>
        {formatted ? formatNumber(value) : value}
      </span>
      <span className="wb-home-stat-label">{label}</span>
    </div>
  )
}
