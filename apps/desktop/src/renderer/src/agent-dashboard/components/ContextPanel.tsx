/**
 * 上下文与记忆面板（v2 · 浅色分层）：一条占用曲线 + 3 个指标；
 * 分段构成 / 逐回合收支 / 压缩历史 / 口径全部收进折叠区（默认收起）。
 * 口径：percent / tokens 取 runtime context.usage 采样（缺失为 null → 「—」）；
 * memoryDelta = 本回合采样 − 上回合采样，正=写入，负=剪裁/压缩；峰值取 totals。
 */
import { useState, type ReactNode } from 'react'

import { formatOffset, formatPercent, formatTokenDelta, formatTokens } from '../insight/format'
import type { LlmRound } from '../insight/types'
import { Metric, Panel } from './Panel'
import { isFuture, type PanelProps } from './panelTypes'

import './context-panel.css'

const SEGMENT_ORDER = ['systemPrompt', 'tools', 'user', 'assistant', 'toolResults', 'other'] as const
type SegmentKey = (typeof SEGMENT_ORDER)[number]
type Pressure = 'ok' | 'warn' | 'crit'
const SEGMENT_LABEL: Record<SegmentKey, string> = {
  systemPrompt: '系统提示', tools: '工具定义', user: '用户消息',
  assistant: '助手输出', toolResults: '工具结果', other: '其他',
}
const COMPACTION_REASON: Record<string, string> = { threshold: '占用超阈值', overflow: '上下文溢出', manual: '手动压缩' }
const ROW_LIMIT = 10 // 明细表首屏 10 行，其余「显示全部」
const VIEW = 100 // 曲线画在 100×100 画布里：y 轴本身就是占用百分比
const REF_LINES = [40, 70, 85] as const // 注意力衰减 / 预警 / 接近溢出

/** 40% 以下不算压力，70% 起预警，85% 起已贴窗口边界。 */
const pressureOf = (percent: number | null): Pressure =>
  percent === null || percent < 70 ? 'ok' : percent < 85 ? 'warn' : 'crit'
const memSign = (value: number | null): 'write' | 'trim' | 'flat' | 'none' =>
  value === null ? 'none' : value === 0 ? 'flat' : value > 0 ? 'write' : 'trim'

const peakRoundOf = (rounds: readonly LlmRound[]): LlmRound | null =>
  rounds.reduce<LlmRound | null>((best, round) => (
    round.contextPercent !== null && (best === null || round.contextPercent > (best.contextPercent ?? 0)) ? round : best
  ), null)

/** 分段构成：只保留 >0 的段，按 token 降序。 */
type Composition = { round: LlmRound; ranked: Array<{ key: SegmentKey; tokens: number; share: number }> }

/** 构成取峰值回合（最能解释「为什么快满了」）；该回合没分段时退回最近一次有分段的采样。 */
function compositionOf(rounds: readonly LlmRound[], peak: LlmRound | null): Composition | null {
  const round = (peak?.contextSegments ? peak : null)
    ?? [...rounds].reverse().find((item) => item.contextSegments !== null) ?? null
  if (round === null) return null
  const items = SEGMENT_ORDER.map((key) => ({
    key,
    tokens: round.contextSegments?.find((segment) => segment.key === key)?.tokens ?? 0,
  }))
  const total = items.reduce((sum, item) => sum + item.tokens, 0)
  if (total <= 0) return null
  const ranked = items.filter((item) => item.tokens > 0)
    .map((item) => ({ ...item, share: (item.tokens / total) * 100 }))
    .sort((left, right) => right.tokens - left.tokens)
  return { round, ranked }
}

/** 占用曲线：折线 path + 峰值点（百分比坐标，DOM 定位）。 */
type Curve = { line: string; peak: { index: number; left: number; top: number; percent: number } | null }

