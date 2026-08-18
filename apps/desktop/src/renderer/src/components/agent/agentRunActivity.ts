import type { AgentEvent } from '@nxcore/agent-contract'

export type DisplayAgentToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'stopped'

export interface DisplayAgentToolCall {
  id: string
  runId: string
  name: string
  args: Record<string, unknown>
  partialResult?: unknown
  result?: unknown
  error?: string
  status: DisplayAgentToolStatus
  startedAt: string
  completedAt?: string
}

export interface AgentActivityStep {
  id: string
  sequence: number
  tool: DisplayAgentToolCall
  beforeText: string
  afterText: string
}

export interface AgentRunActivity {
  steps: AgentActivityStep[]
  pendingAnswer: string
  finalAnswer: string
  hasTools: boolean
  completed: boolean
}

export interface ReducedAgentRunEvents {
  tools: DisplayAgentToolCall[]
  reasoning: string
  startedAt?: string
  completedAt?: string
  streamingContent: string
  messageStarted: boolean
  messageCompleted: boolean
  lastSequence: number
}

const terminalToolStatuses = new Set<DisplayAgentToolStatus>(['completed', 'error', 'stopped'])

export function mergeAgentToolEvent(
  tools: DisplayAgentToolCall[],
  event: AgentEvent,
): DisplayAgentToolCall[] {
  const payload = event.payload as {
    toolCallId?: unknown
    name?: unknown
    args?: unknown
    partialResult?: unknown
    result?: unknown
    message?: unknown
  }
  if (typeof payload.toolCallId !== 'string') return tools

  const existing = tools.find((tool) => tool.id === payload.toolCallId)
  if (existing && terminalToolStatuses.has(existing.status)) return tools

  const status: DisplayAgentToolStatus = event.type === 'tool.completed'
    ? 'completed'
    : event.type === 'tool.failed'
      ? 'error'
      : event.type === 'tool.requested'
        ? 'pending'
        : 'running'
  const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
    ? payload.args as Record<string, unknown>
    : existing?.args ?? {}
  const failureMessage = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.result === 'string' ? payload.result : '工具调用失败。'
  const next: DisplayAgentToolCall = {
    id: payload.toolCallId,
    runId: event.runId,
    name: typeof payload.name === 'string' ? payload.name : existing?.name ?? 'tool',
    args,
    partialResult: payload.partialResult !== undefined ? payload.partialResult : existing?.partialResult,
    result: payload.result !== undefined ? payload.result : existing?.result,
    error: event.type === 'tool.failed' ? failureMessage : existing?.error,
    status,
    startedAt: existing?.startedAt ?? event.occurredAt,
    completedAt: terminalToolStatuses.has(status) ? event.occurredAt : existing?.completedAt,
  }

  return existing
    ? tools.map((tool) => tool.id === next.id ? next : tool)
    : [...tools, next]
}

function isToolEvent(event: AgentEvent): boolean {
  return event.type === 'tool.requested'
    || event.type === 'tool.started'
    || event.type === 'tool.updated'
    || event.type === 'tool.completed'
    || event.type === 'tool.failed'
}

function userText(value: unknown, limit = 600): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, limit)
}

export function agentToolLabel(tool: DisplayAgentToolCall, completed = tool.status === 'completed'): string {
  const name = tool.name.toLowerCase()
  const labels: Record<string, [string, string]> = {
    context_room_document_intent: ['准备创建选项', '已准备创建选项'],
    context_room_document_list: ['获取文档列表', '已获取文档列表'],
    context_room_document_read: ['读取文档', '已读取文档'],
    context_room_list: ['获取 Room 列表', '已获取 Room 列表'],
    context_room_patch_begin: ['准备文档修改', '已准备文档修改'],
    context_room_patch_commit: ['提交文档修改', '已提交文档修改'],
    context_room_patch_hunk: ['生成文档修改', '已生成文档修改'],
    context_room_write_append: ['写入文档内容', '已写入文档内容'],
    context_room_write_begin: ['开始创建文档', '已开始创建文档'],
    context_room_write_commit: ['提交新文档', '已提交新文档'],
    tool_search: ['选择所需工具', '已选择所需工具'],
  }
  const exact = labels[name]
  if (exact) return exact[completed ? 1 : 0]
  if (/photo|image/.test(name)) return completed ? '已查看图像' : '查看图像'
  if (/calendar/.test(name)) {
    if (/create|add/.test(name)) return completed ? '已创建日程' : '创建日程'
    return completed ? '已查询日历' : '查询日历'
  }
  if (/scheduler/.test(name)) return completed ? '已处理定时任务' : '处理定时任务'
  if (/memory/.test(name)) return completed ? '已查询个人记忆' : '查询个人记忆'
  if (/email|mail/.test(name)) {
    if (/sync/.test(name)) return completed ? '已同步邮件' : '同步邮件'
    return completed ? '已查询邮件' : '查询邮件'
  }
  if (/meeting/.test(name)) return completed ? '已查询会议' : '查询会议'
  if (/diary/.test(name)) return completed ? '已查询日记' : '查询日记'
  if (/search|web/.test(name)) return completed ? '已搜索网页' : '搜索网页'
  if (/read/.test(name)) return completed ? '已读取文件' : '读取文件'
  if (/write|edit|patch/.test(name)) return completed ? '已修改文件' : '修改文件'
  if (/bash|command|terminal|shell/.test(name)) return completed ? '已运行命令' : '运行命令'
  const fallback = tool.name.replace(/[_-]+/g, ' ').trim()
  return fallback ? `${completed ? '已执行' : '执行'} ${fallback}` : completed ? '已调用工具' : '调用工具'
}

