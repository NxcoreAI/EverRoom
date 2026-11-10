/**
 * Agent 调试台的事件折叠（纯函数，无 DOM / 无 Electron API）。
 *
 * 输入是 `AgentDebugEvent[]`（Gateway trace 缓冲里的事件，按 seq 升序），
 * 输出是可直接渲染的时间线模型：
 * - 相邻 `reasoning.delta` / `message.delta` 累计成块（服务端会把同类 delta 合并为
 *   一条 seq 不变的累计事件，所以这里每次从完整事件数组重算，天然幂等）；
 * - 工具调用按 `toolCallId` 合并 requested/started/updated/completed/failed 生命周期；
 * - `run.*` / `context.*` / `approval.*` 折叠为系统行；
 * - 从事件里提取最终输出与 `subagent_submit_result` 结构化结果。
 *
 * 增量轮询用 {@link mergeRunEvents} 按 seq upsert 合并，再交给
 * {@link reduceRunTimeline} 重算时间线。
 */
import type {
  AgentContextCompaction,
  AgentContextUsage,
  AgentContextUsageSegment,
  AgentDebugEvent,
} from '@nxcore/agent-contract'

export type DebugBlockKind = 'reasoning' | 'tool' | 'message' | 'system'

export type DebugToolStatus = 'pending' | 'running' | 'completed' | 'error'

export type DebugApprovalStatus = 'pending' | 'approved' | 'denied'

export type DebugSeverity = 'info' | 'success' | 'warning' | 'error'

export interface DebugToolBlock {
  kind: 'tool'
  key: string
  id: string
  name: string
  title: string | null
  args: unknown
  partialResult: unknown
  result: unknown
  error: string | null
  status: DebugToolStatus
  startedAt: string
  updatedAt: string
  completedAt: string | null
  /** 该工具卡关联的事件 seq（原始事件页签可跳转）。 */
  seqs: number[]
}

export interface DebugReasoningBlock {
  kind: 'reasoning'
  key: string
  at: string
  text: string
  /** 最后一条事件就是它的 delta（仍在流式追加）；UI 还需结合 run.status === 'running'。 */
  open: boolean
  seqs: number[]
}

export interface DebugMessageBlock {
  kind: 'message'
  key: string
  at: string
  text: string
  open: boolean
  completed: boolean
  seqs: number[]
}

export interface DebugApprovalInfo {
  approvalId: string
  status: DebugApprovalStatus
  toolName: string | null
  kind: string | null
  command: string | null
  cwd: string | null
  timeoutMs: number | null
}

export interface DebugSystemBlock {
  kind: 'system'
  key: string
  at: string
  /** 原始事件类型，例如 `run.started` / `context.usage` / `approval.requested`。 */
  type: string
  label: string
  detail: string | null
  severity: DebugSeverity
  usage: AgentContextUsage | null
  compaction: AgentContextCompaction | null
  approval: DebugApprovalInfo | null
  seqs: number[]
}

export type DebugTimelineBlock =
  | DebugReasoningBlock
  | DebugToolBlock
  | DebugMessageBlock
  | DebugSystemBlock

export interface DebugSubmitResult {
  value: unknown
  /** structured result 的提取来源，UI 上标注，便于对照真实 gateway 字段。 */
  source: 'result' | 'result.content' | 'args'
  args: unknown
  result: unknown
}

export interface DebugRunOutput {
  /** 最终 assistant 文本：优先最后一条 message.completed，其次已累积的消息文本。 */
  finalText: string
  /** 事件里出现过的所有 assistant 文本（流式中途也有内容）。 */
  streamingText: string
  messageCompleted: boolean
  submitResult: DebugSubmitResult | null
  errorMessage: string | null
}

