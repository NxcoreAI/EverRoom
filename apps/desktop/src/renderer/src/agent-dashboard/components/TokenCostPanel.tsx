/**
 * 资源与成本面板（v2 · 浅色分层）：一句结论 + 一张累计成本曲线 + 4 个指标。
 * 逐回合明细（token 堆叠条 / 成本）与口径说明收进「展开明细」，默认收起。
 *
 * 口径：埋点不带模型名，所有金额都是「按顶栏计价模型折算」的**估算**（pricing.costOf）；
 * token 来自 runtime runUsage 累计值的逐回合差分，缺字段显示「—」，不补 0 冒充真实值。
 */
import { useState, type ReactNode } from 'react'

import { formatTokens } from '../insight/format'
import { CNY_PER_USD, formatCost } from '../insight/pricing'
import type { LlmRound, TraceTotals } from '../insight/types'
import { Metric, Panel } from './Panel'
import type { PanelProps } from './panelTypes'

import './token-cost.css'

type SegmentKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite'
const SEGMENTS: ReadonlyArray<{ key: SegmentKey; label: string; className: string }> = [
  { key: 'input', label: '输入', className: 'tc-seg-input' },
  { key: 'output', label: '输出', className: 'tc-seg-output' },
  { key: 'cacheRead', label: '缓存读', className: 'tc-seg-read' },
  { key: 'cacheWrite', label: '缓存写', className: 'tc-seg-write' },
]

/** 明细表首屏只放 8 行，其余交给「显示全部」。 */
const ROW_LIMIT = 8
const VIEW = 100 // 曲线画在 100×100 无量纲画布里，靠百分比定位：换宽度不必重算坐标

function tokensOf(round: LlmRound): Record<SegmentKey, number> {
  const usage = round.usageDelta
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
  }
}

function sumOf(tokens: Record<SegmentKey, number>): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

function runTokensOf(totals: TraceTotals): number {
  const { input, output, cacheRead, cacheWrite } = totals.usage
  return input + output + cacheRead + cacheWrite
}

function shareOf(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '—'
}

interface CostChart {
  line: string
  /** 每回合成本点（只画 >0 的回合，避免基线上一排无意义的点）。 */
  dots: Array<{ index: number; left: number; top: number; cost: number; cum: number }>
}

/** 累计成本折线 + 每回合成本点：两条序列共用 y=[0, 总成本]，所以点一定落在折线下方。 */
function buildCostChart(rounds: readonly LlmRound[]): CostChart | null {
  if (rounds.filter((round) => round.costUsd !== null).length < 2) return null
  let sum = 0
  const steps = rounds.map((round, position) => {
    sum += round.costUsd ?? 0
    return {
      round,
      x: 1 + (position / Math.max(1, rounds.length - 1)) * (VIEW - 2), // 左右各留 1：首末回合的点不贴边
      cum: sum,
    }
  })
  if (!(sum > 0)) return null
  const yOf = (value: number): number => VIEW - (value / sum) * VIEW
  const line = steps
    .map((step, position) => `${position === 0 ? 'M' : 'L'}${step.x.toFixed(2)},${yOf(step.cum).toFixed(2)}`)
    .join(' ')
  const dots = steps
    .filter((step) => (step.round.costUsd ?? 0) > 0)
    .map((step) => ({
      index: step.round.index,
      left: step.x,
      top: yOf(step.round.costUsd ?? 0),
      cost: step.round.costUsd ?? 0,
      cum: step.cum,
    }))
  return { line, dots }
}
/** 结论句：钱花在哪 —— 最贵的两个回合 + 合计占比；没有计价模型时退回「只有 token」。 */
function costConclusion(rounds: readonly LlmRound[], totals: TraceTotals, currency: 'USD' | 'CNY'): ReactNode {
  const priced = rounds.filter((round) => round.costUsd !== null)
  if (priced.length === 0) {
    const heaviest = [...rounds].sort((left, right) => sumOf(tokensOf(right)) - sumOf(tokensOf(left)))[0]
    return (
      <>
        顶栏未选计价模型，只有 token 没有金额：共 <b>{formatTokens(runTokensOf(totals))}</b>{' tokens，最重的是 '}
        <b>R{heaviest.index}</b>{`（${formatTokens(sumOf(tokensOf(heaviest)))}）`}
      </>
    )
  }

  const total = totals.costUsd
  if (total === null || total <= 0) {
    return <>估算成本约等于 0：<b>{priced.length}</b> 个回合都没有可归因的 token 增量（或单价为 0）</>
  }

  const ranked = [...priced].sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0))
  const first = ranked[0]
  const second = ranked[1]
  if (second === undefined) {
    return <>钱全部花在 <b>R{first.index}</b>：<b>{formatCost(first.costUsd, currency)}</b>{'，占本次 run 的 '}<b>100%</b></>
  }

  const topSum = (first.costUsd ?? 0) + (second.costUsd ?? 0)
  const others = Math.max(0, ranked.length - 2)
  const pair = `R${Math.min(first.index, second.index)} 与 R${Math.max(first.index, second.index)}`
  return (
    <>
      {'成本主要在 '}<b>{pair}</b>{'：'}<b>{formatCost(topSum, currency)}</b>
      {others === 0 ? (
        <>{'，这两个回合吃掉了全部成本'}</>
      ) : (
        <>
          {'，占本次 run 的 '}<b>{shareOf(topSum, total)}</b>{`；其余 ${others} 个回合合计只花了 `}
          <b>{formatCost(total - topSum, currency)}</b>
        </>
      )}
    </>
  )
}

