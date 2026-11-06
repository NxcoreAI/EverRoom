/**
 * 时间瀑布（概览主图）：默认**只看回合**，一行一个回合，条长 = 该回合墙钟。
 * 工具调用默认收起（点「显示工具」再展开）。异常用行首小圆点标记，不给整行染色。
 */
import { useMemo, useState } from 'react'

import { formatMs, formatPercent, formatTokens } from '../insight/format'
import { formatCost } from '../insight/pricing'
import type { GanttRow, TraceInsight } from '../insight/types'
import { isFuture, type PanelProps } from './panelTypes'
import { Panel } from './Panel'
import { pctOf, widthOf, TimeRuler } from './TimeScale'

import './gantt-lanes.css'

const MAX_ROWS = 24

export function GanttLanes({ insight, cursorMs, selectedStepId, onSelectStep, currency }: PanelProps & { currency: 'USD' | 'CNY' }) {
  const { wallMs, rounds, tools } = insight
  const [showTools, setShowTools] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [showAll, setShowAll] = useState(false)

  /** 每个回合的异常：失败工具数 / 是否慢回合。 */
  const roundFlags = useMemo(() => {
    const map = new Map<number, { failed: number; slow: boolean }>()
    for (const round of rounds) {
      map.set(round.index, { failed: 0, slow: round.latencyMs > 30_000 })
    }
    for (const tool of tools) {
      const entry = map.get(tool.roundIndex)
      if (entry && (tool.status === 'failed' || tool.status === 'timeout')) entry.failed += 1
    }
    return map
  }, [rounds, tools])

  const conclusions = useMemo(() => {
    if (rounds.length === 0) return null
    const sorted = [...rounds].sort((left, right) => right.latencyMs - left.latencyMs)
    const top = sorted.slice(0, 2)
    const share = top.reduce((sum, round) => sum + round.latencyMs, 0) / Math.max(1, wallMs)
    const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'timeout').length
    return { top, share, failed }
  }, [rounds, tools, wallMs])

  const rows = useMemo((): GanttRow[] => {
    const visible: GanttRow[] = []
    for (const row of insight.rows) {
      if (row.kind === 'llm') {
        const flags = roundFlags.get(row.roundIndex)
        const problem = (flags?.failed ?? 0) > 0 || row.severity !== 'ok'
        if (onlyProblems && !problem) continue
        visible.push(row)
        continue
      }
      if (!showTools) continue
      if (onlyProblems && row.severity === 'ok') continue
      visible.push(row)
    }
    return visible
  }, [insight.rows, roundFlags, onlyProblems, showTools])

  const limited = showAll ? rows : rows.slice(0, MAX_ROWS)
  const hidden = rows.length - limited.length

  const conclusion = conclusions === null
    ? '这条 run 还没有回合数据'
    : `${rounds.length} 个回合里，${conclusions.top.map((round) => `R${round.index}`).join(' 与 ')} 最慢，合计占 ${Math.round(conclusions.share * 100)}% 的墙钟${conclusions.failed > 0 ? `；有 ${conclusions.failed} 次工具调用失败（行首红点）` : ''}。`

  return (
    <Panel
      title="时间瀑布"
      meta={`${rounds.length} 回合 · ${tools.length} 次工具`}
      conclusion={conclusion}
      actions={(
        <>
          <button type="button" className={showTools ? 'gantt-toggle is-on' : 'gantt-toggle'} onClick={() => setShowTools((value) => !value)}>
            {showTools ? '隐藏工具' : '显示工具'}
          </button>
          <button type="button" className={onlyProblems ? 'gantt-toggle is-on' : 'gantt-toggle'} onClick={() => setOnlyProblems((value) => !value)}>
            只看异常
          </button>
        </>
      )}
    >
      <div className="gantt">
        <div className="gantt-head">
          <span className="gantt-col-label label">回合</span>
          <span className="gantt-col-track"><TimeRuler wallMs={wallMs} compact /></span>
          <span className="gantt-col-meta label">耗时</span>
        </div>

        {limited.length === 0 && <div className="gantt-empty">当前筛选下没有步骤</div>}

        {limited.map((row) => {
          const flags = roundFlags.get(row.roundIndex)
          const failed = (flags?.failed ?? 0) > 0
          const selected = selectedStepId === row.id
          const slowRound = row.severity === 'warn'
          return (
            <button
              key={row.id}
              type="button"
              className={row.kind === 'llm' ? 'gantt-row' : 'gantt-row gantt-row-tool'}
              data-selected={selected || undefined}
              data-future={isFuture(row.startMs, cursorMs) || undefined}
              onClick={() => onSelectStep(selected ? null : row.id)}
              title={row.kind === 'llm'
                ? `R${row.roundIndex} · 上下文 ${formatPercent(rounds[row.roundIndex - 1]?.contextPercent)} · ${formatTokens(rounds[row.roundIndex - 1]?.contextTokens)} tok · ${formatCost(rounds[row.roundIndex - 1]?.costUsd, currency)}`
                : `${row.label} · ${formatMs(row.endMs - row.startMs)}`}
            >
              <span className="gantt-label">
                {row.kind === 'llm'
                  ? <span className="gantt-round num">R{row.roundIndex}</span>
                  : <span className="gantt-tool-name">{row.label}</span>}
                {failed && <span className="gantt-flag" title={`${flags?.failed} 次调用失败`} />}
                {row.status === 'running' && <span className="gantt-flag gantt-flag-live" title="进行中" />}
              </span>
              <span className="gantt-track">
                <span
                  className="gantt-bar"
                  data-kind={row.kind}
                  data-slow={slowRound || undefined}
                  data-fail={row.severity === 'error' || undefined}
                  style={{ left: `${pctOf(row.startMs, wallMs)}%`, width: `${widthOf(row.startMs, row.endMs, wallMs)}%` }}
                />
                {row.kind === 'llm' && (rounds[row.roundIndex - 1]?.segments ?? []).map((segment, index) => (
                  <span
                    key={`gen-${index}`}
                    className="gantt-gen"
                    style={{ left: `${pctOf(segment.startMs, wallMs)}%`, width: `${widthOf(segment.startMs, segment.endMs, wallMs)}%` }}
                  />
                ))}
                {cursorMs !== null && <span className="gantt-cursor" style={{ left: `${pctOf(cursorMs, wallMs)}%` }} />}
              </span>
              <span className="gantt-duration num">{formatMs(row.endMs - row.startMs)}</span>
            </button>
          )
        })}

        {hidden > 0 && (
          <button type="button" className="gantt-more" onClick={() => setShowAll(true)}>
            还有 {hidden} 行，显示全部
          </button>
        )}
      </div>
    </Panel>
  )
}
