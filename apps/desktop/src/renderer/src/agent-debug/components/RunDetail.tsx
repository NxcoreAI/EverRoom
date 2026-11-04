import type { AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatClock } from '../format'
import { isArchivedRun, sessionLabelOf, sessionShortId } from '../history'
import type { DebugFilters, RunTimelineModel } from '../reducer'
import { slidePageBadge } from '../slidePage'
import { copyText } from './CopyButton'
import { LiveDuration, runStatusLabel } from './Indicators'
import { OutputView } from './OutputView'
import { RawEventsView } from './RawEventsView'
import { TimelineView } from './TimelineView'

type DetailTab = 'timeline' | 'events' | 'output'

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'timeline', label: '时间线' },
  { id: 'events', label: '事件' },
  { id: 'output', label: '输出' },
]

interface RunDetailProps {
  run: AgentDebugRun
  events: AgentDebugEvent[]
  model: RunTimelineModel
  filters: DebugFilters
  eventsError: string | null
}

export function RunDetail({ run, events, model, filters, eventsError }: RunDetailProps) {
  const [tab, setTab] = useState<DetailTab>('timeline')
  const [copiedRunId, setCopiedRunId] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setTab('timeline')
  }, [run.runId])

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
  }, [])

  const copyRunId = useCallback(() => {
    void copyText(run.runId).then((ok) => {
      if (!ok) return
      setCopiedRunId(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopiedRunId(false), 1400)
    })
  }, [run.runId])

  const running = run.status === 'running'
  // 归档 run 来自磁盘、只读回放：不显示「实时更新」，也不再拉增量（终态轮询自然停止）。
  const archived = isArchivedRun(run)
  const shortSessionId = sessionShortId(run.sessionId)
  const slidePage = slidePageBadge(run)
  const meta = [
    `runtime ${run.runtimeId ?? '—'}`,
    `session ${run.sessionId ?? '—'}`,
    `会话 ${sessionLabelOf(run)}${shortSessionId ? ` (#${shortSessionId})` : ''}`,
    `page ${run.pageLabel ?? '—'}`,
    ...(slidePage ? [`幻灯片 ${slidePage}`] : []),
    `开始 ${formatClock(run.startedAt)}`,
    `结束 ${run.completedAt ? formatClock(run.completedAt) : '—'}`,
    `事件 ${run.eventCount}`,
    `工具 ${run.toolCallCount}`,
  ].join(' · ')

  return (
    <section className="col col--detail" aria-label="Run 详情">
      <header className="detail-head">
        <div className="detail-line">
          <span className="detail-status" data-status={run.status}>{runStatusLabel(run.status)}</span>
          {archived ? (
            <span className="detail-origin" title="来自磁盘归档的历史 run，事件只读回放">历史归档 · 只读</span>
          ) : null}
          <span className="detail-agent">{run.agentName}</span>
          <button type="button" className="runid" onClick={copyRunId} title="点击复制 runId">
            {copiedRunId ? '已复制' : run.runId}
          </button>
          <span className="detail-duration">
            <LiveDuration startedAt={run.startedAt} completedAt={run.completedAt} running={running} />
          </span>
        </div>
        <div className="detail-meta" title={meta}>{meta}</div>
        <p className="detail-task" title={run.task}>{run.task || '（无任务摘要）'}</p>
        {run.droppedEvents > 0 ? (
          <p className="detail-warn">环形缓冲已淘汰 {run.droppedEvents} 条事件，时间线可能不完整。</p>
        ) : null}
        {run.errorMessage ? <p className="detail-error">{run.errorMessage}</p> : null}
      </header>
      <div className="detail-tabs" role="tablist" aria-label="Run 详情页签">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className="detail-tab"
            data-active={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        {running && !archived ? <span className="detail-hint">实时更新</span> : null}
      </div>
      <div className="detail-body">
        {tab === 'timeline' ? (
          <TimelineView
            runId={run.runId}
            blocks={model.blocks}
            filters={filters}
            runStatus={run.status}
            emptyHint={eventsError
              ? archived
                ? `历史归档事件读取失败：${eventsError}`
                : `事件拉取失败：${eventsError}（自动重试中）`
              : archived
                ? '该归档 run 没有可回放的事件'
                : '等待该 run 的事件'}
          />
        ) : null}
        {tab === 'events' ? (
          <RawEventsView events={events} filters={filters} run={run} loadError={eventsError} />
        ) : null}
        {tab === 'output' ? <OutputView run={run} output={model.output} /> : null}
      </div>
    </section>
  )
}