export interface RunTimelineModel {
  blocks: DebugTimelineBlock[]
  output: DebugRunOutput
  /** 最近一次 context.usage 快照。 */
  contextUsage: AgentContextUsage | null
  /** 最近一次 context.compaction 信号。 */
  contextCompaction: AgentContextCompaction | null
  lastSeq: number
  eventCount: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(payload: unknown, field: string): string | null {
  if (!isPlainObject(payload)) return null
  const value = payload[field]
  return typeof value === 'string' ? value : null
}

function numberField(payload: unknown, field: string): number | null {
  if (!isPlainObject(payload)) return null
  const value = payload[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function errorText(payload: unknown): string | null {
  const message = stringField(payload, 'message')
  if (message) return message
  const error = stringField(payload, 'error')
  if (error) return error
  if (isPlainObject(payload) && typeof payload.result === 'string') return payload.result
  return null
}

function parseUsage(payload: unknown): AgentContextUsage | null {
  if (!isPlainObject(payload)) return null
  const contextWindow = numberField(payload, 'contextWindow')
  const tokens = numberField(payload, 'tokens')
  if (contextWindow === null && tokens === null) return null
  const percent = numberField(payload, 'percent')
  const segments: AgentContextUsageSegment[] | undefined = Array.isArray(payload.segments)
    ? payload.segments.flatMap((segment) => {
      if (!isPlainObject(segment)) return []
      const key = segment.key
      const segTokens = segment.tokens
      if (typeof key !== 'string' || typeof segTokens !== 'number') return []
      return [{ key: key as AgentContextUsageSegment['key'], tokens: segTokens }]
    })
    : undefined
  return {
    tokens,
    contextWindow: contextWindow ?? 0,
    percent,
    ...(segments && segments.length ? { segments } : {}),
  }
}

function parseCompaction(payload: unknown): AgentContextCompaction | null {
  if (!isPlainObject(payload)) return null
  if (typeof payload.active !== 'boolean') return null
  const reason = payload.reason
  const allowed = reason === 'manual' || reason === 'threshold' || reason === 'overflow'
  return {
    active: payload.active,
    reason: allowed ? reason : 'threshold',
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  }
}

function parseApproval(payload: unknown, status: DebugApprovalStatus): DebugApprovalInfo | null {
  const approvalId = stringField(payload, 'approvalId')
  if (!approvalId) return null
  return {
    approvalId,
    status,
    toolName: stringField(payload, 'toolName'),
    kind: stringField(payload, 'kind'),
    command: stringField(payload, 'command'),
    cwd: stringField(payload, 'cwd'),
    timeoutMs: numberField(payload, 'timeoutMs'),
  }
}

function toolStatusOf(type: string): DebugToolStatus | null {
  if (type === 'tool.requested') return 'pending'
  if (type === 'tool.started' || type === 'tool.updated') return 'running'
  if (type === 'tool.completed') return 'completed'
  if (type === 'tool.failed') return 'error'
  return null
}

const RUN_LABELS: Record<string, string> = {
  'run.accepted': 'Run 已接收',
  'run.started': 'Run 开始',
  'run.completed': 'Run 完成',
  'run.failed': 'Run 失败',
  'run.cancelled': 'Run 已取消',
  'run.interrupted': 'Run 中断',
  'session.created': '会话创建',
  'message.started': '消息开始',
  'context.updated': '上下文更新',
  'runtime.session.updated': '运行时会话更新',
  'session.permission_mode.updated': '权限模式更新',
}

function severityOf(type: string): DebugSeverity {
  if (type === 'run.completed') return 'success'
  if (type === 'run.failed') return 'error'
  if (type === 'run.cancelled' || type === 'run.interrupted') return 'warning'
  return 'info'
}

function systemDetail(type: string, payload: unknown): string | null {
  if (type === 'run.failed' || type === 'run.cancelled' || type === 'run.interrupted') {
    return errorText(payload)
  }
  if (type === 'session.permission_mode.updated') return stringField(payload, 'mode')
  if (type === 'runtime.session.updated') return stringField(payload, 'runtimeSessionRef')
  return null
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** 提交工具返回的 ack 包壳：`{content, details:{accepted}}` 或 `{accepted, ...}`。 */
function isSubmitEnvelope(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  const envelopeKeys = new Set(['content', 'details', 'accepted', 'invocationId', 'note', 'ok', 'success'])
  return keys.every((key) => envelopeKeys.has(key))
}

function isAckOnly(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  const ackKeys = new Set(['accepted', 'invocationId', 'note', 'ok', 'success'])
  return keys.length > 0 && keys.every((key) => ackKeys.has(key))
}

/**
 * 从 `subagent_submit_result` 工具调用里容错提取结构化结果。
 * 真实 Gateway 上 result 可能是 `{ content: '<JSON ack>', details: { accepted } }`，
 * 结构化结果本身在 tool.started 的 args 里；也有实现直接把结构化对象塞进 result。
 * 这里两种都尝试，并标注来源供联调对照。
 */
export function extractSubmitResult(tool: DebugToolBlock): DebugSubmitResult | null {
  const result = tool.result
  const args = isPlainObject(tool.args) && Object.keys(tool.args).length > 0 ? tool.args : null
  let value: unknown = null
  let source: DebugSubmitResult['source'] | null = null

  if (isPlainObject(result)) {
    const content = result.content
    if (typeof content === 'string') {
      const parsed = tryParseJson(content)
      if (isPlainObject(parsed) && !isAckOnly(parsed)) {
        value = parsed
        source = 'result.content'
      }
    }
    if (value === null && !isSubmitEnvelope(result)) {
      value = result
      source = 'result'
    }
    if (value === null && args) {
      value = args
      source = 'args'
    }
    if (value === null) {
      value = result
      source = 'result'
    }
  } else if (typeof result === 'string') {
    value = tryParseJson(result) ?? result
    source = 'result'
  } else if (args) {
    value = args
    source = 'args'
  }

  if (value === null) return null
  return { value, source: source ?? 'result', args: tool.args ?? null, result: result ?? null }
}

function messageText(event: AgentDebugEvent): string {
  if (!isPlainObject(event.payload)) return ''
  const delta = event.payload.delta
  return typeof delta === 'string' ? delta : ''
}

function reasoningDelta(event: AgentDebugEvent): string {
  return messageText(event)
}

/**
 * 按 seq upsert 合并增量事件（Gateway 增量响应里同 seq 的累计 delta 事件会被重复带回）：
 * - 同 seq：新事件覆盖旧事件（payload 是更长的累计文本）；
 * - 新 seq：插入；
 * - 结果始终按 seq 升序。
 */
export function mergeRunEvents(
  existing: readonly AgentDebugEvent[],
  incoming: readonly AgentDebugEvent[],
): AgentDebugEvent[] {
  if (incoming.length === 0) return existing as AgentDebugEvent[]
  const bySeq = new Map<number, AgentDebugEvent>()
  for (const event of existing) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

export function createEmptyRunTimeline(): RunTimelineModel {
  return {
    blocks: [],
    output: {
      finalText: '',
      streamingText: '',
      messageCompleted: false,
      submitResult: null,
      errorMessage: null,
    },
    contextUsage: null,
    contextCompaction: null,
    lastSeq: 0,
    eventCount: 0,
  }
}

/**
 * 把事件数组折叠成时间线。无状态、幂等：同样的输入永远得到同样的输出，
 * 所以增量轮询时直接对完整事件数组重算即可。
 */
export function reduceRunTimeline(events: readonly AgentDebugEvent[]): RunTimelineModel {
  if (events.length === 0) return createEmptyRunTimeline()
  // 防御性 upsert：即使调用方把重复 seq（服务端累计 delta 重放）直接传入，
  // 这里也先按 seq 归一，避免同一条 delta 被折叠两次。
  const ordered = mergeRunEvents([], events)

  const blocks: DebugTimelineBlock[] = []
  const toolIndex = new Map<string, number>()
  const approvalIndex = new Map<string, number>()
  let lastSeq = 0
  let contextUsage: AgentContextUsage | null = null
  let contextCompaction: AgentContextCompaction | null = null
  let finalText = ''
  let runError: string | null = null
  let submitTool: DebugToolBlock | null = null

  /**
   * 当前「可继续累积」的 delta 块下标。只有最近一条事件是 reasoning/message delta
   * 时非 null；插入任何其他事件都必须先把它闭合（工具卡、系统行都可能夹在中间）。
   */
  let openDeltaIndex: number | null = null
  const closeOpenDelta = (): void => {
    if (openDeltaIndex === null) return
    const block = blocks[openDeltaIndex]
    if (block && (block.kind === 'reasoning' || block.kind === 'message') && block.open) {
      blocks[openDeltaIndex] = { ...block, open: false }
    }
    openDeltaIndex = null
  }

  const pushSystem = (
    event: AgentDebugEvent,
    label: string,
    extra: {
      severity?: DebugSeverity
      detail?: string | null
      usage?: AgentContextUsage | null
      compaction?: AgentContextCompaction | null
      approval?: DebugApprovalInfo | null
      key?: string
    } = {},
  ): DebugSystemBlock => {
    closeOpenDelta()
    const block: DebugSystemBlock = {
      kind: 'system',
      key: extra.key ?? `system-${event.seq}`,
      at: event.occurredAt,
      type: event.type,
      label,
      detail: extra.detail ?? null,
      severity: extra.severity ?? severityOf(event.type),
      usage: extra.usage ?? null,
      compaction: extra.compaction ?? null,
      approval: extra.approval ?? null,
      seqs: [event.seq],
    }
    blocks.push(block)
    return block
  }

  for (const event of ordered) {
    lastSeq = Math.max(lastSeq, event.seq)
    const type = event.type
    const payload = event.payload

    if (type === 'reasoning.delta') {
      const delta = reasoningDelta(event)
      if (!delta) continue
      const open = openDeltaIndex === null ? null : blocks[openDeltaIndex]
      if (open && open.kind === 'reasoning' && open.open) {
        blocks[openDeltaIndex as number] = {
          ...open,
          text: open.text + delta,
          seqs: [...open.seqs, event.seq],
        }
      } else {
        closeOpenDelta()
        blocks.push({
          kind: 'reasoning',
          key: `reasoning-${event.seq}`,
          at: event.occurredAt,
          text: delta,
          open: true,
          seqs: [event.seq],
        })
        openDeltaIndex = blocks.length - 1
      }
      continue
    }

    if (type === 'message.delta') {
      const delta = messageText(event)
      if (!delta) continue
      const open = openDeltaIndex === null ? null : blocks[openDeltaIndex]
      if (open && open.kind === 'message' && open.open) {
        blocks[openDeltaIndex as number] = {
          ...open,
          text: open.text + delta,
          seqs: [...open.seqs, event.seq],
        }
      } else {
        closeOpenDelta()
        blocks.push({
          kind: 'message',
          key: `message-${event.seq}`,
          at: event.occurredAt,
          text: delta,
          open: true,
          completed: false,
          seqs: [event.seq],
        })
        openDeltaIndex = blocks.length - 1
      }
      continue
    }

    if (type === 'message.completed') {
      const content = stringField(payload, 'content') ?? ''
      const open = openDeltaIndex === null ? null : blocks[openDeltaIndex]
      if (open && open.kind === 'message' && open.open) {
        blocks[openDeltaIndex as number] = {
          ...open,
          text: content || open.text,
          open: false,
          completed: true,
          seqs: [...open.seqs, event.seq],
        }
        openDeltaIndex = null
      } else {
        closeOpenDelta()
        blocks.push({
          kind: 'message',
          key: `message-${event.seq}`,
          at: event.occurredAt,
          text: content,
          open: false,
          completed: true,
          seqs: [event.seq],
        })
      }
      if (content) finalText = content
      continue
    }

    const toolStatus = toolStatusOf(type)
    if (toolStatus !== null) {
      const toolCallId = stringField(payload, 'toolCallId')
      const id = toolCallId ?? `anon-${event.seq}`
      const existingIndex = toolCallId ? toolIndex.get(toolCallId) : undefined
      const existing = existingIndex === undefined ? null : blocks[existingIndex] as DebugToolBlock
      // 终态工具卡忽略迟到的非终态更新（不同 runtime 的事件顺序并不完全可靠）。
      if (existing && (existing.status === 'completed' || existing.status === 'error') && toolStatus !== 'completed' && toolStatus !== 'error') {
        continue
      }
      const payloadArgs = isPlainObject(payload) && isPlainObject(payload.args) ? payload.args : null
      const name = stringField(payload, 'name') ?? existing?.name ?? 'tool'
      const next: DebugToolBlock = {
        kind: 'tool',
        key: `tool-${id}`,
        id,
        name,
        title: stringField(payload, 'title') ?? existing?.title ?? null,
        args: payloadArgs ?? existing?.args ?? {},
        partialResult: isPlainObject(payload) && payload.partialResult !== undefined
          ? payload.partialResult
          : existing?.partialResult,
        result: isPlainObject(payload) && payload.result !== undefined
          ? payload.result
          : existing?.result,
        error: toolStatus === 'error' ? errorText(payload) ?? '工具调用失败' : existing?.error ?? null,
        status: toolStatus,
        startedAt: existing?.startedAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        completedAt: toolStatus === 'completed' || toolStatus === 'error' ? event.occurredAt : null,
        seqs: [...(existing?.seqs ?? []), event.seq],
      }
      closeOpenDelta()
      if (existingIndex === undefined) {
        toolIndex.set(id, blocks.length)
        blocks.push(next)
      } else {
        blocks[existingIndex] = next
      }
      if (next.name === 'subagent_submit_result' && next.status === 'completed') submitTool = next
      continue
    }

    if (type === 'context.usage') {
      const usage = parseUsage(payload)
      if (!usage) continue
      contextUsage = usage
      pushSystem(event, '上下文用量', { usage })
      continue
    }

    if (type === 'context.compaction') {
      const compaction = parseCompaction(payload)
      if (!compaction) continue
      contextCompaction = compaction
      pushSystem(event, compaction.active ? '上下文压缩中' : '上下文压缩结束', {
        compaction,
        severity: compaction.error ? 'error' : compaction.active ? 'warning' : 'info',
        detail: compaction.error ?? null,
      })
      continue
    }

    if (type === 'approval.requested') {
      const approval = parseApproval(payload, 'pending')
      if (!approval) continue
      const existingIndex = approvalIndex.get(approval.approvalId)
      if (existingIndex !== undefined) {
        const block = blocks[existingIndex] as DebugSystemBlock
        blocks[existingIndex] = {
          ...block,
          at: event.occurredAt,
          approval: { ...block.approval, ...approval },
          seqs: [...block.seqs, event.seq],
        }
        continue
      }
      const block = pushSystem(event, '等待审批', {
        approval,
        severity: 'warning',
        detail: approval.command,
        key: `approval-${approval.approvalId}`,
      })
      approvalIndex.set(approval.approvalId, blocks.indexOf(block))
      continue
    }

    if (type === 'approval.resolved') {
      const approvalId = stringField(payload, 'approvalId')
      const approved = isPlainObject(payload) && payload.approved === true
      const status: DebugApprovalStatus = approved ? 'approved' : 'denied'
      const existingIndex = approvalId ? approvalIndex.get(approvalId) : undefined
      if (existingIndex !== undefined) {
        const block = blocks[existingIndex] as DebugSystemBlock
        blocks[existingIndex] = {
          ...block,
          at: event.occurredAt,
          label: approved ? '审批通过' : '审批拒绝',
          severity: approved ? 'success' : 'error',
          approval: block.approval ? { ...block.approval, status } : null,
          seqs: [...block.seqs, event.seq],
        }
      } else {
        const approval = parseApproval(payload, status)
        pushSystem(event, approved ? '审批通过' : '审批拒绝', {
          approval,
          severity: approved ? 'success' : 'error',
          key: approval ? `approval-${approval.approvalId}` : undefined,
        })
      }
      continue
    }

    if (type === 'run.failed') runError = errorText(payload) ?? 'Run 失败'

    const label = RUN_LABELS[type] ?? type
    pushSystem(event, label, { detail: systemDetail(type, payload) })
  }

  const messageBlocks = blocks.filter((block): block is DebugMessageBlock => block.kind === 'message')
  const streamingText = messageBlocks.map((block) => block.text).join('')
  const lastCompleted = [...messageBlocks].reverse().find((block) => block.completed)

  const output: DebugRunOutput = {
    finalText: finalText || lastCompleted?.text || '',
    streamingText,
    messageCompleted: Boolean(lastCompleted),
    submitResult: submitTool ? extractSubmitResult(submitTool) : null,
    errorMessage: runError,
  }

  return {
    blocks,
    output,
    contextUsage,
    contextCompaction,
    lastSeq,
    eventCount: ordered.length,
  }
}

/** 时间线过滤（顶栏「思考/工具/消息/系统」开关）。 */
export interface DebugFilters {
  reasoning: boolean
  tool: boolean
  message: boolean
  system: boolean
}

export function blockKindVisible(kind: DebugBlockKind, filters: DebugFilters): boolean {
  return filters[kind]
}

/** 原始事件页签用的分类（与顶栏过滤一致）。 */
export function eventCategory(type: string): DebugBlockKind {
  if (type === 'reasoning.delta') return 'reasoning'
  if (type === 'message.delta' || type === 'message.started' || type === 'message.completed') return 'message'
  if (type.startsWith('tool.')) return 'tool'
  return 'system'
}
