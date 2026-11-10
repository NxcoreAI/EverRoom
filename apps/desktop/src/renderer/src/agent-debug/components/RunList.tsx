import type { AgentDebugRun } from '@nxcore/agent-contract'
import { memo, useMemo } from 'react'

import { formatCharCount, formatMonthDayTime } from '../format'
import {
  ALL_SESSIONS,
  findSessionOption,
  groupRunsBySession,
  isArchivedRun,
  sessionLabelOf,
  sessionShortId,
  type SessionOption,
} from '../history'
import { slidePageBadge, slidePageTitle } from '../slidePage'
import { useBrowsingGroupOrder, useBrowsingList } from '../useBrowsingList'
import { LiveDuration, runStatusLabel } from './Indicators'

interface RunListProps {
  runs: AgentDebugRun[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  /** 当前跟踪对象的名称（Agent 名或「全部 Agent」）。 */
  agentTitle: string
  /** 是否展示每行的 Agent 名（跟踪全部时需要）。 */
  showAgent: boolean
  followLatest: boolean
  onToggleFollow: () => void
  /** 当前会话筛选值（ALL_SESSIONS / 空字符串「无会话」/ sessionId）。 */
  sessionFilter: string
  /** 由当前 runs 推导的会话筛选项（第一项固定「全部会话」）。 */
  sessionOptions: SessionOption[]
  onSessionFilterChange: (value: string) => void
  /** 列表空态文案（区分「无本次 run」与「无历史记录」）。 */
  emptyText: string
  /** 浏览锁序的重置键（Agent / 范围 / 会话筛选变化时回顶部并恢复实时排序）。 */
  browseKey: string
}

export const RunList = memo(function RunList({
  runs,
  selectedRunId,
  onSelectRun,
  agentTitle,
  showAgent,
  followLatest,
  onToggleFollow,
  sessionFilter,
  sessionOptions,
  onSessionFilterChange,
  emptyText,
  browseKey,
}: RunListProps) {
  const groups = useMemo(() => groupRunsBySession(runs), [runs])
  // 向下滚动回看时冻结组顺序与组内 run 顺序（否则 snapshot 每次刷新都会按活跃度重排）。
  const { scrollRef, browsing, onScroll, scrollToTop } = useBrowsingList(browseKey)
  const orderedGroups = useBrowsingGroupOrder(groups, browsing, browseKey)
  const runningCount = useMemo(() => runs.filter((run) => run.status === 'running').length, [runs])
  const activeOption = useMemo(
    () => findSessionOption(sessionOptions, sessionFilter),
    [sessionOptions, sessionFilter],
  )
  const filtering = activeOption !== null && activeOption.key !== ALL_SESSIONS
  // 「全部会话」下且存在多个会话时按会话分组：组头可点击直接筛选到该会话。
  const showGroups = !filtering && groups.length > 1

  const renderRun = (run: AgentDebugRun) => {
    const shortId = sessionShortId(run.sessionId)
    const pageBadge = slidePageBadge(run)
    return (
      <button
        key={run.runId}
        type="button"
        className="run-row"
        data-row-key={run.runId}
        data-status={run.status}
        data-selected={selectedRunId === run.runId}
        data-origin={isArchivedRun(run) ? 'archive' : 'live'}
        onClick={() => onSelectRun(run.runId)}
        title={run.task}
      >
        <span className="run-top">
          <span className="run-status" data-status={run.status}>{runStatusLabel(run.status)}</span>
          {pageBadge ? <span className="run-page" title={slidePageTitle(run) ?? undefined}>{pageBadge}</span> : null}
          {showAgent ? <span className="run-agent">{run.agentName}</span> : null}
          {isArchivedRun(run) ? (
            <span className="run-origin" title="来自磁盘归档的历史 run，只读回放">历史</span>
          ) : null}
          <span className="run-session" title={`会话 ${run.sessionId ?? '无'} · ${sessionLabelOf(run)}`}>
            {sessionLabelOf(run)}
            {shortId ? <span className="run-session-id">{` #${shortId}`}</span> : null}
          </span>
        </span>
        <span className="run-task">{run.task || '（无任务摘要）'}</span>
        <span className="run-meta">
          {formatMonthDayTime(run.startedAt)}
          {' · '}耗时 <LiveDuration startedAt={run.startedAt} completedAt={run.completedAt} running={run.status === 'running'} />
          {' · '}工具 {run.toolCallCount}
          {' · '}思考 {formatCharCount(run.reasoningChars)} 字
          {' · '}事件 {run.eventCount}
          {run.droppedEvents > 0 ? ` · 丢弃 ${run.droppedEvents}` : ''}
        </span>
      </button>
    )
  }

  return (
    <section className="col col--runs" aria-label="Run 列表">
      <div className="col-head">
        <span className="col-title">运行</span>
        <span className="col-count col-count--inline">
          {runningCount > 0 ? `${runningCount}/${runs.length}` : runs.length}
        </span>
        <select
          className="session-select"
          value={sessionFilter}
          onChange={(event) => onSessionFilterChange(event.target.value)}
          aria-label="会话筛选"
          title={activeOption?.title ?? '按会话筛选 run'}
        >
          {sessionOptions.map((option) => (
            <option key={option.key || '__no_session__'} value={option.key} title={option.title}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="text-btn follow-btn"
          data-active={followLatest}
          aria-pressed={followLatest}
          onClick={onToggleFollow}
          title={agentTitle}
        >
          跟随 {followLatest ? '开' : '关'}
        </button>
      </div>
      <div className="scroll run-list" ref={scrollRef} onScroll={onScroll}>
        {filtering && activeOption ? (
          <div className="session-filter-bar" title={activeOption.title}>
            <span className="session-filter-text">筛选：{activeOption.label}</span>
            <button
              type="button"
              className="text-btn"
              onClick={() => onSessionFilterChange(ALL_SESSIONS)}
            >
              全部会话
            </button>
          </div>
        ) : null}
        {showGroups
          ? orderedGroups.map((group) => (
            <div className="run-group" key={group.option.key || '__no_session__'}>
              <button
                type="button"
                className="run-group-head"
                data-row-key={`group:${group.option.key}`}
                onClick={() => onSessionFilterChange(group.option.key)}
                title={`${group.option.title}（点击只看该会话）`}
              >
                <span className="run-group-main">
                  <span className="run-group-name">{group.option.primary}</span>
                  <span className="run-group-meta">
                    {formatMonthDayTime(group.option.startedAt)}
                    {group.option.shortId ? ` · #${group.option.shortId}` : ''}
                  </span>
                </span>
                <span className="run-group-count">{group.option.count}</span>
              </button>
              {group.runs.map(renderRun)}
            </div>
          ))
          : orderedGroups.flatMap((group) => group.runs.map(renderRun))}
        {runs.length === 0 ? <div className="empty-inline">{emptyText}</div> : null}
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
    </section>
  )
})
