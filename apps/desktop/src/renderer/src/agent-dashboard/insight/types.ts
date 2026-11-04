/**
 * Agent 链路剖析看板的派生数据模型（纯类型 + 常量 + 极小的算术 helper）。
 *
 * 输入是 Gateway 埋点契约（`AgentDebugRun` + `AgentDebugEvent[]`），输出是看板需要的
 * 四个维度：时间/拓扑、成本、上下文、工具。所有字段都必须是**可解释的**：
 * 每个数字都要能指回「由哪些事件算出来的」，拿不到的数据一律 `null`（UI 显示「未透出」），
 * 不用 0 或估算值冒充真实值。
 */
import type { AgentContextUsageSegment, AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'

/** 一次 LLM 请求/生成回合在时间轴上的归属。 */
export type StepKind = 'llm' | 'tool' | 'approval' | 'compaction'

export type StepStatus = 'ok' | 'failed' | 'timeout' | 'cancelled' | 'running' | 'unknown'

/** 异常染色：正常 / 需要留意（慢、循环、上下文压力）/ 出错。 */
export type Severity = 'ok' | 'warn' | 'error'

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

/** 计费口径下的总 token（缓存读仍按较低单价计费，所以单独展示，不并入 input）。 */
export function usageTotal(usage: TokenUsage | null | undefined): number | null {
  if (!usage) return null
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/** 工具错误的自动归类（详见 toolErrors.ts 的 classifyToolError）。 */
export type ToolErrorClass =
  | 'arg_validation'
  | 'timeout'
  | 'not_found'
  | 'auth'
  | 'rate_limit'
  | 'upstream'
  | 'cancelled'
  | 'runtime'
  | 'other'

/** 时间轴的连续区段（带宽度的片段，用于堆叠条 / 甘特行）。 */
export interface TimeSpan {
  startMs: number
  endMs: number
}

/** 生成时间被切成的连续片段：delta 事件之间停顿超过阈值就断成新片段。 */
export interface GenerationSegment extends TimeSpan {
  chars: number
  reasoningChars: number
}

/** 一次工具调用（tool.requested/started → tool.completed/failed）。 */
export interface ToolCall {
  /** 稳定 id：`tool:<toolCallId>`；缺失 toolCallId 时退回事件序号。 */
  id: string
  toolCallId: string
  name: string
  /** 归属回合（1 起；0 表示首条 context.usage 之前）。 */
  roundIndex: number
  startMs: number
  /** 未结束时等于 run 的当前时间。 */
  endMs: number
  durationMs: number
  status: StepStatus
  args: unknown
  result: unknown
  /** 失败时的错误文本（tool.failed 的 result 里提取）。 */
  error: string | null
  errorClass: ToolErrorClass | null
  severity: Severity
  /** 并发泳道（0 起），按真实时间重叠贪心分配。 */
  lane: number
  /** tool.updated 进度推送次数（长任务心跳，>0 说明工具自己在上报阶段）。 */
  updates: number
  /** 最近一次 tool.updated 的阶段标签（如 `style_generating`）。 */
  progressStage: string | null
  /** 同名同参的重复调用序号：0 首次，>0 说明在重试/死循环。 */
  repeatIndex: number
  /** 该调用是否命中 RAG/记忆检索（见 retrieval.ts）。 */
  retrieval: boolean
  /** 关联事件序号（下钻探针按序号取原始 payload）。 */
  eventSeqs: number[]
}

/** 上下文占用的一次采样（每个 context.usage 一条）。 */
export interface ContextSample {
  seq: number
  atMs: number
  roundIndex: number
  tokens: number | null
  contextWindow: number
  percent: number | null
  segments: AgentContextUsageSegment[] | null
  /** 该次采样的累计用量（runtime 口径，跨回合累加）。 */
  cumulative: TokenUsage | null
  /** 相对上一次采样的增量。 */
  delta: TokenUsage | null
}

/** 上下文压缩（记忆剪裁）记录。 */
export interface CompactionRecord {
  seq: number
  atMs: number
  active: boolean
  reason: string
  /** 压缩前 / 后的上下文 token（由相邻采样推断，缺失为 null）。 */
  beforeTokens: number | null
  afterTokens: number | null
}

/**
 * 一次 LLM 回合：从上一回合结束（或 run 开始）到本条 context.usage。
 * 回合是 token 归属的最小单位——runtime 只在回合结束时透出累计用量。
 */
export interface LlmRound {
  index: number
  /** 回合开始（上一条 context.usage 时间；首回合为 run 开始）。 */
  startMs: number
  /** 回合结束（context.usage 时间）。 */
  endMs: number
  /** 回合墙钟时长（含本回合内的工具执行与模型往返）。 */
  latencyMs: number
  /** 本回合窗口内工具执行占用（并集）。 */
  toolsMs: number
  /**
   * 模型往返/排队估算 = 回合时长 − 本回合工具 − 本回合生成。
   * 这是「没有事件覆盖的等待」在单回合上的分摊，非流式运行时它基本就是模型总延迟。
   */
  modelWaitMs: number
  /**
   * 该回合是否有真正的流式输出（≥2 条 delta 且跨度 > 50ms）。
   * false 时 TTFT 无法测量（runtime 一次性下发整段文本），此时 ttftMs 为 null。
   */
  streamed: boolean
  /** 首字前等待：回合开始 → 本回合首个 delta。仅流式回合可得，否则 null。 */
  ttftMs: number | null
  /** 生成片段耗时之和（delta 聚类，剔除工具执行期间的停顿）。 */
  generationMs: number
  segments: GenerationSegment[]
  outputChars: number
  reasoningChars: number
  /** 是否有过 message.started / message.completed 覆盖（pi 长消息会跨回合）。 */
  usageDelta: TokenUsage | null
  usageCumulative: TokenUsage | null
  costUsd: number | null
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  contextSegments: AgentContextUsageSegment[] | null
  /** 上下文净变化（本回合采样 - 上回合采样，正=写入，负=剪裁/压缩）。 */
  memoryDelta: number | null
  tools: string[]
  compaction: boolean
  /** 本回合流式输出的可见文本（message.delta 拼接）；无输出为空串。 */
  outputText: string
  /** 本回合思考文本（reasoning.delta 拼接）；无思考为空串。 */
  reasoningText: string
  /** 本回合关联事件序号（下钻「原始事件」用）。 */
  eventSeqs: number[]
}

/** 甘特 / 拓扑的一行。 */
export interface GanttRow {
  id: string
  kind: StepKind
  roundIndex: number
  label: string
  /** 行右侧的次要信息（耗时、tool 名等）。 */
  detail: string
  startMs: number
  endMs: number
  severity: Severity
  status: StepStatus
  /** 工具行才有：所属工具调用 id（下钻用）。 */
  toolCallId: string | null
  /** 工具并发泳道；LLM 行为 0。 */
  lane: number
}

/** 时间构成：wall time 拆成互不重叠的四段。 */
export interface TimeBreakdown {
  wallMs: number
  /** 工具执行占用（按时间并集，并行只算一次）。 */
  toolMs: number
  /** LLM 生成占用（delta 片段并集）。 */
  llmMs: number
  /** 首字前等待（各流式回合 ttft 之和；非流式回合测不到，为 0 不代表没有延迟）。 */
  ttftMs: number
  /** 模型往返/排队估算（回合时长 − 回合内工具 − 回合内生成，逐回合累加）。 */
  modelWaitMs: number
  /** 兜底残差：工具/生成/往返都没覆盖到的墙钟时间（run 头尾、调度、审批等待等）。 */
  gapMs: number
}

/** RAG / 记忆检索召回。 */
export interface RetrievedChunk {
  id: string
  /** 来源标识（文档名 / room / 会话），解析不到时为「未知来源」。 */
  source: string
  /** 相似度；runtime 未透出时为 null（不要伪造成 0）。 */
  score: number | null
  preview: string
  chars: number
}

export interface RetrievalRecord {
  /** 对应工具调用 id（`tool:<toolCallId>`）。 */
  toolCallId: string
  roundIndex: number
  atMs: number
  toolName: string
  /** 检索关键词 / 查询串。 */
  query: string
  hitCount: number | null
  latencyMs: number
  chunks: RetrievedChunk[]
  /** 召回内容是否进入后续上下文（按下一回合输入 token 增量估算；无法判定为 null）。 */
  fedToContext: boolean | null
}

export interface ToolStat {
  name: string
  calls: number
  failures: number
  /** 失败率 0–1；无调用为 null。 */
  failureRate: number | null
  totalMs: number
  avgMs: number
  maxMs: number
  /** 占工具总耗时比例 0–1。 */
  timeShare: number | null
  errorClasses: Partial<Record<ToolErrorClass, number>>
}

export type AnomalyKind =
  | 'slow'
  | 'error'
  | 'loop'
  | 'retry'
  | 'context_pressure'
  | 'compaction'
  | 'no_progress'

export interface Anomaly {
  id: string
  kind: AnomalyKind
  severity: Severity
  /** 一句话结论（面板直接当标题用）。 */
  title: string
  /** 证据：具体数字与判据，如「耗时 12.4s（阈值 10s）」。 */
  detail: string
  atMs: number
  /** 可下钻的步骤 id（工具调用 id 或 llm 回合锚点）。 */
  stepId: string | null
}

export interface TraceTotals {
  usage: TokenUsage
  /** 累计用量口径是否完整（部分回合缺 runUsage 时为 false，UI 标注「片段口径」）。 */
  usageComplete: boolean
  costUsd: number | null
  toolCalls: number
  toolFailures: number
  slowSteps: number
  rounds: number
  /** 上下文峰值占用百分比。 */
  peakContextPercent: number | null
  peakContextTokens: number | null
  contextWindow: number | null
  /** 工具最大并发度。 */
  maxParallelTools: number
  retrievalCalls: number
  compactions: number
  reasoningChars: number
  outputChars: number
  /** 真正流式透出的回合数（有 TTFT 可测）。 */
  streamedRounds: number
  /** 一次性下发整段文本的回合数（TTFT 不可测）。 */
  singleShotRounds: number
}

export interface TraceInsight {
  run: AgentDebugRun
  /** 原始事件（按 seq 升序），下钻探针展示原始 payload 用。 */
  events: readonly AgentDebugEvent[]
  /** 以上时间戳都相对这个绝对时间（ms）。 */
  startWallMs: number
  endWallMs: number
  wallMs: number
  running: boolean
  rounds: LlmRound[]
  tools: ToolCall[]
  rows: GanttRow[]
  contextSeries: ContextSample[]
  compactions: CompactionRecord[]
  retrievals: RetrievalRecord[]
  breakdown: TimeBreakdown
  totals: TraceTotals
  toolStats: ToolStat[]
  anomalies: Anomaly[]
  /** LLM 生成片段总数（用于「本 run 有几段真生成」的说明）。 */
  generationSegments: number
}
