/**
 * 时间构成面板：一层结论句 + 一条 100% 堆叠横条（模型往返 / 工具 / 生成 / 其他）+ 3 个指标；
 * 逐回合往返排行与口径说明收进内层折叠 Panel（默认收起，默认 10 行 + 「显示全部」）。
 *
 * 全部数字来自 insight.breakdown / insight.rounds，面板内不重算口径。
 * 非流式 run（totals.streamedRounds === 0）TTFT 一律显示「不可测（非流式）」，不写 0ms。
 */
import { useMemo, useState, type ReactNode } from 'react'

import { breakdownShares, THRESHOLDS } from '../insight/analyze'
import { formatMs } from '../insight/format'
import { formatCost } from '../insight/pricing'
import type { LlmRound, TimeBreakdown, TraceInsight } from '../insight/types'
import { Metric, Panel } from './Panel'
import { isFuture, type PanelProps } from './panelTypes'

import './time-breakdown.css'

/** 排行默认 10 行，其余「显示全部」。 */
const DETAIL_ROWS = 10
/** 段内文字只在够宽时显示，否则留在图例里。 */
const SEGMENT_LABEL_MIN_SHARE = 0.14

type SegmentKey = 'wait' | 'tool' | 'gen' | 'gap'

interface Segment {
  key: SegmentKey
  label: string
  ms: number
  share: number
}

function slowestRound(rounds: readonly LlmRound[]): LlmRound | null {
  let peak: LlmRound | null = null
  for (const round of rounds) if (peak === null || round.latencyMs > peak.latencyMs) peak = round
  return peak
}

/** 结论句：墙钟里占比最大的一段 + 工具合计，直接给出「瓶颈在哪」。 */
function conclusionOf(
  breakdown: TimeBreakdown,
  segments: readonly Segment[],
  totals: TraceInsight['totals'],
): ReactNode {
  if (totals.rounds === 0) return '没有解析出回合（缺 context.usage 事件），时间构成无从拆分'
  const wall = formatMs(breakdown.wallMs)
  const tool = formatMs(breakdown.toolMs)
  let dominant: Segment | undefined
  for (const segment of segments) {
    if (dominant === undefined || segment.share > dominant.share) dominant = segment
  }
  if (dominant === undefined) return `墙钟 ${wall} 里没有任何可归因的段落`

  const percent = Math.round(dominant.share * 100)
  const head = (
    <>
      墙钟 <b>{wall}</b> 里 <b>{percent}%</b>{' '}
    </>
  )
  const toolPart = (
    <>
      （工具合计 <b>{tool}</b>）
    </>
  )
  switch (dominant.key) {
    case 'wait':
      return (
        <>
          {head}是模型往返{toolPart}，瓶颈不在工具而在模型延迟
        </>
      )
    case 'tool':
      return (
        <>
          {head}花在工具执行{toolPart}，瓶颈在工具层不在模型
        </>
      )
    case 'gen':
      return (
        <>
          {head}是真流式生成{toolPart}，延迟主要落在出字上
        </>
      )
    default:
      return (
        <>
          {head}没有被任何步骤覆盖{toolPart}，时间丢在调度、审批等空档里
        </>
      )
  }
}

