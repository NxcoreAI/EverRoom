/**
 * 时间拓扑面板：把一次 run 压成一条串行主线「接收任务 → R1 → … → 终态」。
 *
 * 分层：第一层 = 标题 + 一句结论 + 主图 + 3 个关键指标；
 *       第二层 = 内层 `<Panel collapsible>`（逐回合明细表 + 口径说明，默认收起）。
 * 工具默认不画（回合 × 多个工具会把图塞满），用标题行右侧开关把工具挂到所属回合下方。
 * 颜色纪律：回合 --accent、工具 --tool、慢 --warn、失败 --err，其余灰阶；慢/失败只染左侧 3px 色条。
 */
import { useMemo, useState, type ReactNode } from 'react'

import type { AgentDebugRunStatus } from '@nxcore/agent-contract'

import { THRESHOLDS } from '../insight/analyze'
import { formatMs, formatPercent, truncateText } from '../insight/format'
import { formatCost } from '../insight/pricing'
import type { LlmRound, Severity, StepStatus, ToolCall, TraceInsight } from '../insight/types'
import { Metric, Panel } from './Panel'
import { isFuture, type PanelProps } from './panelTypes'

import './topology-graph.css'

/** 主图最多画 12 个回合节点，其余折成「还有 N 个回合」。 */
const MAX_NODES = 12
/** 单个回合节点下最多挂 3 个工具。 */
const TOOLS_PER_NODE = 3
/** 明细表默认 8 行，其余「显示全部」。 */
const DETAIL_ROWS = 8
/** 图例：解释左侧色条与选中态。 */
const LEGEND = [
  ['warn', '慢'],
  ['error', '失败'],
  ['accent', '当前选中'],
] as const

const STATUS_TEXT: Record<AgentDebugRunStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被打断',
  timed_out: '超时',
}

interface ToneStep {
  status: StepStatus
  severity: Severity
}

/** 失败 = 有失败/超时的步骤；慢 = 回合时长超阈值，或有被取消、需留意的步骤。 */
function toneOf(steps: readonly ToneStep[], slow = false): Severity {
  if (steps.some((step) => step.status === 'failed' || step.status === 'timeout')) return 'error'
  if (slow || steps.some((step) => step.status === 'cancelled' || step.severity === 'warn')) return 'warn'
  return 'ok'
}

/** 慢回合阈值：30s 与本 run 回合中位数 2 倍取大（否则「每个回合都慢」时满屏黄点）。 */
function slowThresholdOf(rounds: readonly LlmRound[]): number {
  const sorted = rounds.map((round) => round.latencyMs).sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[middle] ?? 0
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return Math.max(THRESHOLDS.slowRoundMs, median * 2)
}

function slowestRound(rounds: readonly LlmRound[]): LlmRound | null {
  let peak: LlmRound | null = null
  for (const round of rounds) if (peak === null || round.latencyMs > peak.latencyMs) peak = round
  return peak
}

/** 结论句：回合数 + 串并行 + 最慢回合（真实数字，`<b>` 只包数字）。 */
function conclusionOf(insight: TraceInsight): ReactNode {
  const { rounds, totals } = insight
  if (rounds.length === 0) return '没有解析出回合（缺 context.usage 事件），拓扑只剩任务接收与终态'
  const slowest = slowestRound(rounds)
  const parallel =
    totals.maxParallelTools <= 1 ? '全部串行，没有任何并行工具' : `，最多 ${totals.maxParallelTools} 次工具并行`
  return (
    <>
      <b>{totals.rounds}</b> 个回合{parallel}
      {slowest !== null && (
        <>
          ；最慢的 R{slowest.index} 往返 <b>{formatMs(slowest.modelWaitMs)}</b>
        </>
      )}
      {totals.toolFailures > 0 ? `，另有 ${totals.toolFailures} 次工具失败` : '，没有工具失败'}
    </>
  )
}

