/** 看板的「洞察」聚合：时间构成、工具统计、异常清单。纯函数，输入全是派生模型。 */
import { errorClassLabel } from './toolErrors'
import { unionLength, unionSpans } from './timeMath'
import type {
  Anomaly,
  ContextSample,
  LlmRound,
  TimeBreakdown,
  TimeSpan,
  ToolCall,
  ToolStat,
} from './types'

/** 异常染色阈值（UI 图例直接引用这些常量，保证文案与判据一致）。 */
export const THRESHOLDS = {
  /** 单步超过这个耗时染黄。 */
  slowStepMs: 10_000,
  /** 单个模型回合超过这个耗时染黄（回合天然比工具长，阈值单列）。 */
  slowRoundMs: 30_000,
  /** 上下文峰值占用超过这个百分比提示「可能溢出」。 */
  contextPressurePercent: 80,
  /** 同名同参连续调用达到这个次数判为疑似死循环。 */
  loopRepeatCount: 3,
  /** 运行中工具超过这个时长且没有任何进度推送，判为卡住。 */
  stallMs: 120_000,
  /** 同一工具在一个 run 里被调用这么多次，提示「高频重调」（多半是校验/重试循环）。 */
  hammerCalls: 10,
  /** 同一工具「失败后又被调用」这么多次，判为重试风暴。 */
  retryWarnCount: 1,
  /** delta 事件间隔超过这个毫秒数就断开成新的生成片段。 */
  generationGapMs: 1_200,
} as const

export function buildBreakdown(
  wallMs: number,
  toolSpans: readonly TimeSpan[],
  llmSpans: readonly TimeSpan[],
  ttftMs: number,
  modelWaitMs: number,
): TimeBreakdown {
  const toolMs = unionLength(toolSpans)
  const llmMs = unionLength(llmSpans)
  const busyMs = unionLength([...toolSpans, ...llmSpans])
  const wait = Math.max(0, modelWaitMs)
  return {
    wallMs,
    toolMs,
    llmMs,
    ttftMs,
    modelWaitMs: wait,
    gapMs: Math.max(0, wallMs - busyMs - wait),
  }
}

/** 工具名聚合：先按耗时倒序，再按调用数倒序（耗时占比才是优化重点）。 */
export function buildToolStats(tools: readonly ToolCall[], totalToolMs: number): ToolStat[] {
  const byName = new Map<string, ToolStat & { durations: number[] }>()
  for (const tool of tools) {
    const existing = byName.get(tool.name)
    const stat = existing ?? {
      name: tool.name,
      calls: 0,
      failures: 0,
      failureRate: null,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0,
      timeShare: null,
      errorClasses: {},
      durations: [],
    }
    stat.calls += 1
    stat.totalMs += tool.durationMs
    stat.maxMs = Math.max(stat.maxMs, tool.durationMs)
    stat.durations.push(tool.durationMs)
    if (tool.status === 'failed' || tool.status === 'timeout' || tool.status === 'cancelled') {
      stat.failures += 1
      if (tool.errorClass) {
        stat.errorClasses[tool.errorClass] = (stat.errorClasses[tool.errorClass] ?? 0) + 1
      }
    }
    byName.set(tool.name, stat)
  }
  return [...byName.values()]
    .map(({ durations, ...stat }) => ({
      ...stat,
      avgMs: stat.calls > 0 ? stat.totalMs / stat.calls : 0,
      failureRate: stat.calls > 0 ? stat.failures / stat.calls : null,
      timeShare: totalToolMs > 0 ? stat.totalMs / totalToolMs : null,
    }))
    .sort((left, right) => right.totalMs - left.totalMs || right.calls - left.calls)
}

export interface AnomalyInput {
  tools: readonly ToolCall[]
  rounds: readonly LlmRound[]
  contextSeries: readonly ContextSample[]
  peakContextPercent: number | null
}

/**
 * 异常清单：每条都带「判据 + 数字」，排序 error → warn → 时间。
 * 只报能改进的问题，不做「一切正常」的静默（空清单由 UI 呈现空态）。
 */
