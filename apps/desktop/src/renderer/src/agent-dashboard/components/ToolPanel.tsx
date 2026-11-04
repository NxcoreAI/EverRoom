/**
 * 工具调用：首屏只留「一句结论 + 耗时 Top5 细条 + 4 个指标」，
 * 聚合表 / 并发泳道 / 错误归类全部收进「展开明细」（默认收起）。
 * 数字只来自 insight.toolStats / tools / breakdown，不估算、不补零。
 */
import { useMemo, useState, type ReactNode } from 'react'

import { THRESHOLDS } from '../insight/analyze'
import { formatMs, formatRatio, formatShare } from '../insight/format'
import { dominantErrorClass, errorClassLabel } from '../insight/toolErrors'
import type { ToolCall, ToolErrorClass, ToolStat } from '../insight/types'
import { Metric, Panel } from './Panel'
import type { PanelProps } from './panelTypes'
import { isFuture } from './panelTypes'
import { TimeRuler, pctOf, widthOf } from './TimeScale'

import './tool-panel.css'

/** 首屏取前几名；聚合表默认行数；泳道最多逐条绘制多少次调用。 */
const TOP_BARS = 5
const TABLE_ROWS = 10
const MAX_LANE_BARS = 300

interface ErrorRow {
  errorClass: ToolErrorClass
  label: string
  count: number
  /** 该类错误落在哪些工具上（一行文本，超出省略）。 */
  tools: string
}

function isFailure(tool: ToolCall): boolean {
  return tool.status === 'failed' || tool.status === 'timeout' || tool.status === 'cancelled'
}

/** 条宽：最慢的工具算 100%，最短留 2%，让 1ms 的调用也有存在感。 */
function barWidth(stat: ToolStat, maxMs: number): number {
  if (!(maxMs > 0) || !Number.isFinite(stat.totalMs)) return 0
  return Math.max(2, Math.min(100, (stat.totalMs / maxMs) * 100))
}

function laneTone(tool: ToolCall): 'tool' | 'warn' | 'err' {
  if (tool.status === 'failed' || tool.status === 'timeout') return 'err'
  if (tool.severity === 'warn' || tool.status === 'cancelled') return 'warn'
  return 'tool'
}

/** 名称后的失败小标：只标次数，不把整条染红。 */
function FailureFlag({ count }: { count: number }) {
  return count > 0 ? <span className="tool-flag">失败 {count}</span> : null
}

/** 结论句里的「谁在报错」：能说重试就说重试，否则说清次数与归类。 */
function failureClause(worst: ToolStat, tools: readonly ToolCall[]): ReactNode {
  const label = dominantErrorClass(worst.errorClasses)
  if (label === null) {
    return <>；失败都在 <b>{worst.name}</b>（<b>{worst.failures}</b> 次，错误文本没能归类）</>
  }
  const retries = tools.filter((tool) => tool.name === worst.name && tool.repeatIndex > 0 && isFailure(tool)).length
  if (retries > 0) {
    return <>；真正的问题是 <b>{worst.name}</b> 因{errorClassLabel(label)}重试了 <b>{retries}</b> 次</>
  }
  return <>；<b>{worst.name}</b> 失败 <b>{worst.failures}</b> 次，全是{errorClassLabel(label)}</>
}

interface StatRowProps {
  stat: ToolStat
  /** bar = 首屏（细条 + 合计）；table = 明细表（调用 + 平均）。两者都是四列。 */
  mode: 'bar' | 'table'
  maxMs?: number
  targetId: string | null
  future: boolean
  selected: boolean
  onSelect: (stepId: string) => void
}

function StatRow({ stat, mode, maxMs = 0, targetId, future, selected, onSelect }: StatRowProps) {
  const bar = mode === 'bar'
  return (
    <button
      type="button"
      className={bar ? 'tool-bar' : 'tool-row'}
      data-future={future || undefined}
      data-selected={selected || undefined}
      data-slow={(bar && stat.avgMs > THRESHOLDS.slowStepMs) || undefined}
      disabled={targetId === null}
      title={`${stat.name} · ${stat.calls} 次 · 合计 ${formatMs(stat.totalMs)} · 平均 ${formatMs(stat.avgMs)} · 最大 ${formatMs(stat.maxMs)}`}
      onClick={() => targetId !== null && onSelect(targetId)}
    >
      <span className="tool-name">
        <span className="tool-name-text">{stat.name}</span>
        <FailureFlag count={stat.failures} />
      </span>
      {bar ? (
        <span className="tool-bar-track">
          <span className="tool-bar-fill" style={{ width: `${barWidth(stat, maxMs)}%` }} />
        </span>
      ) : (
        <span className="num tool-col-num">{stat.calls}</span>
      )}
      <span className="num tool-col-num">{formatMs(bar ? stat.totalMs : stat.avgMs)}</span>
      <span className="num tool-col-num">{formatRatio(stat.timeShare)}</span>
    </button>
  )
}