export function agentToolSubject(tool: DisplayAgentToolCall): string | undefined {
  for (const key of [
    'command', 'cmd', 'script', 'code', 'input',
    'query', 'search_query', 'keyword', 'prompt', 'path', 'filePath', 'title', 'documentTitle', 'url',
  ]) {
    const value = userText(tool.args[key], 80)
    if (value) return value
  }
  return undefined
}

export function agentToolCommand(tool: DisplayAgentToolCall): string | undefined {
  if (!/bash|command|terminal|shell/.test(tool.name.toLowerCase())) return undefined
  for (const key of ['command', 'cmd', 'script', 'code', 'input']) {
    const value = userText(tool.args[key], 12_000)
    if (value) return value
  }
  return undefined
}

export function agentToolResultSummary(result: unknown): string | undefined {
  if (!result) return undefined
  if (typeof result === 'string') {
    try {
      return agentToolResultSummary(JSON.parse(result))
    } catch {
      return result.trim().slice(0, 120) || undefined
    }
  }
  if (typeof result !== 'object' || Array.isArray(result)) return undefined
  const record = result as Record<string, unknown>
  for (const key of ['results', 'items', 'messages', 'events', 'photos']) {
    if (Array.isArray(record[key])) return `获得 ${record[key].length} 条结果`
  }
  for (const key of ['summary', 'message', 'title', 'documentTitle']) {
    const value = userText(record[key], 120)
    if (value) return value
  }
  for (const key of ['navigation', 'document', 'patch']) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    const value = agentToolResultSummary(nested)
    if (value) return value
  }
  return undefined
}

function punctuate(text: string): string {
  return /[。！？]$/.test(text) ? text : `${text}。`
}