export function buildAnomalies(input: AnomalyInput): Anomaly[] {
  const anomalies: Anomaly[] = []

  for (const tool of input.tools) {
    if (tool.status === 'failed' || tool.status === 'timeout') {
      anomalies.push({
        id: `error:${tool.id}`,
        kind: 'error',
        severity: 'error',
        title: `${tool.name} 调用失败 · ${tool.errorClass ? errorClassLabel(tool.errorClass) : '未归类'}`,
        detail: tool.error ? tool.error.split('\n')[0].slice(0, 180) : '工具返回失败，无错误文本',
        atMs: tool.startMs,
        stepId: tool.id,
      })
    }
    if (tool.durationMs > THRESHOLDS.slowStepMs && tool.status !== 'running') {
      anomalies.push({
        id: `slow:${tool.id}`,
        kind: 'slow',
        severity: 'warn',
        title: `${tool.name} 耗时 ${(tool.durationMs / 1000).toFixed(1)}s`,
        detail: `超过慢调用阈值 ${(THRESHOLDS.slowStepMs / 1000).toFixed(0)}s · ${tool.updates > 0 ? `期间收到 ${tool.updates} 次进度推送` : '期间无进度推送'}`,
        atMs: tool.startMs,
        stepId: tool.id,
      })
    }
    if (
      tool.status === 'running'
      && tool.durationMs > THRESHOLDS.stallMs
      && tool.updates === 0
    ) {
      anomalies.push({
        id: `stall:${tool.id}`,
        kind: 'no_progress',
        severity: 'warn',
        title: `${tool.name} 疑似卡住`,
        detail: `已运行 ${(tool.durationMs / 1000).toFixed(0)}s 且没有任何进度推送`,
        atMs: tool.startMs,
        stepId: tool.id,
      })
    }
  }

  // 同名同参重复调用：按(工具名+参数)聚合，达到阈值报一次，避免刷屏。
  const repeated = new Map<string, ToolCall[]>()
  for (const tool of input.tools) {
    if (tool.repeatIndex === 0) continue
    const key = `${tool.name}::${tool.repeatIndex > 0 ? signatureOf(tool) : ''}`
    const list = repeated.get(key)
    if (list) list.push(tool)
    else repeated.set(key, [tool])
  }
  for (const [key, list] of repeated) {
    const total = list.length + 1
    if (total < THRESHOLDS.loopRepeatCount) continue
    const first = list[0]
    anomalies.push({
      id: `loop:${key}`,
      kind: 'loop',
      severity: 'warn',
      title: `${first.name} 重复调用 ${total} 次（同名同参）`,
      detail: `可能陷入重试循环 · 首次 ${(first.startMs / 1000).toFixed(0)}s，最后一次 ${(list[list.length - 1].startMs / 1000).toFixed(0)}s · 累计耗时 ${((list.reduce((sum, tool) => sum + tool.durationMs, first.durationMs)) / 1000).toFixed(1)}s`,
      atMs: first.startMs,
      stepId: first.id,
    })
  }

  // 重试风暴：同名工具在失败之后又被调用（参数可能改过，所以不是同名同参）。
  const retryByTool = new Map<string, { retries: number; failures: number; firstAtMs: number; firstStepId: string }>()
  const seenByName = new Map<string, ToolCall>()
  for (const tool of input.tools) {
    const previous = seenByName.get(tool.name)
    if (previous && (previous.status === 'failed' || previous.status === 'timeout')) {
      const entry = retryByTool.get(tool.name) ?? {
        retries: 0,
        failures: 0,
        firstAtMs: previous.startMs,
        firstStepId: previous.id,
      }
      entry.retries += 1
      entry.failures += 1
      retryByTool.set(tool.name, entry)
    }
    seenByName.set(tool.name, tool)
  }
  for (const [name, entry] of retryByTool) {
    if (entry.retries < THRESHOLDS.retryWarnCount) continue
    anomalies.push({
      id: `retry:${name}`,
      kind: 'retry',
      severity: 'warn',
      title: `${name} 失败后重试 ${entry.retries} 次`,
      detail: `同一工具在报错后又被调用 ${entry.retries} 次，通常说明 Agent 在反复试错（参数/契约不匹配）`,
      atMs: entry.firstAtMs,
      stepId: entry.firstStepId,
    })
  }

  // 高频重调：同一个工具被调用几十上百次，是耗时与 token 的主要来源之一。
  const callsByName = new Map<string, ToolCall[]>()
  for (const tool of input.tools) {
    const list = callsByName.get(tool.name)
    if (list) list.push(tool)
    else callsByName.set(tool.name, [tool])
  }
  for (const [name, list] of callsByName) {
    if (list.length < THRESHOLDS.hammerCalls) continue
    const totalMs = list.reduce((sum, tool) => sum + tool.durationMs, 0)
    const failures = list.filter((tool) => tool.status === 'failed').length
    anomalies.push({
      id: `hammer:${name}`,
      kind: 'loop',
      severity: 'warn',
      title: `${name} 被调用 ${list.length} 次`,
      detail: `累计耗时 ${(totalMs / 1000).toFixed(1)}s · 失败 ${failures} 次 · 高频重调会同时推高耗时和 token`,
      atMs: list[0].startMs,
      stepId: list[0].id,
    })
  }

  for (const round of input.rounds) {
    if (!round.compaction) continue
    anomalies.push({
      id: `compaction:${round.index}`,
      kind: 'compaction',
      severity: 'warn',
      title: `第 ${round.index} 回合触发上下文压缩`,
      detail: `压缩前 ${round.memoryDelta === null ? '—' : `${round.memoryDelta} tokens`} · 压缩后占用 ${round.contextTokens ?? '—'} tokens`,
      atMs: round.endMs,
      stepId: null,
    })
  }

  if (input.peakContextPercent !== null && input.peakContextPercent >= THRESHOLDS.contextPressurePercent) {
    const peak = input.contextSeries.reduce<ContextSample | null>((best, sample) => {
      if (sample.percent === null) return best
      if (!best || (best.percent ?? 0) < sample.percent) return sample
      return best
    }, null)
    anomalies.push({
      id: 'context-pressure',
      kind: 'context_pressure',
      severity: input.peakContextPercent >= 95 ? 'error' : 'warn',
      title: `上下文峰值占满 ${input.peakContextPercent.toFixed(1)}%`,
      detail: `第 ${peak?.roundIndex ?? '—'} 回合占用 ${peak?.tokens ?? '—'} / ${peak?.contextWindow ?? '—'} tokens`,
      atMs: peak?.atMs ?? 0,
      stepId: null,
    })
  }

  const rank: Record<Anomaly['severity'], number> = { error: 0, warn: 1, ok: 2 }
  return anomalies
    .sort((left, right) => rank[left.severity] - rank[right.severity] || left.atMs - right.atMs)
    .slice(0, 80)
}

