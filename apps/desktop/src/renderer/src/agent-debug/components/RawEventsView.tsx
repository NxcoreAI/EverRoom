import type { AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'
import { memo, useEffect, useMemo, useState } from 'react'

import { formatClock } from '../format'
import { eventCategory, type DebugFilters } from '../reducer'
import { CopyButton } from './CopyButton'
import { JsonView } from './JsonView'

const MAX_LIST_ROWS = 1200

function eventSummary(event: AgentDebugEvent): string {
  const payload = event.payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.delta === 'string') return record.delta.replace(/\s+/g, ' ').slice(0, 120)
    if (typeof record.name === 'string') {
      const id = typeof record.toolCallId === 'string' ? ` · ${record.toolCallId}` : ''
      return `${record.name}${id}`
    }
    if (typeof record.message === 'string') return record.message
    if (typeof record.approvalId === 'string') return `approval ${record.approvalId}`
    if (typeof record.content === 'string') return record.content.replace(/\s+/g, ' ').slice(0, 120)
  }
  return ''
}

const EventRow = memo(function EventRow({
  event,
  selected,
  onSelect,
}: {
  event: AgentDebugEvent
  selected: boolean
  onSelect: (seq: number) => void
}) {
  return (
    <button
      type="button"
      className="raw-row"
      data-selected={selected}
      onClick={() => onSelect(event.seq)}
      title={`#${event.seq} ${event.type} ${formatClock(event.occurredAt)}`}
    >
      <span className="raw-seq">#{event.seq}</span>
      <span className="raw-type">{event.type}</span>
      <span className="raw-summary">{eventSummary(event)}</span>
      <span className="raw-time">{formatClock(event.occurredAt)}</span>
    </button>
  )
})

interface RawEventsViewProps {
  events: AgentDebugEvent[]
  filters: DebugFilters
  run: AgentDebugRun | null
  loadError: string | null
}

export function RawEventsView({ events, filters, run, loadError }: RawEventsViewProps) {
  const filtered = useMemo(
    () => events.filter((event) => filters[eventCategory(event.type)]),
    [events, filters],
  )
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  useEffect(() => {
    setSelectedSeq((current) => {
      if (current !== null && filtered.some((event) => event.seq === current)) return current
      return filtered.length > 0 ? filtered[filtered.length - 1]!.seq : null
    })
  }, [filtered])

  const selected = useMemo(
    () => filtered.find((event) => event.seq === selectedSeq) ?? null,
    [filtered, selectedSeq],
  )
  const rows = filtered.length > MAX_LIST_ROWS ? filtered.slice(filtered.length - MAX_LIST_ROWS) : filtered

  return (
    <div className="raw">
      <div className="raw-head">
        <span>共 {events.length} 条</span>
        <span>显示 {filtered.length} 条</span>
        {run && run.droppedEvents > 0 ? <span>缓冲淘汰 {run.droppedEvents}</span> : null}
        {loadError ? <span>拉取失败，自动重试中</span> : null}
      </div>
      <div className="raw-body">
        <div className="scroll raw-list">
          {rows.map((event) => (
            <EventRow
              key={event.seq}
              event={event}
              selected={event.seq === selectedSeq}
              onSelect={setSelectedSeq}
            />
          ))}
          {rows.length === 0 ? <div className="empty-inline">暂无事件</div> : null}
          {filtered.length > rows.length ? (
            <div className="raw-more">仅渲染最近 {MAX_LIST_ROWS} 条，共 {filtered.length} 条</div>
          ) : null}
        </div>
        <div className="raw-detail">
          {selected ? (
            <>
              <div className="raw-detail-head">
                <span className="raw-detail-seq">#{selected.seq}</span>
                <span className="raw-detail-type">{selected.type}</span>
                <time>{formatClock(selected.occurredAt)}</time>
                {selected.truncatedBytes ? <span>截断 {selected.truncatedBytes} B</span> : null}
                <CopyButton text={JSON.stringify(selected, null, 2)} label="复制事件" />
              </div>
              <div className="scroll raw-json">
                <JsonView value={selected.payload} emptyText="（payload 为空）" />
              </div>
            </>
          ) : (
            <div className="empty-inline">选择一条事件查看 JSON</div>
          )}
        </div>
      </div>
    </div>
  )
}