function buildCurve(rounds: readonly LlmRound[]): Curve | null {
  if (rounds.filter((round) => round.contextPercent !== null).length < 2) return null
  const yOf = (percent: number): number => VIEW - (Math.min(100, Math.max(0, percent)) / 100) * VIEW
  const xOf = (position: number): number => 1 + (position / Math.max(1, rounds.length - 1)) * (VIEW - 2) // 左右各留 1
  let pen = false
  const parts = rounds.map((round, position) => {
    if (round.contextPercent === null) {
      pen = false
      return ''
    }
    const part = `${pen ? 'L' : 'M'}${xOf(position).toFixed(2)},${yOf(round.contextPercent).toFixed(2)}`
    pen = true
    return part
  })
  const line = parts.filter(Boolean).join(' ')
  const peak = peakRoundOf(rounds)
  if (peak === null || peak.contextPercent === null) return { line, peak: null }
  const point = { index: peak.index, left: xOf(rounds.indexOf(peak)), top: yOf(peak.contextPercent), percent: peak.contextPercent }
  return { line, peak: point }
}
export function ContextPanel({ insight, cursorMs, selectedStepId, onSelectStep }: PanelProps) {
  const { rounds, compactions, totals } = insight
  const [showAll, setShowAll] = useState(false)

  if (rounds.length === 0) {
    return (
      <Panel title="上下文与记忆"
        conclusion={<>这条 run 还没有上下文采样：<span className="num">context.usage</span> 只在回合结束时透出</>} />
    )
  }

  const peak = peakRoundOf(rounds)
  const windowTokens = totals.contextWindow ?? peak?.contextWindow ?? null
  const peakTokens = totals.peakContextTokens ?? peak?.contextTokens ?? null
  const peakPercent = totals.peakContextPercent ?? peak?.contextPercent ?? null
  const remaining = windowTokens !== null && peakTokens !== null ? windowTokens - peakTokens : null
  const margin = remaining !== null && windowTokens !== null && windowTokens > 0 ? remaining / windowTokens : null
  const pressure = pressureOf(peakPercent)
  const curve = buildCurve(rounds)
  const composition = compositionOf(rounds, peak)
  const written = rounds.reduce((sum, round) => sum + Math.max(0, round.memoryDelta ?? 0), 0)
  const trimmed = rounds.reduce((sum, round) => sum + Math.max(0, -(round.memoryDelta ?? 0)), 0)
  const heated = rounds.filter((round) => (round.contextPercent ?? 0) > 70).length
  const visible = showAll ? rounds : rounds.slice(0, ROW_LIMIT)
  const top = composition?.ranked[0] ?? null
  const next = composition?.ranked[1] ?? null
  const lastCompaction = compactions[compactions.length - 1]
  // 最后一次压缩之后的第一条采样：回答「压缩到底把它压回多少」。
  const recovery = lastCompaction === undefined
    ? null
    : rounds.find((round) => round.endMs > lastCompaction.atMs && round.contextPercent !== null)?.contextPercent ?? null
  // 剪得最狠的那一次压缩。
  const worstTrim = compactions.reduce<{ trim: number; atMs: number } | null>((best, record) => {
    if (record.beforeTokens === null || record.afterTokens === null) return best
    const trim = record.beforeTokens - record.afterTokens
    return best === null || trim > best.trim ? { trim, atMs: record.atMs } : best
  }, null)
  let conclusion: ReactNode
  if (peakPercent === null || peakTokens === null || windowTokens === null) {
    conclusion = (
      <>
        占用没透出：本 run 有 <b>{rounds.length}</b> 个回合，但缺 <span className="num">context.usage</span>{' '}
        的 percent / token 字段，只能看下方明细的原始采样
      </>
    )
  } else if (remaining !== null && remaining < 0) {
    conclusion = (
      <>
        峰值 <b>{formatPercent(peakPercent)}</b>{`（${formatTokens(peakTokens)}/${formatTokens(windowTokens)}）已撑爆窗口 `}
        <b>{formatTokens(-remaining)}</b>{' tokens，压缩没兜住增长'}
      </>
    )
  } else {
    const compactText = compactions.length === 0
      ? '全程未触发压缩'
      : `压缩 ${compactions.length} 次${recovery !== null ? `后回落到 ${formatPercent(recovery)}` : ''}`
    const gap = Math.max(0, 85 - peakPercent).toFixed(0)
    const riskText = pressure === 'crit' ? `，R${peak?.index} 之后随时可能再次溢出` : `，离 85% 警戒线还有 ${gap} 个百分点`
    conclusion = (
      <>
        峰值 <b>{formatPercent(peakPercent)}</b>
        {`（${formatTokens(peakTokens)}/${formatTokens(windowTokens)}），窗口${pressure === 'ok' ? '余量还有' : '余量只剩'} `}
        <b>{formatPercent(margin !== null ? margin * 100 : null)}</b>{`；${compactText}${riskText}`}
      </>
    )
  }
  return (
    <>
      <Panel title="上下文与记忆" meta={`${rounds.length} 回合 · 窗口 ${formatTokens(windowTokens)}`} conclusion={conclusion}>
        <div className="cp-main">
          <div className="cp-figure">
            {curve === null ? (
              <p className="cp-hint">可用采样不足 2 个回合，画不出曲线；逐回合数值见下方明细。</p>
            ) : (
              <>
                <div className="cp-chart" role="img" aria-label={`上下文占用曲线：${rounds.length} 回合，峰值 ${formatPercent(peakPercent)}`}>
                  <svg viewBox={`0 0 ${VIEW} ${VIEW}`} preserveAspectRatio="none" aria-hidden="true">
                    {REF_LINES.map((value) => <line key={value} className="cp-ref" x1="0" y1={VIEW - value} x2={VIEW} y2={VIEW - value} />)}
                    <line className="cp-base" x1="0" y1={VIEW - 0.5} x2={VIEW} y2={VIEW - 0.5} />
                    <path className="cp-line" d={curve.line} />
                  </svg>
                  {REF_LINES.map((value) => <span key={value} className="cp-ref-label num" style={{ top: `${VIEW - value}%` }}>{value}%</span>)}
                  {curve.peak !== null && (
                    <>
                      <span className="cp-peak" data-pressure={pressure} style={{ left: `${curve.peak.left}%`, top: `${curve.peak.top}%` }} />
                      <span className="cp-peak-label num" data-pressure={pressure} data-below={curve.peak.top < 26 || curve.peak.left > 70 || undefined}
                        style={{ left: `${Math.min(92, Math.max(10, curve.peak.left))}%`, top: `${curve.peak.top}%` }}>
                        峰值 R{curve.peak.index} · {formatPercent(curve.peak.percent)}
                      </span>
                    </>
                  )}
                </div>
                <div className="cp-axis num"><span>R{rounds[0].index}</span><span>R{rounds[rounds.length - 1].index}</span></div>
              </>
            )}
          </div>
          <div className="cp-metrics">
            <Metric label="峰值占比" value={formatPercent(peakPercent)}
              tone={pressure === 'crit' ? 'error' : pressure === 'warn' ? 'warn' : undefined}
              hint={peak === null ? '未透出' : `R${peak.index}`} />
            <Metric label="剩余余量" value={formatTokens(remaining)}
              hint={margin === null ? '未透出' : `占窗口 ${formatPercent(margin * 100)}`} />
            <Metric label="压缩次数" value={compactions.length}
              hint={compactions.length === 0 ? '全程未触发' : `最近 ${formatOffset(compactions[compactions.length - 1].atMs)}`} />
          </div>
        </div>
      </Panel>

      <Panel title="上下文构成" meta={composition === null ? '未透出' : `R${composition.round.index} 采样`}
        collapsible expandLabel="展开构成" conclusion={top === null
          ? <>runtime 没透出分段构成（<span className="num">segments</span> 为空），只能看总量</>
          : <>
            {'占大头的是 '}<b>{SEGMENT_LABEL[top.key]}</b>{` ${Math.round(top.share)}%（${formatTokens(top.tokens)} tokens）`}
            {next !== null ? `，其次 ${SEGMENT_LABEL[next.key]} ${Math.round(next.share)}%` : ''}
          </>}>
        {composition === null ? (
          <p className="cp-hint">分段构成缺失时不做推算，到「逐回合占用与记忆收支」里看总量采样。</p>
        ) : (
          <>
            <div className="cp-stack">
              {composition.ranked.map((item) => <span key={item.key} className={`cp-seg-${item.key}`} style={{ width: `${item.share}%` }} />)}
            </div>
            <ul className="cp-chips">
              {composition.ranked.map((item) => (
                <li key={item.key}>
                  <span className={`cp-swatch cp-seg-${item.key}`} aria-hidden="true" />
                  {SEGMENT_LABEL[item.key]} <b className="num">{Math.round(item.share)}%</b>
                  <span className="cp-chip-tok num">{formatTokens(item.tokens)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="逐回合占用与记忆收支" meta={`${rounds.length} 回合 · 点行下钻`} collapsible
        expandLabel={`展开 ${rounds.length} 行明细`}
        conclusion={
          <>
            记忆净增 <b>{formatTokenDelta(written - trimmed)}</b>（写入 <b>{formatTokens(written)}</b> / 剪裁{' '}
            <b>{formatTokens(trimmed)}</b>），<b>{heated}</b> 个回合占用超过 70%；回放时未发生的行会变淡
          </>
        }>
        <ul className="cp-rows">
          {visible.map((round) => {
            const stepId = `llm:${round.index}:0`
            const selected = selectedStepId === stepId
            const width = round.contextPercent === null ? 0 : Math.min(100, Math.max(0, round.contextPercent))
            return (
              <li key={round.index} data-future={isFuture(round.startMs, cursorMs) || undefined}>
                <button type="button" className="cp-row" data-selected={selected || undefined}
                  onClick={() => onSelectStep(selected ? null : stepId)}
                  title={`R${round.index} · ${formatTokens(round.contextTokens)} tokens · 占用 ${formatPercent(round.contextPercent)} · 记忆 ${formatTokenDelta(round.memoryDelta)}`}>
                  <span className="cp-row-id num">R{round.index}</span>
                  <span className="cp-track">
                    <span className="cp-bar" data-pressure={pressureOf(round.contextPercent)} style={{ width: `${width}%` }} />
                  </span>
                  <span className="cp-row-pct num">{formatPercent(round.contextPercent)}</span>
                  <span className="cp-row-mem num" data-sign={memSign(round.memoryDelta)}>{formatTokenDelta(round.memoryDelta)}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {rounds.length > ROW_LIMIT && (
          <button type="button" className="cp-more" onClick={() => setShowAll((value) => !value)}>
            {showAll ? '收起' : `显示全部 ${rounds.length} 回合`}
          </button>
        )}
      </Panel>

      <Panel title="压缩历史" meta={compactions.length === 0 ? '未触发' : `${compactions.length} 次`} collapsible
        expandLabel="展开压缩记录" conclusion={worstTrim === null
          ? <>
            本次 run 没有压缩事件
            {peakPercent !== null ? <>，峰值 <b>{formatPercent(peakPercent)}</b>{' 一直没越过 85% 警戒线'}</> : null}
          </>
          : <>压缩 <b>{compactions.length}</b> 次，最大一次剪掉 <b>{formatTokens(worstTrim.trim)}</b> tokens（{formatOffset(worstTrim.atMs)}）</>}>
        {compactions.length === 0 ? (
          <p className="cp-hint">没有 compaction 事件：上下文靠自然增长走到峰值，压缩策略这次没被触发。</p>
        ) : (
          <table className="cp-table">
            <thead>
              <tr><th scope="col">时间</th><th scope="col">压缩前 → 后</th><th scope="col">变化</th><th scope="col">原因</th></tr>
            </thead>
            <tbody>
              {compactions.map((record) => {
                const delta = record.beforeTokens === null || record.afterTokens === null
                  ? null
                  : record.afterTokens - record.beforeTokens
                return (
                  <tr key={record.seq}>
                    <td className="num">{formatOffset(record.atMs)}</td>
                    <td className="num">{formatTokens(record.beforeTokens)} → {formatTokens(record.afterTokens)}</td>
                    <td className="num" data-sign={memSign(delta)}>{formatTokenDelta(delta)}</td>
                    <td>{COMPACTION_REASON[record.reason] ?? (record.reason || '未标注')}{record.active ? '（进行中）' : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="上下文口径" collapsible expandLabel="展开口径" conclusion={
        <>
          占用水位取自 <b>{insight.contextSeries.length}</b> 次 <span className="num">context.usage</span>
          {` 采样，窗口 ${formatTokens(windowTokens)} tokens；记忆收支 = 本回合采样 − 上回合采样`}
        </>
      }>
        <ul className="cp-notes">
          <li>percent / tokens 直接用 runtime 透出的采样值；缺字段显示「—」，不补 0，也不按消息条数推算。</li>
          <li>memoryDelta 为正表示本回合写入（工具结果、用户消息回灌），为负表示剪裁或压缩。</li>
          <li>回放光标只弱化明细表里尚未发生的回合行，主曲线保持完整，方便对照全局走势。</li>
        </ul>
      </Panel>
    </>
  )
}
