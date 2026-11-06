/**
 * 事件流 → 看板派生模型。
 *
 * 埋点只有「事件 + 时间戳 + payload」，没有现成的 span 树，所以这里做三件事：
 * 1. 线性扫描事件，还原工具调用（tool.requested/started → updated* → completed/failed）、
 *    消息生命周期、上下文采样、压缩；
 * 2. 用 `context.usage` 作为**回合边界**（runtime 只在回合结束时透出累计用量），
 *    回合内用 delta 事件的时间戳聚类出「真生成片段」，避免把工具等待算进 LLM 耗时；
 * 3. 组装四个维度的派生结果（时间构成 / token 成本 / 上下文记忆 / 工具统计 + 异常）。
 *
 * 所有推导都尽量「可解释」：拿不到的写 null，不猜。
 */
import type { AgentContextUsageSegment, AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'

import { buildAnomalies, buildBreakdown, buildToolStats, signatureOf, THRESHOLDS } from './analyze'
import { costOf, type PriceSpec } from './pricing'
import { extractQuery, extractRetrieval, isRetrievalTool } from './retrieval'
import { classifyToolError, errorSummaryOf, errorTextOf } from './toolErrors'
import { addUsage, ZERO_USAGE, type Anomaly, type CompactionRecord, type ContextSample, type GanttRow, type GenerationSegment, type LlmRound, type RetrievalRecord, type StepStatus, type TokenUsage, type ToolCall, type TraceInsight } from './types'
import { assignLanes, clusterByGap, maxConcurrency, unionLength } from './timeMath'

export interface BuildTraceOptions {
  /** 计价模型；null = 不做成本估算（cost 全为 null）。 */
  price?: PriceSpec | null
  /** running run 的「现在」；缺省 Date.now()。 */
  now?: number
  /** delta 聚类阈值，默认 {@link THRESHOLDS.generationGapMs}。 */
  generationGapMs?: number
}

interface RawEvent {
  seq: number
  type: string
  atMs: number
  payload: Record<string, unknown>
}

interface MutableRound {
  startMs: number
  endMs: number
  deltas: Array<{ atMs: number; chars: number; reasoning: boolean; seq: number }>
  eventSeqs: number[]
  usage: { tokens: number | null; contextWindow: number; percent: number | null; segments: AgentContextUsageSegment[] | null; cumulative: TokenUsage | null } | null
}

interface MutableTool {
  id: string
  toolCallId: string
  name: string
  startMs: number
  endMs: number | null
  status: StepStatus
  args: unknown
  result: unknown
  updates: number
  progressStage: string | null
  eventSeqs: number[]
  failed: boolean
  approval: boolean
}

/** delta 跨度小于这个值视为「一次性下发」，TTFT 不可测。 */
const STREAM_MIN_SPAN_MS = 50

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeEvents(events: readonly AgentDebugEvent[]): RawEvent[] {
  const normalized: RawEvent[] = []
  for (const event of events) {
    const atMs = Date.parse(event.occurredAt)
    if (!Number.isFinite(atMs)) continue
    normalized.push({ seq: event.seq, type: event.type, atMs, payload: asRecord(event.payload) })
  }
  return normalized.sort((left, right) => left.seq - right.seq)
}

function usageOf(value: unknown): TokenUsage | null {
  const record = asRecord(value)
  const input = num(record.input)
  const output = num(record.output)
  if (input === null && output === null) return null
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(record.cacheRead) ?? 0,
    cacheWrite: num(record.cacheWrite) ?? 0,
  }
}

function subtractUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
  }
}

function segmentsOf(value: unknown): AgentContextUsageSegment[] | null {
  if (!Array.isArray(value)) return null
  const segments: AgentContextUsageSegment[] = []
  for (const item of value) {
    const record = asRecord(item)
    const key = str(record.key)
    const tokens = num(record.tokens)
    if (!key || tokens === null) continue
    segments.push({ key: key as AgentContextUsageSegment['key'], tokens })
  }
  return segments.length > 0 ? segments : null
}