function comparableText(text: string): string {
  return text.toLowerCase().replace(/[\s，。；：！？、,.!?;:「」『』“”\"'（）()]/g, '')
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return resultRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function committedDocumentTitle(tool: DisplayAgentToolCall): string | null {
  if (tool.name !== 'context_room_write_commit' || tool.status !== 'completed') return null
  const root = resultRecord(tool.result)
  const details = resultRecord(root?.details)
  const structured = resultRecord(root?.structuredContent)
  const navigation = resultRecord(details?.navigation)
    ?? resultRecord(structured?.navigation)
    ?? resultRecord(root?.navigation)
  const title = typeof navigation?.title === 'string' ? navigation.title.trim() : ''
  return title || null
}

function normalizeDocumentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/[#>*_~`\-[\](){}]/g, '')
    .replace(/[\s，。；：！？、,.!?;:「」『』“”\"'（）()]/g, '')
}

function documentSummaryFallback(answer: string, tools: DisplayAgentToolCall[]): string {
  const commit = [...tools].reverse().find((tool) => committedDocumentTitle(tool))
  if (!commit) return answer
  const title = committedDocumentTitle(commit)
  if (!title) return answer
  const documentText = normalizeDocumentText(tools
    .filter((tool) => tool.name === 'context_room_write_append' && tool.status === 'completed')
    .map((tool) => typeof tool.args.text === 'string' ? tool.args.text : '')
    .join('\n'))
  const normalizedAnswer = normalizeDocumentText(answer)
  if (normalizedAnswer.length < 320 || documentText.length < 320) return answer

  const chunks = Array.from(
    { length: Math.floor(normalizedAnswer.length / 40) },
    (_, index) => normalizedAnswer.slice(index * 40, index * 40 + 40),
  )
  const copied = chunks.filter((chunk) => documentText.includes(chunk)).length
  if (!chunks.length || copied / chunks.length < 0.6) return answer
  return `文档《${title}》已创建完成，内容已写入对应工作区。你可以在文档中继续查看或编辑。`
}

function filterActivityText(
  text: string,
  tool: DisplayAgentToolCall,
  nextTool?: DisplayAgentToolCall,
): string {
  const subject = agentToolSubject(tool)
  const labels = [agentToolLabel(tool, false), agentToolLabel(tool, true)]
  const repeated = new Set(labels.flatMap((label) => [
    label,
    `正在${label}`,
    ...(subject ? [`${label}${subject}`, `正在${label}${subject}`] : []),
  ]).map(comparableText))

  if (nextTool) {
    const nextLabel = agentToolLabel(nextTool, false)
    for (const prefix of ['', '接下来', '下一步', '然后']) repeated.add(comparableText(`${prefix}${nextLabel}`))
  }

  return (text.match(/[^。！？!?]+[。！？!?]?/g) ?? [text])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !repeated.has(comparableText(sentence)))
    .join('')
}

export function agentToolStageText(
  tool: DisplayAgentToolCall,
): string {
  if (tool.status === 'pending' || tool.status === 'running') {
    return ''
  }
  if (tool.status === 'error') {
    return punctuate(tool.error?.slice(0, 120) || '工具调用失败')
  }
  if (tool.status === 'stopped') return '操作已停止。'

  const result = agentToolResultSummary(tool.result ?? tool.partialResult)
  if (!result) return ''
  const comparableResult = comparableText(result)
  const subject = agentToolSubject(tool)
  if (
    comparableResult === comparableText(subject ?? '')
    || comparableResult === comparableText(agentToolLabel(tool, false))
    || comparableResult === comparableText(agentToolLabel(tool, true))
    || /^(已)?(操作)?(完成|成功)$/.test(comparableResult)
  ) return ''
  return punctuate(result)
}

export function reduceAgentRunActivity(
  events: AgentEvent[],
  savedAnswer = '',
): AgentRunActivity {
  const steps: AgentActivityStep[] = []
  let tools: DisplayAgentToolCall[] = []
  let pendingText = ''
  let completedContent = ''
  let completed = false

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (isToolEvent(event)) {
      const nextTools = mergeAgentToolEvent(tools, event)
      const payload = event.payload as { toolCallId?: unknown }
      if (typeof payload.toolCallId !== 'string') continue
      const tool = nextTools.find((candidate) => candidate.id === payload.toolCallId)
      if (!tool) continue
      const index = steps.findIndex((step) => step.id === tool.id)
      if (index === -1) {
        const text = pendingText.trim()
        if (text && steps.length) {
          const previous = steps[steps.length - 1]!
          previous.afterText = filterActivityText(text, previous.tool, tool)
        }
        steps.push({
          id: tool.id,
          sequence: event.seq,
          tool,
          beforeText: text && !steps.length ? filterActivityText(text, tool) : '',
          afterText: '',
        })
        pendingText = ''
      } else {
        steps[index] = { ...steps[index]!, tool }
      }
      tools = nextTools
      continue
    }

    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta !== 'string' || !delta) continue
      pendingText += delta
      continue
    }

    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      if (typeof content === 'string') completedContent = content
    }
    if (
      event.type === 'run.failed'
      || event.type === 'run.cancelled'
      || event.type === 'run.interrupted'
    ) {
      const status: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
      tools = tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
        ? { ...tool, status, completedAt: event.occurredAt }
        : tool)
      for (let index = 0; index < steps.length; index += 1) {
        const tool = tools.find((candidate) => candidate.id === steps[index]!.id)
        if (tool) steps[index] = { ...steps[index]!, tool }
      }
    }
    if (event.type === 'run.completed') completed = true
  }

  const hasTools = steps.length > 0
  if (!hasTools) {
    return {
      steps,
      pendingAnswer: '',
      finalAnswer: (completedContent || savedAnswer).trim(),
      hasTools,
      completed,
    }
  }

  const pendingAnswer = completed ? '' : (pendingText || completedContent || savedAnswer).trim()
  const finalAnswer = completed
    ? documentSummaryFallback((pendingText || completedContent || savedAnswer).trim(), tools)
    : ''

  return {
    steps,
    pendingAnswer,
    finalAnswer,
    hasTools,
    completed,
  }
}

export function reduceAgentRunEvents(events: AgentEvent[]): ReducedAgentRunEvents {
  const reduced: ReducedAgentRunEvents = {
    tools: [],
    reasoning: '',
    streamingContent: '',
    messageStarted: false,
    messageCompleted: false,
    lastSequence: 0,
  }
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    reduced.lastSequence = Math.max(reduced.lastSequence, event.seq)
    if (event.type === 'run.accepted' && !reduced.startedAt) reduced.startedAt = event.occurredAt
    if (event.type === 'run.started') reduced.startedAt = event.occurredAt
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      reduced.completedAt = event.occurredAt
      if (event.type !== 'run.completed') {
        const terminalStatus: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
        reduced.tools = reduced.tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
          ? { ...tool, status: terminalStatus, completedAt: event.occurredAt }
          : tool)
      }
    }
    if (isToolEvent(event)) reduced.tools = mergeAgentToolEvent(reduced.tools, event)
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') reduced.reasoning += delta
    }
    if (event.type === 'message.started') reduced.messageStarted = true
    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') reduced.streamingContent += delta
    }
    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      if (typeof content === 'string') reduced.streamingContent = content
      reduced.messageCompleted = true
    }
  }
  return reduced
}