export function TokenCostPanel({ insight, selectedStepId, onSelectStep, currency }: PanelProps & { currency: 'USD' | 'CNY' }) {
  const { rounds, totals } = insight
  const [showAll, setShowAll] = useState(false)

  if (rounds.length === 0) {
    return (
      <Panel title="资源与成本"
        conclusion={<>这条 run 还没有 token 埋点：用量只在回合结束时透出，0 回合说明没有完成任何 LLM 往返</>} />
    )
  }

  const runTokens = runTokensOf(totals)
  const avgCost = totals.costUsd !== null ? totals.costUsd / rounds.length : null
  const chart = buildCostChart(rounds)
  const maxRoundTokens = rounds.reduce((max, round) => Math.max(max, sumOf(tokensOf(round))), 0)
  const heaviest = rounds.reduce(
    (best, round) => (sumOf(tokensOf(round)) > sumOf(tokensOf(best)) ? round : best),
    rounds[0],
  )
  const cacheShare = shareOf(totals.usage.cacheRead + totals.usage.cacheWrite, runTokens)
  const visible = showAll ? rounds : rounds.slice(0, ROW_LIMIT)

  return (
    <>
      <Panel
        title="资源与成本"
        meta={`${rounds.length} 回合 · 金额为估算`}
        conclusion={costConclusion(rounds, totals, currency)}
      >
        <div className="tc-main">
          <div className="tc-figure">
            {chart === null ? (
              <p className="tc-hint">
                {rounds.some((round) => round.costUsd !== null)
                  ? '回合数不足 2，画不出累计曲线；逐回合金额见下方明细。'
                  : '顶栏未选计价模型，只有 token 没有金额可画。'}
              </p>
            ) : (
              <>
                <div
                  className="tc-chart"
                  role="img"
                  aria-label={`累计成本曲线：${rounds.length} 回合合计 ${formatCost(totals.costUsd, currency)}`}
                >
                  <svg viewBox={`0 0 ${VIEW} ${VIEW}`} preserveAspectRatio="none" aria-hidden="true">
                    <line className="tc-base" x1="0" y1={VIEW - 0.5} x2={VIEW} y2={VIEW - 0.5} />
                    <path className="tc-line" d={chart.line} />
                  </svg>
                  {chart.dots.map((dot) => (
                    <span
                      key={dot.index}
                      className="tc-dot"
                      style={{ left: `${dot.left}%`, top: `${dot.top}%` }}
                      title={`R${dot.index}：本回合 ${formatCost(dot.cost, currency)} · 累计 ${formatCost(dot.cum, currency)}`}
                    />
                  ))}
                </div>
                <div className="tc-axis num">
                  <span>R{rounds[0].index}</span>
                  <span className="tc-axis-key">点 = 每回合成本 · 线 = 累计</span>
                  <span>R{rounds[rounds.length - 1].index}</span>
                </div>
              </>
            )}
          </div>

          <div className="tc-metrics">
            <Metric
              label="总估算成本"
              value={formatCost(totals.costUsd, currency)}
              tone="cost"
              hint={`${rounds.length} 回合累计`}
            />
            <Metric label="输入 tokens" value={formatTokens(totals.usage.input)} hint={`占 ${shareOf(totals.usage.input, runTokens)}`} />
            <Metric label="输出 tokens" value={formatTokens(totals.usage.output)} hint={`占 ${shareOf(totals.usage.output, runTokens)}`} />
            <Metric label="平均每回合" value={formatCost(avgCost, currency)} tone="cost" hint="总成本 ÷ 回合数" />
          </div>
        </div>
      </Panel>

      <Panel
        title="逐回合 token 与成本"
        meta={`${rounds.length} 回合 · 点行下钻`}
        collapsible
        expandLabel={`展开 ${rounds.length} 行明细`}
        conclusion={
          <>
            共 <b>{formatTokens(runTokens)}</b>{' tokens，缓存读写占 '}<b>{cacheShare}</b>{'；单回合最重的是 '}
            <b>R{heaviest.index}</b>{`（${formatTokens(sumOf(tokensOf(heaviest)))}）`}
          </>
        }
      >
        <div className="tc-legend">
          {SEGMENTS.map((segment) => (
            <span key={segment.key} className="tc-legend-item">
              <i className={`tc-swatch ${segment.className}`} aria-hidden="true" />
              {segment.label}
            </span>
          ))}
        </div>
        <ul className="tc-rows">
          {visible.map((round) => {
            const tokens = tokensOf(round)
            const total = sumOf(tokens)
            const stepId = `llm:${round.index}:0`
            const selected = selectedStepId === stepId
            return (
              <li key={round.index}>
                <button
                  type="button"
                  className="tc-row"
                  data-selected={selected || undefined}
                  onClick={() => onSelectStep(selected ? null : stepId)}
                  title={`R${round.index} · 输入 ${formatTokens(tokens.input)} · 输出 ${formatTokens(tokens.output)} · 缓存读 ${formatTokens(tokens.cacheRead)} · 缓存写 ${formatTokens(tokens.cacheWrite)}`}
                >
                  <span className="tc-row-id num">R{round.index}</span>
                  <span className="tc-track">
                    <span className="tc-fill" style={{ width: `${maxRoundTokens > 0 ? (total / maxRoundTokens) * 100 : 0}%` }}>
                      {SEGMENTS.map((segment) =>
                        total > 0 && tokens[segment.key] > 0 ? (
                          <span
                            key={segment.key}
                            className={`tc-seg ${segment.className}`}
                            style={{ width: `${(tokens[segment.key] / total) * 100}%` }}
                          />
                        ) : null,
                      )}
                    </span>
                  </span>
                  <span className="tc-row-total num">{round.usageDelta === null ? '—' : formatTokens(total)}</span>
                  <span className="tc-row-cost num">{formatCost(round.costUsd, currency)}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {rounds.length > ROW_LIMIT && (
          <button type="button" className="tc-more" onClick={() => setShowAll((value) => !value)}>
            {showAll ? '收起' : `显示全部 ${rounds.length} 回合`}
          </button>
        )}
      </Panel>

      <Panel
        title="成本口径"
        collapsible
        expandLabel="展开口径"
        conclusion={
          <>
            金额是<b>估算</b>：埋点没有模型名，按顶栏计价模型把 <b>{formatTokens(runTokens)}</b>
            {' tokens 折算成金额，不能直接当账单'}
          </>
        }
      >
        <ul className="tc-notes">
          <li>
            埋点契约里没有模型名（<span className="num">message.started</span> 只带 role），所以不猜模型：金额 = 各回合
            token 增量 × 顶栏计价模型的公开单价，缓存读 / 写各按自身单价单列。
          </li>
          <li>
            token 来自 runtime <span className="num">runUsage</span> 累计值的逐回合差分（回合结束才透出）；缺失字段显示「—」，
            不补 0。
          </li>
          <li>
            人民币按 <span className="num">1 USD ≈ {CNY_PER_USD} CNY</span> 换算，只用于展示；切换顶栏计价模型会改变上面全部金额。
          </li>
        </ul>
      </Panel>
    </>
  )
}