/** 工具/审批的结束状态：failed 优先，其次按 run 的终态推断未闭合的工具。 */
function fallbackStatus(run: AgentDebugRun, failed: boolean): StepStatus {
  if (failed) return 'failed'
  if (run.status === 'running') return 'running'
  if (run.status === 'cancelled' || run.status === 'interrupted') return 'cancelled'
  if (run.status === 'failed') return 'failed'
  return 'unknown'
}

/** 从审批事件里取「人类审批」的可见结果。 */
function approvalOutcome(payload: Record<string, unknown>): StepStatus {
  const approved = payload.approved
  if (approved === false) return 'cancelled'
  return 'ok'
}

export function buildTrace(
  run: AgentDebugRun,
  events: readonly AgentDebugEvent[],
  options: BuildTraceOptions = {},
): TraceInsight {
  const price = options.price ?? null
  const now = options.now ?? Date.now()
  const gapMs = options.generationGapMs ?? THRESHOLDS.generationGapMs
  const startWallMs = Date.parse(run.startedAt)
  const eventsSorted = normalizeEvents(events)
  const lastEventMs = eventsSorted.length > 0 ? eventsSorted[eventsSorted.length - 1].atMs : startWallMs
  const running = run.status === 'running'
  const endWallMs = run.completedAt
    ? Date.parse(run.completedAt)
    : (running ? Math.max(now, lastEventMs) : lastEventMs)
  const wallMs = Math.max(0, endWallMs - startWallMs)

  const deltaText = new Map<number, string>()
  for (const event of eventsSorted) {
    if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') continue
    const delta = str(event.payload.delta)
    if (!delta) continue
    const prefix = event.type === 'reasoning.delta' ? 'reasoning' : 'message'
    deltaText.set(event.seq, `${prefix}:${delta}`)
  }

  const roundsRaw: MutableRound[] = []
  const pendingDeltas: MutableRound['deltas'] = []
  const pendingSeqs: number[] = []
  const tools = new Map<string, MutableTool>()
  const toolOrder: string[] = []
  const compactions: Array<{ seq: number; atMs: number; active: boolean; reason: string }> = []
  const approvalIndex = new Map<string, string>()
  let outputChars = 0
  let reasoningChars = 0

  const openTool = (key: string, tool: MutableTool): void => {
    if (tools.has(key)) return
    tools.set(key, tool)
    toolOrder.push(key)
  }

  for (const event of eventsSorted) {
    const payload = event.payload
    pendingSeqs.push(event.seq)
    switch (event.type) {
      case 'message.delta': {
        const delta = str(payload.delta) ?? ''
        if (!delta) break
        outputChars += delta.length
        pendingDeltas.push({ atMs: event.atMs, chars: delta.length, reasoning: false, seq: event.seq })
        break
      }
      case 'reasoning.delta': {
        const delta = str(payload.delta) ?? ''
        if (!delta) break
        reasoningChars += delta.length
        pendingDeltas.push({ atMs: event.atMs, chars: delta.length, reasoning: true, seq: event.seq })
        break
      }
      case 'context.usage': {
        const cumulative = usageOf(payload.runUsage)
        const roundStart = roundsRaw.length === 0 ? startWallMs : roundsRaw[roundsRaw.length - 1].endMs
        roundsRaw.push({
          startMs: roundStart,
          endMs: event.atMs,
          deltas: pendingDeltas.splice(0, pendingDeltas.length),
          eventSeqs: pendingSeqs.splice(0, pendingSeqs.length),
          usage: {
            tokens: num(payload.tokens),
            contextWindow: num(payload.contextWindow) ?? 0,
            percent: num(payload.percent),
            segments: segmentsOf(payload.segments),
            cumulative,
          },
        })
        break
      }
      case 'tool.requested':
      case 'tool.started': {
        const toolCallId = str(payload.toolCallId) ?? ''
        const name = str(payload.name) ?? 'unknown_tool'
        const key = toolCallId || `seq-${event.seq}`
        const existing = tools.get(key)
        if (existing) {
          existing.args = payload.args ?? existing.args
          existing.eventSeqs.push(event.seq)
          break
        }
        openTool(key, {
          id: `tool:${key}`,
          toolCallId: key,
          name,
          startMs: event.atMs,
          endMs: null,
          status: 'running',
          args: payload.args ?? null,
          result: null,
          updates: 0,
          progressStage: null,
          eventSeqs: [event.seq],
          failed: false,
          approval: false,
        })
        break
      }
      case 'tool.updated': {
        const tool = tools.get(str(payload.toolCallId) ?? `seq-${event.seq}`)
        if (!tool) break
        tool.updates += 1
        const details = asRecord(asRecord(payload.partialResult).details)
        tool.progressStage = str(details.stage) ?? str(asRecord(payload).stage) ?? tool.progressStage
        tool.eventSeqs.push(event.seq)
        break
      }
      case 'tool.completed':
      case 'tool.failed': {
        const tool = tools.get(str(payload.toolCallId) ?? `seq-${event.seq}`)
        if (!tool) break
        tool.endMs = event.atMs
        tool.result = payload.result ?? null
        tool.failed = event.type === 'tool.failed'
        tool.status = event.type === 'tool.failed' ? 'failed' : 'ok'
        if (tool.failed) {
          const text = errorTextOf(payload.result)
          if (/timed? ?out|timeout|deadline exceeded/i.test(text)) tool.status = 'timeout'
        }
        tool.eventSeqs.push(event.seq)
        break
      }
      case 'approval.requested': {
        const approvalId = str(payload.approvalId) ?? `seq-${event.seq}`
        const toolName = str(payload.toolName) ?? 'approval'
        const key = `approval:${approvalId}`
        approvalIndex.set(approvalId, key)
        openTool(key, {
          id: `tool:${key}`,
          toolCallId: key,
          name: `${toolName} · 审批`,
          startMs: event.atMs,
          endMs: null,
          status: 'running',
          args: {
            command: payload.command ?? null,
            cwd: payload.cwd ?? null,
            timeoutMs: payload.timeoutMs ?? null,
            kind: payload.kind ?? null,
          },
          result: null,
          updates: 0,
          progressStage: null,
          eventSeqs: [event.seq],
          failed: false,
          approval: true,
        })
        break
      }
      case 'approval.resolved': {
        const key = approvalIndex.get(str(payload.approvalId) ?? '')
        const tool = key ? tools.get(key) : undefined
        if (!tool) break
        tool.endMs = event.atMs
        tool.status = approvalOutcome(payload)
        tool.result = { approved: payload.approved ?? null }
        tool.eventSeqs.push(event.seq)
        break
      }
      case 'context.compaction': {
        compactions.push({
          seq: event.seq,
          atMs: event.atMs,
          active: payload.active !== false,
          reason: str(payload.reason) ?? '未透出原因',
        })
        break
      }
      default:
        break
    }
  }

  // ── 工具调用收尾 ────────────────────────────────────────────────────────────
  const usageTimes = roundsRaw.map((round) => round.endMs)
  const toolCalls: ToolCall[] = []
  const repeatCounts = new Map<string, number>()
  for (const key of toolOrder) {
    const tool = tools.get(key)
    if (!tool) continue
    const endMs = tool.endMs ?? endWallMs
    const status = tool.endMs === null ? fallbackStatus(run, tool.failed) : tool.status
    const errorClassRaw = tool.failed || status === 'timeout' ? classifyToolError(tool.result) : null
    const durationMs = Math.max(0, endMs - tool.startMs)
    const roundIndex = usageTimes.filter((time) => time < tool.startMs).length + 1
    toolCalls.push({
      id: tool.id,
      toolCallId: tool.toolCallId,
      name: tool.name,
      roundIndex,
      startMs: Math.max(0, tool.startMs - startWallMs),
      endMs: Math.max(0, endMs - startWallMs),
      durationMs,
      status,
      args: tool.args,
      result: tool.result,
      error: errorClassRaw ? errorClassRaw.summary || null : null,
      errorClass: errorClassRaw ? errorClassRaw.errorClass : null,
      severity: status === 'failed' || status === 'timeout'
        ? 'error'
        : (status === 'cancelled' || durationMs > THRESHOLDS.slowStepMs ? 'warn' : 'ok'),
      lane: 0,
      updates: tool.updates,
      progressStage: tool.progressStage,
      repeatIndex: 0,
      retrieval: isRetrievalTool(tool.name),
      eventSeqs: tool.eventSeqs,
    })
  }
  // 重复调用签名（同名同参）——放在 args 拿到之后算，避免在前面重复 stringify。
  for (const tool of toolCalls) {
    const signature = signatureOf(tool)
    const prior = repeatCounts.get(`__sig__${signature}`) ?? 0
    repeatCounts.set(`__sig__${signature}`, prior + 1)
    tool.repeatIndex = prior === 0 ? 0 : prior
  }
  const lanes = assignLanes(toolCalls.map((tool) => ({ startMs: tool.startMs, endMs: tool.endMs })))
  toolCalls.forEach((tool, index) => { tool.lane = lanes[index] ?? 0 })

  // ── 回合 ────────────────────────────────────────────────────────────────────
  const rounds: LlmRound[] = []
  let previousCumulative: TokenUsage | null = null
  let previousTokens: number | null = null
  const compactionRounds = new Set<number>()
  for (const compaction of compactions) {
    for (let index = 0; index < roundsRaw.length; index += 1) {
      if (compaction.atMs <= roundsRaw[index].endMs && compaction.atMs >= roundsRaw[index].startMs) {
        compactionRounds.add(index + 1)
        break
      }
    }
  }
  roundsRaw.forEach((raw, index) => {
    const roundIndex = index + 1
    const times = raw.deltas.map((delta) => delta.atMs)
    const clusters = clusterByGap(times, gapMs)
    const segments: GenerationSegment[] = clusters.map((cluster) => {
      let chars = 0
      let reasoning = 0
      for (let cursor = cluster.fromIndex; cursor <= cluster.toIndex; cursor += 1) {
        const delta = raw.deltas[cursor]
        if (delta.reasoning) reasoning += delta.chars
        else chars += delta.chars
      }
      return {
        startMs: Math.max(0, cluster.startMs - startWallMs),
        endMs: Math.max(0, cluster.endMs - startWallMs),
        chars,
        reasoningChars: reasoning,
      }
    })
    const cumulative = raw.usage?.cumulative ?? null
    const usageDelta = cumulative && previousCumulative ? subtractUsage(cumulative, previousCumulative) : (cumulative ?? null)
    const tokens = raw.usage?.tokens ?? null
    const memoryDelta = tokens !== null && previousTokens !== null ? tokens - previousTokens : null
    const firstDelta = raw.deltas.length > 0 ? raw.deltas[0].atMs : null
    const lastDelta = raw.deltas.length > 0 ? raw.deltas[raw.deltas.length - 1].atMs : null
    const streamed = firstDelta !== null && lastDelta !== null && raw.deltas.length > 1 && lastDelta - firstDelta > STREAM_MIN_SPAN_MS
    const roundToolsMs = unionLength(toolCalls
      .filter((tool) => tool.roundIndex === roundIndex)
      .map((tool) => ({ startMs: tool.startMs, endMs: tool.endMs })))
    const latencyMs = Math.max(0, raw.endMs - raw.startMs)
    const generationMs = segments.reduce((total, segment) => total + (segment.endMs - segment.startMs), 0)
    rounds.push({
      index: roundIndex,
      startMs: Math.max(0, raw.startMs - startWallMs),
      endMs: Math.max(0, raw.endMs - startWallMs),
      latencyMs,
      toolsMs: roundToolsMs,
      modelWaitMs: Math.max(0, latencyMs - roundToolsMs - generationMs),
      streamed,
      ttftMs: streamed && firstDelta !== null ? Math.max(0, firstDelta - raw.startMs) : null,
      generationMs,
      segments,
      outputChars: raw.deltas.reduce((total, delta) => total + (delta.reasoning ? 0 : delta.chars), 0),
      reasoningChars: raw.deltas.reduce((total, delta) => total + (delta.reasoning ? delta.chars : 0), 0),
      usageDelta,
      usageCumulative: cumulative,
      costUsd: costOf(usageDelta, price),
      contextTokens: tokens,
      contextWindow: raw.usage?.contextWindow ?? null,
      contextPercent: raw.usage?.percent ?? null,
      contextSegments: raw.usage?.segments ?? null,
      memoryDelta,
      tools: toolCalls.filter((tool) => tool.roundIndex === roundIndex).map((tool) => tool.id),
      compaction: compactionRounds.has(roundIndex),
      outputText: collectText(raw, deltaText, false),
      reasoningText: collectText(raw, deltaText, true),
      eventSeqs: raw.eventSeqs,
    })
    if (cumulative) previousCumulative = cumulative
    if (tokens !== null) previousTokens = tokens
  })

  // ── 上下文采样序列 ──────────────────────────────────────────────────────────
  const contextSeries: ContextSample[] = roundsRaw.map((raw, index) => {
    const round = rounds[index]
    return {
      seq: raw.eventSeqs[raw.eventSeqs.length - 1] ?? 0,
      atMs: round.endMs,
      roundIndex: round.index,
      tokens: round.contextTokens,
      contextWindow: round.contextWindow ?? 0,
      percent: round.contextPercent,
      segments: round.contextSegments,
      cumulative: round.usageCumulative,
      delta: round.usageDelta,
    }
  })

  const compactionRecords: CompactionRecord[] = compactions.map((compaction) => {
    const before = [...contextSeries].reverse().find((sample) => sample.atMs <= compaction.atMs - startWallMs)
    const after = contextSeries.find((sample) => sample.atMs >= compaction.atMs - startWallMs)
    return {
      seq: compaction.seq,
      atMs: Math.max(0, compaction.atMs - startWallMs),
      active: compaction.active,
      reason: compaction.reason,
      beforeTokens: before?.tokens ?? null,
      afterTokens: after?.tokens ?? null,
    }
  })

  // ── 检索召回 ────────────────────────────────────────────────────────────────
  const retrievals: RetrievalRecord[] = toolCalls
    .filter((tool) => tool.retrieval)
    .map((tool) => {
      const extract = extractRetrieval(tool.result)
      const nextRound = rounds[tool.roundIndex]
      const hitless = extract.hitCount === 0
      // 0 命中时 runtime 返回的是「没有匹配」的提示句，不是召回片段；也不存在「注入上下文」。
      const fedToContext = hitless || !nextRound
        ? null
        : (nextRound.usageDelta ? nextRound.usageDelta.input > 0 : null)
      return {
        toolCallId: tool.id,
        roundIndex: tool.roundIndex,
        atMs: tool.startMs,
        toolName: tool.name,
        query: extractQuery(tool.args),
        hitCount: extract.hitCount,
        latencyMs: tool.durationMs,
        chunks: hitless ? [] : extract.chunks,
        fedToContext,
      }
    })

  // ── 甘特行 ──────────────────────────────────────────────────────────────────
  // 每个回合一行：横跨整段回合时长（模型往返 + 生成），否则非流式运行时
  // 「生成片段」只有零点几毫秒，在 10 分钟的轴上根本看不见。
  // 生成片段的位置由甘特组件在行内画成细刻度（见 GanttLanes）。
  const rows: GanttRow[] = []
  for (const round of rounds) {
    rows.push({
      id: `llm:${round.index}:0`,
      kind: 'llm',
      roundIndex: round.index,
      label: `R${round.index} 回合`,
      detail: `${round.outputChars + round.reasoningChars} 字`,
      startMs: round.startMs,
      endMs: Math.max(round.endMs, round.startMs + 1),
      severity: round.latencyMs > THRESHOLDS.slowRoundMs ? 'warn' : 'ok',
      status: 'ok',
      toolCallId: null,
      lane: 0,
    })
  }
  for (const tool of toolCalls) {
    rows.push({
      id: tool.id,
      kind: tool.name.endsWith('· 审批') ? 'approval' : 'tool',
      roundIndex: tool.roundIndex,
      label: tool.name,
      detail: '',
      startMs: tool.startMs,
      endMs: Math.max(tool.endMs, tool.startMs + 1),
      severity: tool.severity,
      status: tool.status,
      toolCallId: tool.id,
      lane: tool.lane,
    })
  }
  rows.sort((left, right) => left.startMs - right.startMs || left.roundIndex - right.roundIndex)

  // ── 汇总 ────────────────────────────────────────────────────────────────────
  const totalToolMs = roundsBreakdownToolMs(toolCalls)
  const breakdown = buildBreakdown(
    wallMs,
    toolCalls.map((tool) => ({ startMs: tool.startMs, endMs: tool.endMs })),
    rounds.flatMap((round) => round.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs }))),
    rounds.reduce((total, round) => total + (round.ttftMs ?? 0), 0),
    rounds.reduce((total, round) => total + round.modelWaitMs, 0),
  )
  const lastCumulative = [...rounds].reverse().find((round) => round.usageCumulative)?.usageCumulative ?? null
  const usage: TokenUsage = lastCumulative
    ?? rounds.reduce<TokenUsage>((total, round) => (round.usageDelta ? addUsage(total, round.usageDelta) : total), { ...ZERO_USAGE })
  const costUsd = price ? rounds.reduce((total, round) => total + (round.costUsd ?? 0), 0) : null
  const peakSample = contextSeries.reduce<ContextSample | null>((best, sample) => {
    if (sample.percent === null) return best
    if (!best || (best.percent ?? -1) < sample.percent) return sample
    return best
  }, null)
  const slowSteps = toolCalls.filter((tool) => tool.durationMs > THRESHOLDS.slowStepMs).length
  const anomalies: Anomaly[] = buildAnomalies({
    tools: toolCalls,
    rounds,
    contextSeries,
    peakContextPercent: peakSample?.percent ?? null,
  })

  return {
    run,
    events: eventsSorted.length > 0 ? events : [],
    startWallMs,
    endWallMs,
    wallMs,
    running,
    rounds,
    tools: toolCalls,
    rows,
    contextSeries,
    compactions: compactionRecords,
    retrievals,
    breakdown,
    toolStats: buildToolStats(toolCalls, totalToolMs),
    anomalies,
    generationSegments: rounds.reduce((total, round) => total + round.segments.length, 0),
    totals: {
      usage,
      usageComplete: lastCumulative !== null,
      costUsd,
      toolCalls: toolCalls.length,
      toolFailures: toolCalls.filter((tool) => tool.status === 'failed' || tool.status === 'timeout').length,
      slowSteps,
      rounds: rounds.length,
      peakContextPercent: peakSample?.percent ?? null,
      peakContextTokens: peakSample?.tokens ?? null,
      contextWindow: peakSample?.contextWindow || null,
      maxParallelTools: maxConcurrency(toolCalls.map((tool) => ({ startMs: tool.startMs, endMs: tool.endMs }))),
      retrievalCalls: retrievals.length,
      compactions: compactions.length,
      reasoningChars,
      outputChars,
      streamedRounds: rounds.filter((round) => round.streamed).length,
      singleShotRounds: rounds.filter((round) => !round.streamed).length,
    },
  }
}

function roundsBreakdownToolMs(tools: readonly ToolCall[]): number {
  return tools.reduce((total, tool) => total + tool.durationMs, 0)
}

/** 拼回合内的流式文本（下钻展示原始 output / reasoning 用）。 */
function collectText(raw: MutableRound, deltaText: Map<number, string>, reasoning: boolean): string {
  const prefix = reasoning ? 'reasoning' : 'message'
  const parts: string[] = []
  for (const seq of raw.eventSeqs) {
    const entry = deltaText.get(seq)
    if (entry && entry.startsWith(prefix)) parts.push(entry.slice(prefix.length + 1))
  }
  return parts.join('')
}

/** 事件兜底：runtime 只发了 message.completed 时补一条文本（用于下钻）。 */
export function messageTextOf(events: readonly AgentDebugEvent[]): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.type !== 'message.completed') continue
    const content = asRecord(event.payload).content
    if (typeof content === 'string' && content.trim()) parts.push(content)
  }
  return parts.join('\n')
}

/** 错误摘要给 UI（导出给下钻用）。 */
export { errorSummaryOf }