export function TimeBreakdownPanel({
  insight,
  cursorMs,
  selectedStepId,
  onSelectStep,
  currency,
}: PanelProps & { currency: 'USD' | 'CNY' }) {
  const [showAllRounds, setShowAllRounds] = useState(false)

  const { breakdown, totals, rounds } = insight
  const shares = breakdownShares(breakdown)

  const segments: Segment[] = [
    { key: 'wait', label: '模型往返', ms: breakdown.modelWaitMs, share: shares.wait },
    { key: 'tool', label: '工具', ms: breakdown.toolMs, share: shares.tool },
    { key: 'gen', label: '生成', ms: breakdown.llmMs, share: shares.llm },
    { key: 'gap', label: '其他', ms: breakdown.gapMs, share: shares.gap },
  ]

  /** 逐回合往返排行：往返耗时降序（往返 = 回合时长 − 工具 − 生成）。 */
  const ranked = useMemo(
    () => [...rounds].sort((left, right) => right.modelWaitMs - left.modelWaitMs),
    [rounds],
  )
  const listed = showAllRounds ? ranked : ranked.slice(0, DETAIL_ROWS)
  const peakWait = ranked.reduce((peak, round) => Math.max(peak, round.modelWaitMs), 0) || 1

  const slowest = slowestRound(rounds)
  const ttftNote =
    totals.streamedRounds === 0
      ? '该 run 的 runtime 一次性下发整段文本（非流式），TTFT 不可测；模型总延迟全部落在「模型往返」段。'
      : `${totals.streamedRounds}/${totals.rounds} 回合可测 TTFT；其余回合一次性下发整段文本，其等待已计入「模型往返」段。`

  return (
    <Panel
      title="时间构成"
      meta={`墙钟 ${formatMs(breakdown.wallMs)}`}
      conclusion={conclusionOf(breakdown, segments, totals)}
    >
      {rounds.length === 0 ? (
        <p className="bd-empty">该 run 没有可解析的回合（缺 context.usage 事件），时间构成无从拆分</p>
      ) : (
        <>
          <div
            className="bd-bar"
            title={`模型往返 ${formatMs(breakdown.modelWaitMs)} · 工具 ${formatMs(breakdown.toolMs)}`}
          >
            {segments.map((segment) =>
              segment.share <= 0 ? null : (
                <span
                  key={segment.key}
                  className="bd-seg"
                  data-tone={segment.key}
                  style={{ width: `${segment.share * 100}%` }}
                  title={`${segment.label} ${formatMs(segment.ms)}`}
                >
                  {segment.share >= SEGMENT_LABEL_MIN_SHARE ? (
                    <span className="num">{formatMs(segment.ms)}</span>
                  ) : null}
                </span>
              ),
            )}
          </div>

          <div className="bd-legend">
            {segments.map((segment) => (
              <span key={segment.key} className="bd-legend-item">
                <i className="bd-swatch" data-tone={segment.key} />
                {segment.label}
                <span className="num bd-legend-ms">{formatMs(segment.ms)}</span>
                <span className="num bd-legend-pct">{Math.round(segment.share * 100)}%</span>
              </span>
            ))}
          </div>

          <div className="bd-metrics">
            <Metric label="回合" value={totals.rounds} hint={`${totals.toolCalls} 次工具`} />
            <Metric
              label="最长回合"
              value={formatMs(slowest?.latencyMs ?? null)}
              hint={slowest === null ? undefined : `R${slowest.index}`}
              tone={slowest !== null && slowest.latencyMs >= THRESHOLDS.slowRoundMs ? 'warn' : undefined}
            />
            <Metric
              label="TTFT"
              value={totals.streamedRounds === 0 ? '不可测（非流式）' : formatMs(breakdown.ttftMs)}
              hint={
                totals.streamedRounds === 0
                  ? '整段一次性下发'
                  : `${totals.streamedRounds}/${totals.rounds} 回合可测`
              }
            />
          </div>

          <Panel level={2} collapsible title="逐回合往返" meta={`按往返降序 · ${rounds.length} 个回合`}>
            <div className="bd-rows">
              {listed.map((round) => {
                const stepId = `llm:${round.index}:0`
                return (
                  <button
                    key={round.index}
                    type="button"
                    className="bd-row"
                    data-selected={stepId === selectedStepId || undefined}
                    data-future={isFuture(round.startMs, cursorMs) || undefined}
                    onClick={() => onSelectStep(stepId)}
                    title={
                      `R${round.index} · 往返 ${formatMs(round.modelWaitMs)} · 工具 ${formatMs(round.toolsMs)}` +
                      ` · 生成 ${formatMs(round.generationMs)} · 成本 ${formatCost(round.costUsd, currency)}`
                    }
                  >
                    <span className="bd-row-id num">R{round.index}</span>
                    <span className="bd-row-track">
                      <span
                        className="bd-row-bar"
                        style={{ width: `${Math.max((round.modelWaitMs / peakWait) * 100, 2)}%` }}
                      />
                    </span>
                    <span className="bd-row-ms num">{formatMs(round.modelWaitMs)}</span>
                    <span className="bd-row-tool">
                      工具 <span className="num">{formatMs(round.toolsMs)}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            {ranked.length > DETAIL_ROWS && (
              <button type="button" className="bd-more-btn" onClick={() => setShowAllRounds((value) => !value)}>
                {showAllRounds ? '收起' : `显示全部 ${ranked.length} 个回合`}
              </button>
            )}

            <div className="bd-note">
              <p className="bd-note-title">口径</p>
              <ul>
                <li>墙钟 = 工具 + 生成 + 模型往返 + 其他，四段互不重叠；工具与生成按时间并集计（并行只算一次）。</li>
                <li>{ttftNote}</li>
              </ul>
            </div>
          </Panel>
        </>
      )}
    </Panel>
  )
}
