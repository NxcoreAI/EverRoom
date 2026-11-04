import type { AgentDebugAgent, AgentDebugRun } from '@nxcore/agent-contract'
import { memo, useMemo } from 'react'

import { formatRelativeTime } from '../format'
import { activeSlidePagesByAgent, formatSlidePageSummary, slidePagesTitle } from '../slidePage'
import { useBrowsingList, useBrowsingOrder } from '../useBrowsingList'
import { AGENT_KIND_LABEL } from './Indicators'

export type AgentKindTab = 'all' | 'builtin' | 'developer' | 'local'

const KIND_TABS: Array<{ id: AgentKindTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'builtin', label: '内置' },
  { id: 'developer', label: '子 Agent' },
  { id: 'local', label: '本机' },
]

interface AgentListProps {
  agents: AgentDebugAgent[]
  runs: AgentDebugRun[]
  kindTab: AgentKindTab
  onKindTabChange: (tab: AgentKindTab) => void
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
}

const agentIdOf = (agent: AgentDebugAgent): string => agent.id

function sortAgents(agents: AgentDebugAgent[]): AgentDebugAgent[] {
  const weight: Record<AgentDebugAgent['state'], number> = { running: 0, error: 1, idle: 2 }
  return [...agents].sort((left, right) => {
    const byState = weight[left.state] - weight[right.state]
    if (byState !== 0) return byState
    const leftAt = left.lastRunAt ? Date.parse(left.lastRunAt) : 0
    const rightAt = right.lastRunAt ? Date.parse(right.lastRunAt) : 0
    if (rightAt !== leftAt) return rightAt - leftAt
    return left.name.localeCompare(right.name)
  })
}

export const AgentList = memo(function AgentList({
  agents,
  runs,
  kindTab,
  onKindTabChange,
  selectedAgentId,
  onSelectAgent,
}: AgentListProps) {
  const runStats = useMemo(() => {
    const map = new Map<string, number>()
    for (const run of runs) map.set(run.agentId, (map.get(run.agentId) ?? 0) + 1)
    return map
  }, [runs])

  // 逐页任务（如 slides-layouter 单页布局）：聚合运行中页序，Agent 行直接显示在负责哪几页。
  const slidePagesByAgent = useMemo(() => activeSlidePagesByAgent(runs), [runs])

  const visibleAgents = useMemo(
    () => sortAgents(kindTab === 'all' ? agents : agents.filter((agent) => agent.kind === kindTab)),
    [agents, kindTab],
  )

  // 向下滚动回看时冻结行顺序（否则 snapshot 每次刷新都会按 running/最近活动重排）。
  const { scrollRef, browsing, onScroll, scrollToTop } = useBrowsingList(kindTab)
  const orderedAgents = useBrowsingOrder(visibleAgents, agentIdOf, browsing, kindTab)

  const globalStats = useMemo(() => {
    let running = 0
    for (const run of runs) if (run.status === 'running') running += 1
    return { running, total: runs.length }
  }, [runs])

  return (
    <aside className="col col--agents" aria-label="Agent 列表">
      <div className="col-head">
        <span className="col-title">Agent</span>
        <span className="col-count">{visibleAgents.length}</span>
      </div>
      <div className="kind-tabs" role="tablist" aria-label="Agent 类型">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={kindTab === tab.id}
            className="text-btn"
            data-active={kindTab === tab.id}
            onClick={() => onKindTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="scroll agent-list" ref={scrollRef} onScroll={onScroll}>
        <button
          type="button"
          className="agent-row"
          data-row-key="__all__"
          data-selected={selectedAgentId === 'all'}
          onClick={() => onSelectAgent('all')}
        >
          <span className="agent-row-top">
            <span className="agent-mark" data-state={globalStats.running > 0 ? 'running' : 'idle'} />
            <span className="agent-name">全部 Agent</span>
            <span className="agent-count">
              {globalStats.running > 0 ? `${globalStats.running}/${globalStats.total}` : globalStats.total}
            </span>
          </span>
          <span className="agent-sub">所有 run · {globalStats.total} 个</span>
        </button>
        {orderedAgents.map((agent) => {
          const total = runStats.get(agent.id) ?? 0
          const slidePages = slidePagesByAgent.get(agent.id)
          const pageSummary = slidePages ? formatSlidePageSummary(slidePages) : ''
          return (
            <button
              key={agent.id}
              type="button"
              className="agent-row"
              data-row-key={agent.id}
              data-selected={selectedAgentId === agent.id}
              title={`${agent.name}${agent.description ? `\n${agent.description}` : ''}\nid: ${agent.id}${slidePages ? `\n${slidePagesTitle(slidePages)}` : ''}`}
              onClick={() => onSelectAgent(agent.id)}
            >
              <span className="agent-row-top">
                <span className="agent-mark" data-state={agent.state} />
                <span className="agent-name">{agent.name}</span>
                <span className="agent-count">{total}</span>
              </span>
              <span className="agent-sub">
                {AGENT_KIND_LABEL[agent.kind]} · {formatRelativeTime(agent.lastRunAt)}
                {agent.activeRunCount > 0 ? ` · ${agent.activeRunCount} 运行` : ''}
                {slidePages && pageSummary
                  ? <span className="agent-pages" title={slidePagesTitle(slidePages)}>{` · ${pageSummary}`}</span>
                  : null}
              </span>
            </button>
          )
        })}
        {visibleAgents.length === 0 ? <div className="empty-inline">暂无该类型 Agent</div> : null}
      </div>
      {browsing ? (
        <button
          type="button"
          className="browse-jump"
          onClick={scrollToTop}
          title="浏览历史位置时列表顺序已固定（行内容仍实时更新）；点击回到顶部并恢复实时排序"
        >
          回到顶部
        </button>
      ) : null}
    </aside>
  )
})
