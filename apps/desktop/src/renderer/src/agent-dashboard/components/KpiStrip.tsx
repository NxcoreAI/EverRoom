/** 顶部五个关键数字：一眼回答「多久 / 慢在哪 / 多贵 / 多满 / 稳不稳」。 */
import { breakdownShares } from '../insight/analyze'
import { formatMs, formatPercent, formatTokens } from '../insight/format'
import { formatCost } from '../insight/pricing'
import type { TraceInsight } from '../insight/types'

import './kpi-strip.css'

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被打断',
}

interface KpiStripProps {
  insight: TraceInsight
  currency: 'USD' | 'CNY'
}

export function KpiStrip({ insight, currency }: KpiStripProps) {
  const { totals, breakdown, run } = insight
  const shares = breakdownShares(breakdown)
  const tokenTotal = totals.usage.input + totals.usage.output
  const successRate = totals.toolCalls === 0
    ? null
    : Math.round(((totals.toolCalls - totals.toolFailures) / totals.toolCalls) * 100)

  return (
    <div className="kpi">
      <div className="kpi-cell">
        <span className="kpi-label">总耗时</span>
        <span className="kpi-value num">
          {formatMs(insight.wallMs)}
          <span className="kpi-badge" data-status={run.status}>{STATUS_TEXT[run.status] ?? run.status}</span>
        </span>
        <span className="kpi-hint num">{totals.rounds} 回合 · {totals.toolCalls} 次工具</span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">模型往返占比</span>
        <span className="kpi-value num">{formatPercent(shares.wait * 100, 0)}</span>
        <span className="kpi-hint num">模型 {formatMs(breakdown.modelWaitMs)} · 工具 {formatMs(breakdown.toolMs)}</span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">Token · 估算成本</span>
        <span className="kpi-value num">
          {formatTokens(tokenTotal)}
          <span className="kpi-cost num">{formatCost(totals.costUsd, currency)}</span>
        </span>
        <span className="kpi-hint num">入 {formatTokens(totals.usage.input)} · 出 {formatTokens(totals.usage.output)} · 缓存 {formatTokens(totals.usage.cacheRead)}</span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">上下文峰值</span>
        <span className="kpi-value num">
          {formatPercent(totals.peakContextPercent)}
          {totals.compactions > 0 && <span className="kpi-note">压缩 {totals.compactions} 次</span>}
        </span>
        <span className="kpi-hint num">{formatTokens(totals.peakContextTokens)} / {formatTokens(totals.contextWindow)}</span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">工具成功率</span>
        <span className="kpi-value num" data-tone={totals.toolFailures > 0 ? 'error' : 'ok'}>
          {successRate === null ? '—' : `${successRate}%`}
        </span>
        <span className="kpi-hint num">失败 {totals.toolFailures} · 慢调用 {totals.slowSteps}</span>
      </div>
    </div>
  )
}
