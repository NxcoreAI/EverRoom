/** 左侧 run 轨道：搜索 + Agent 筛选（下拉）+ 精简列表（每条只留 3 行信息）。 */
import { useMemo, useState } from 'react'

import type { AgentDebugRun } from '@nxcore/agent-contract'

import type { RangeMode } from '../../agent-debug/history'
import { formatMs, formatRelative } from '../insight/format'

import './run-rail.css'

export type RailState = 'idle' | 'loading' | 'ready' | 'error'

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  interrupted: '打断',
}

interface RunRailProps {
  runs: AgentDebugRun[]
  selectedRunId: string | null
  onSelect: (runId: string) => void
  state: RailState
  error: string | null
  range: RangeMode
}

function durationOf(run: AgentDebugRun): number {
  const start = Date.parse(run.startedAt)
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

export function RunRail({ runs, selectedRunId, onSelect, state, error, range }: RunRailProps) {
  const [agentFilter, setAgentFilter] = useState('__all__')
  const [query, setQuery] = useState('')

  const agents = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>()
    for (const run of runs) {
      const entry = counts.get(run.agentId) ?? { name: run.agentName || run.agentId, count: 0 }
      entry.count += 1
      counts.set(run.agentId, entry)
    }
    return [...counts.entries()].map(([id, entry]) => ({ id, ...entry })).sort((left, right) => right.count - left.count)
  }, [runs])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return runs.filter((run) => {
      if (agentFilter !== '__all__' && run.agentId !== agentFilter) return false
      if (!needle) return true
      return `${run.agentName} ${run.task} ${run.sessionTitle ?? ''}`.toLowerCase().includes(needle)
    })
  }, [runs, agentFilter, query])

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">运行记录</span>
        <span className="rail-count num">{filtered.length}{filtered.length !== runs.length ? ` / ${runs.length}` : ''}</span>
        <span className="rail-scope">{range === 'archive' ? '历史' : range === 'live' ? '本次' : '全部'}</span>
      </div>

      <div className="rail-filters">
        <input
          className="rail-search"
          value={query}
          placeholder="搜索任务或会话"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索 run"
        />
        <select
          className="rail-select"
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          aria-label="按 Agent 筛选"
        >
          <option value="__all__">全部 Agent（{runs.length}）</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}（{agent.count}）</option>
          ))}
        </select>
      </div>

      <div className="rail-list">
        {state === 'loading' && runs.length === 0 && <div className="rail-note">正在加载…</div>}
        {state === 'error' && <div className="rail-note rail-note-error">{error ?? '加载失败'}</div>}
        {state !== 'loading' && filtered.length === 0 && (
          <div className="rail-note">{runs.length === 0 ? '该来源暂无运行记录' : '没有匹配的运行记录'}</div>
        )}
        {filtered.map((run) => (
          <button
            key={run.runId}
            type="button"
            className="rail-item"
            data-selected={run.runId === selectedRunId || undefined}
            onClick={() => onSelect(run.runId)}
            title={run.task}
          >
            <div className="rail-item-top">
              <span className="rail-agent">{run.agentName || run.agentId}</span>
              <span className="rail-status" data-status={run.status}>{STATUS_LABEL[run.status] ?? run.status}</span>
            </div>
            <div className="rail-task">{run.task || '（无任务描述）'}</div>
            <div className="rail-meta num">
              <span>{formatMs(durationOf(run))}</span>
              <span>{run.toolCallCount} 次工具</span>
              <span className="rail-time">{formatRelative(run.lastEventAt ?? run.startedAt)}</span>
              {run.origin === 'archive' && <span className="rail-origin">归档</span>}
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}