/** 参数签名（用于同名同参判定）；超长参数不参与，避免大 payload 反复 stringify。 */
export function signatureOf(tool: Pick<ToolCall, 'name' | 'args'>): string {
  let args = ''
  try {
    args = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args) ?? ''
  } catch {
    args = String(tool.args)
  }
  return `${tool.name}::${args.length > 4_000 ? args.slice(0, 4_000) : args}`
}

/** 时间构成百分比（堆叠条用），保证四段相加为 100（wall 为 0 时全 0）。 */
export function breakdownShares(breakdown: TimeBreakdown): {
  tool: number
  llm: number
  wait: number
  gap: number
} {
  const wall = breakdown.wallMs
  if (!Number.isFinite(wall) || wall <= 0) return { tool: 0, llm: 0, wait: 0, gap: 0 }
  // 三段占比按「各段之和」归一，避免并集口径下相加超过 100% 时把 gap 压成负数。
  const parts = [breakdown.toolMs, breakdown.llmMs, breakdown.modelWaitMs, breakdown.gapMs]
  const total = parts.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0) return { tool: 0, llm: 0, wait: 0, gap: 0 }
  return {
    tool: clamp01(breakdown.toolMs / total),
    llm: clamp01(breakdown.llmMs / total),
    wait: clamp01(breakdown.modelWaitMs / total),
    gap: clamp01(breakdown.gapMs / total),
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 把时间轴上的区间裁到 [0, wall]，渲染前统一调用，避免越界柱条。 */
export function clipSpans(spans: readonly TimeSpan[], wallMs: number): TimeSpan[] {
  return unionSpans(spans
    .map((span) => ({
      startMs: Math.max(0, Math.min(span.startMs, wallMs)),
      endMs: Math.max(0, Math.min(span.endMs, wallMs)),
    }))
    .filter((span) => span.endMs >= span.startMs))
}