export function TopologyGraph({
  insight,
  cursorMs,
  selectedStepId,
  onSelectStep,
  currency,
}: PanelProps & { currency: 'USD' | 'CNY' }) {
  const [showTools, setShowTools] = useState(false)
  const [showAllRounds, setShowAllRounds] = useState(false)

  const rounds = insight.rounds
  const slowMs = useMemo(() => slowThresholdOf(rounds), [rounds])
  const toolsByRound = useMemo(() => {
    const map = new Map<number, ToolCall[]>()
    for (const tool of insight.tools) {
      const list = map.get(tool.roundIndex)
      if (list) list.push(tool)
      else map.set(tool.roundIndex, [tool])
    }
    for (const list of map.values()) list.sort((left, right) => left.startMs - right.startMs)
    return map
  }, [insight.tools])

  const visibleRounds = rounds.slice(0, MAX_NODES)
  const hiddenRounds = rounds.length - visibleRounds.length
  const headTools = toolsByRound.get(0) ?? []
  const slowest = slowestRound(rounds)
  const listedRounds = showAllRounds ? rounds : rounds.slice(0, DETAIL_ROWS)
  const parallelHint =
    insight.totals.maxParallelTools <= 1 ? '全部串行' : `最多 ${insight.totals.maxParallelTools} 次并行`

  return (
    <Panel
      title="链路拓扑"
      meta={`${insight.totals.rounds} 回合 · ${insight.totals.toolCalls} 次工具`}
      conclusion={conclusionOf(insight)}
      actions={
        insight.tools.length > 0 ? (
          <button type="button" className="topo-toggle" aria-pressed={showTools} onClick={() => setShowTools(!showTools)}>
            {showTools ? '收起工具调用' : '展开工具调用'}
          </button>
        ) : undefined
      }
    >
      {rounds.length === 0 ? (
        <p className="topo-empty">该 run 没有可解析的回合（缺 context.usage 事件），拓扑无从展开</p>
      ) : (
        <>
          <div className="topo-scroll">
            <div className="topo-track">
              <div
                className="topo-step topo-node topo-terminal"
                data-kind="start"
                title={`run 开始 · 首条 context.usage 之前共 ${headTools.length} 次工具`}
              >
                <span className="topo-node-id">接收任务</span>
                <span className="topo-node-sub">{headTools.length > 0 ? `前置 ${headTools.length} 次工具` : 'run 开始'}</span>
              </div>

              {visibleRounds.map((round) => {
                const tools = toolsByRound.get(round.index) ?? []
                const stepId = `llm:${round.index}:0`
                return (
                  <div className="topo-step" key={round.index}>
                    <button
                      type="button"
                      className="topo-node"
                      data-kind="round"
                      data-tone={toneOf(tools, round.latencyMs >= slowMs)}
                      data-selected={stepId === selectedStepId || undefined}
                      data-future={isFuture(round.startMs, cursorMs) || undefined}
                      onClick={() => onSelectStep(stepId)}
                      title={
                        `R${round.index} · 回合 ${formatMs(round.latencyMs)} · 往返 ${formatMs(round.modelWaitMs)}` +
                        ` · 工具 ${formatMs(round.toolsMs)} · 生成 ${formatMs(round.generationMs)}` +
                        (round.streamed ? '' : ' · 非流式透出')
                      }
                    >
                      <span className="topo-node-id">R{round.index}</span>
                      <span className="topo-node-sub">
                        往返 <span className="num">{formatMs(round.modelWaitMs)}</span>
                      </span>
                      {round.contextPercent !== null && (
                        <span className="topo-node-note" data-warn={round.contextPercent >= THRESHOLDS.contextPressurePercent || undefined}>
                          上下文 <span className="num">{formatPercent(round.contextPercent, 0)}</span>
                        </span>
                      )}
                    </button>

                    {showTools && tools.length > 0 && (
                      <div className="topo-tools">
                        {tools.slice(0, TOOLS_PER_NODE).map((tool) => (
                          <button
                            key={tool.id}
                            type="button"
                            className="topo-tool"
                            data-tone={toneOf([tool])}
                            data-selected={tool.id === selectedStepId || undefined}
                            data-future={isFuture(tool.startMs, cursorMs) || undefined}
                            onClick={() => onSelectStep(tool.id)}
                            title={`${tool.name} · ${formatMs(tool.durationMs)} · ${tool.status}`}
                          >
                            <span className="topo-tool-name">{truncateText(tool.name, 9)}</span>
                            <span className="topo-tool-ms num">{formatMs(tool.durationMs)}</span>
                          </button>
                        ))}
                        {tools.length > TOOLS_PER_NODE && (
                          <span className="topo-tool-more">还有 {tools.length - TOOLS_PER_NODE} 次</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {hiddenRounds > 0 && (
                <div className="topo-step topo-node topo-terminal" data-kind="more" title={`另有 ${hiddenRounds} 个回合未画出`}>
                  <span className="topo-node-id">还有 {hiddenRounds} 个回合</span>
                  <span className="topo-node-sub">未画出</span>
                </div>
              )}

              <div
                className="topo-step topo-node topo-terminal"
                data-kind="end"
                title={`终态 · 墙钟 ${formatMs(insight.wallMs)} · 估算成本 ${formatCost(insight.totals.costUsd, currency)}`}
              >
                <span className="topo-node-id">终态</span>
                <span className="topo-node-sub">{STATUS_TEXT[insight.run.status]}</span>
                <span className="topo-node-note">成本 <span className="num">{formatCost(insight.totals.costUsd, currency)}</span></span>
              </div>
            </div>
          </div>

          <div className="topo-legend">
            {LEGEND.map(([tone, label]) => (
              <span className="topo-legend-item" key={tone}>
                <i data-tone={tone} />
                {label}
              </span>
            ))}
            <span className="topo-legend-hint">点节点看原始事件</span>
          </div>

          <div className="topo-metrics">
            <Metric label="回合" value={insight.totals.rounds} hint={parallelHint} />
            <Metric
              label="最慢回合"
              value={formatMs(slowest?.latencyMs ?? null)}
              hint={slowest === null ? undefined : `R${slowest.index} · 往返 ${formatMs(slowest.modelWaitMs)}`}
              tone={slowest !== null && slowest.latencyMs >= slowMs ? 'warn' : undefined}
            />
            <Metric
              label="工具失败"
              value={insight.totals.toolFailures}
              hint={`共 ${insight.totals.toolCalls} 次调用`}
              tone={insight.totals.toolFailures > 0 ? 'error' : undefined}
            />
          </div>

          <Panel level={2} collapsible title="逐回合明细" meta={`按开始时间 · 共 ${rounds.length} 个回合`}>
            <div className="topo-rows">
              {listedRounds.map((round) => {
                const stepId = `llm:${round.index}:0`
                return (
                  <button
                    key={round.index}
                    type="button"
                    className="topo-row"
                    data-selected={stepId === selectedStepId || undefined}
                    data-future={isFuture(round.startMs, cursorMs) || undefined}
                    onClick={() => onSelectStep(stepId)}
                    title={
                      `R${round.index} · 往返 ${formatMs(round.modelWaitMs)} · 工具 ${formatMs(round.toolsMs)}` +
                      (round.ttftMs === null ? ' · TTFT 不可测' : ` · TTFT ${formatMs(round.ttftMs)}`)
                    }
                  >
                    <span className="topo-row-id num">R{round.index}</span>
                    <span className="topo-row-sub">回合 <span className="num">{formatMs(round.latencyMs)}</span></span>
                    <span className="topo-row-sub">往返 <span className="num">{formatMs(round.modelWaitMs)}</span></span>
                    <span className="topo-row-sub">工具 <span className="num">{formatMs(round.toolsMs)}</span></span>
                  </button>
                )
              })}
            </div>

            {rounds.length > DETAIL_ROWS && (
              <button type="button" className="topo-more-btn" onClick={() => setShowAllRounds(!showAllRounds)}>
                {showAllRounds ? '收起' : `显示全部 ${rounds.length} 个回合`}
              </button>
            )}

            <p className="topo-note">
              口径：一个节点 = 一个 LLM 回合（以 context.usage 为界）；主图最多画 {MAX_NODES} 个回合；慢 = 回合时长超过{' '}
              <span className="num">{formatMs(slowMs)}</span>（30s 与本 run 中位数 2 倍取大）；失败 = 回合内有失败或超时的工具。
            </p>
          </Panel>
        </>
      )}
    </Panel>
  )
}