export function ToolPanel({ insight, cursorMs, selectedStepId, onSelectStep }: PanelProps) {
  const { tools, toolStats, totals, breakdown, wallMs } = insight
  const [showAll, setShowAll] = useState(false)

  /** 工具名 → 第一次调用（下钻锚点）；错误类 → 该类第一个失败调用。 */
  const drillTargets = useMemo(() => {
    const firstByName = new Map<string, ToolCall>()
    const firstFailureByClass = new Map<ToolErrorClass, string>()
    for (const tool of [...tools].sort((a, b) => a.startMs - b.startMs)) {
      const current = firstByName.get(tool.name)
      if (!current || tool.startMs < current.startMs) firstByName.set(tool.name, tool)
      if (tool.errorClass && !firstFailureByClass.has(tool.errorClass) && isFailure(tool)) {
        firstFailureByClass.set(tool.errorClass, tool.id)
      }
    }
    return { firstByName, firstFailureByClass }
  }, [tools])

  /** 泳道：一行一条，只画最早的 MAX_LANE_BARS 次调用。 */
  const lanes = useMemo(() => {
    const taken = [...tools].sort((a, b) => a.startMs - b.startMs).slice(0, MAX_LANE_BARS)
    const rows: ToolCall[][] = []
    for (const tool of taken) {
      const index = Number.isFinite(tool.lane) && tool.lane > 0 ? Math.floor(tool.lane) : 0
      const row = rows[index] ?? (rows[index] = [])
      row.push(tool)
    }
    return { rows, omitted: tools.length - taken.length }
  }, [tools])

  /** 错误归类：同一类错误跨工具累加，一类一行。 */
  const errorRows = useMemo(() => {
    const acc = new Map<ToolErrorClass, ErrorRow>()
    for (const stat of toolStats) {
      for (const [key, count] of Object.entries(stat.errorClasses)) {
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
        const errorClass = key as ToolErrorClass
        const row = acc.get(errorClass) ?? { errorClass, label: errorClassLabel(errorClass), count: 0, tools: '' }
        row.count += count
        row.tools = row.tools ? `${row.tools} · ${stat.name}` : stat.name
        acc.set(errorClass, row)
      }
    }
    return [...acc.values()].sort((a, b) => b.count - a.count)
  }, [toolStats])

  if (tools.length === 0) {
    return <Panel title="工具调用" conclusion={<>本 run 没有工具调用（<b>0</b> 次执行），耗时全部来自模型往返与等待</>} />
  }

  const maxBarMs = toolStats.slice(0, TOP_BARS).reduce((max, stat) => Math.max(max, stat.totalMs), 0)
  const slowest = toolStats[0] ?? null
  const worst = toolStats.filter((stat) => stat.failures > 0).sort((a, b) => b.failures - a.failures)[0] ?? null
  const failureRate = totals.toolCalls > 0 ? totals.toolFailures / totals.toolCalls : null
  const wallShare = wallMs > 0 ? breakdown.toolMs / wallMs : null
  const tableRows = showAll ? toolStats : toolStats.slice(0, TABLE_ROWS)

  /** 每个工具行的共享 props：下钻目标 + 回放/选中态。 */
  const rowBase = (stat: ToolStat): Pick<StatRowProps, 'targetId' | 'future' | 'selected' | 'onSelect'> => {
    const first = drillTargets.firstByName.get(stat.name)
    return {
      targetId: first ? first.id : null,
      future: first !== undefined && isFuture(first.startMs, cursorMs),
      selected: first !== undefined && selectedStepId === first.id,
      onSelect: onSelectStep,
    }
  }

  const conclusion = (
    <>
      工具合计 <b>{formatMs(breakdown.toolMs)}</b>
      {wallShare !== null && <>（占 run <b>{formatShare(wallShare)}</b>）</>}
      {slowest !== null && <>；最耗时的是 <b>{slowest.name}</b> <b>{formatMs(slowest.totalMs)}</b>，占工具耗时 <b>{formatShare(slowest.timeShare)}</b></>}
      {worst === null ? <>；没有失败调用</> : failureClause(worst, tools)}
    </>
  )

  const detailConclusion = (
    <>
      <b>{toolStats.length}</b> 个工具、<b>{tools.length}</b> 次调用落在 <b>{lanes.rows.length}</b> 条泳道（峰值{' '}
      {totals.maxParallelTools} 路并发）
      {errorRows.length === 0 ? <>；没有可归类的失败</> : <>；失败归成 <b>{errorRows.length}</b> 类</>}
    </>
  )

  return (
    <>
      <Panel title="工具调用" conclusion={conclusion} meta={`${toolStats.length} 个工具 · 按总耗时倒序`}>
        <div className="tool-hero">
          <div className="tool-bars">
            {toolStats.slice(0, TOP_BARS).map((stat) => (
              <StatRow key={stat.name} stat={stat} mode="bar" maxMs={maxBarMs} {...rowBase(stat)} />
            ))}
          </div>
          <div className="tool-metrics">
            <Metric label="调用总数" value={totals.toolCalls} />
            <Metric label="失败数" value={totals.toolFailures} tone={totals.toolFailures > 0 ? 'error' : undefined} />
            <Metric label="失败率" value={formatRatio(failureRate)} tone={failureRate ? 'error' : undefined} />
            <Metric label="最大并发" value={totals.maxParallelTools} />
          </div>
        </div>
      </Panel>

      <Panel title="工具明细" conclusion={detailConclusion} collapsible expandLabel="展开明细">
        <section className="tool-sec">
          <h3 className="tool-sec-title">聚合表<span className="tool-sec-note">点行下钻该工具第一次调用</span></h3>
          <div className="tool-table">
            <div className="tool-row tool-row-head">
              <span>工具</span><span className="tool-col-num">调用</span>
              <span className="tool-col-num">平均</span><span className="tool-col-num">占比</span>
            </div>
            {tableRows.map((stat) => (
              <StatRow key={stat.name} stat={stat} mode="table" {...rowBase(stat)} />
            ))}
          </div>
          {toolStats.length > TABLE_ROWS && !showAll && (
            <button type="button" className="tool-more" onClick={() => setShowAll(true)}>
              显示全部 {toolStats.length}
            </button>
          )}
        </section>

        <section className="tool-sec">
          <h3 className="tool-sec-title">
            并发泳道
            <span className="tool-sec-note">
              {lanes.rows.length} 条 · 每行一条 · 最多 {MAX_LANE_BARS} 次
              {lanes.omitted > 0 ? ` · 已省略 ${lanes.omitted} 次` : ''}
            </span>
          </h3>
          <div className="tool-lanes-head">
            <span className="tool-lane-id" aria-hidden="true" />
            <TimeRuler wallMs={wallMs} compact />
          </div>
          <div className="tool-lanes">
            {lanes.rows.map((laneTools, laneIndex) => (
              <div key={laneIndex} className="tool-lane">
                <span className="num tool-lane-id">L{laneIndex + 1}</span>
                <span className="tool-lane-track">
                  {laneTools.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      className="tool-lane-bar"
                      data-tone={laneTone(tool)}
                      data-future={isFuture(tool.startMs, cursorMs) || undefined}
                      data-selected={selectedStepId === tool.id || undefined}
                      style={{ left: `${pctOf(tool.startMs, wallMs)}%`, width: `${widthOf(tool.startMs, tool.endMs, wallMs)}%` }}
                      aria-label={`${tool.name} ${formatMs(tool.durationMs)}`}
                      title={`${tool.name} · R${tool.roundIndex} · ${formatMs(tool.durationMs)}${tool.repeatIndex > 0 ? ` · 重复 ×${tool.repeatIndex + 1}` : ''}${isFailure(tool) ? ' · 失败' : ''}`}
                      onClick={() => onSelectStep(tool.id)}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="tool-sec">
          <h3 className="tool-sec-title">错误归类<span className="tool-sec-note">启发式归类 · 点行下钻首个失败</span></h3>
          {errorRows.length === 0 ? (
            <p className="tool-note">{totals.toolFailures > 0 ? '有失败但错误文本缺失，无法归类' : '没有工具失败'}</p>
          ) : (
            <div className="tool-errors">
              {errorRows.map((row) => {
                const target = drillTargets.firstFailureByClass.get(row.errorClass) ?? null
                return (
                  <button
                    key={row.errorClass}
                    type="button"
                    className="tool-err-row"
                    disabled={target === null}
                    title={target === null ? '没有可下钻的失败调用' : `${row.label} · 共 ${row.count} 次`}
                    onClick={() => target !== null && onSelectStep(target)}
                  >
                    <span className="tool-err-label">{row.label}</span>
                    <span className="num tool-err-count">{row.count}</span>
                    <span className="num tool-err-tools">· {row.tools}</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </Panel>
    </>
  )
}
