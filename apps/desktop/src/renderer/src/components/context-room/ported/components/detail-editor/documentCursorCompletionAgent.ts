import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSocketFrame,
  CreateAgentSessionInput,
  StartAgentRunInput,
} from '@nxcore/agent-contract'
import i18n from '@/i18n/i18next'

export interface DocumentCursorCompletionAgentApi {
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>
  deleteSession(sessionId: string): Promise<void>
  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
  startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
  cancelRun(runId: string): Promise<AgentRun>
  /** 可选推送通道：存在时流式循环以事件唤醒替代盲轮询。 */
  subscribe?(sessionId: string): Promise<void>
  unsubscribe?(): Promise<void>
  onEvent?(listener: (frame: AgentSocketFrame) => void): () => void
}

export type DocumentCursorCompletionListType = 'bulletList' | 'orderedList' | 'taskList'

export interface DocumentCursorCompletionFormatContext {
  ancestorTypes: string[]
  activeMarks: string[]
  codeLanguage?: string | null
  codeLinePrefix?: string
  headingLevel?: number
  list?: {
    type: DocumentCursorCompletionListType
    depth: number
    itemType: 'listItem' | 'taskItem'
    checked?: boolean
    orderedStart?: number
  }
}

export interface DocumentCursorCompletionNearbyBlock {
  relation: 'previous' | 'current' | 'next'
  type: string
  text: string
  ancestorTypes: string[]
  attrs: Record<string, string | number | boolean | null>
}

/** 补全档位：inline = 单句短补全；paragraph = 块内 2-4 句续写。 */
export type DocumentCursorCompletionMode = 'inline' | 'paragraph'

export interface DocumentCursorCompletionRequest {
  roomId: string
  roomTitle?: string
  documentName: string
  contextBefore: string
  contextAfter: string
  blockPrefix: string
  blockSuffix?: string
  blockType: string
  formatContext: DocumentCursorCompletionFormatContext
  nearbyBlocks?: DocumentCursorCompletionNearbyBlock[]
  /** 缺省 inline；只进 <EDITOR_CONTEXT> 数据，不进指令文本（保前缀缓存字节稳定）。 */
  completionMode?: DocumentCursorCompletionMode
  /** regenerate 场景带上被用户拒绝的上一次建议，模型据此避开重复。 */
  avoidText?: string
  /**
   * 写作风格注入块（§7.4 合成产物，含 <writing_style> 标签）。
   * 动态段的一部分：固定指令段不受影响，前缀缓存命中不受干扰。
   * 调用方自查补全开关——关闭时完全不传（不构造标签）。
   */
  writingStyleBlock?: string
}

export interface DocumentCursorCompletionSuggestion {
  text: string
  replaceCharacters: number
}

export type DocumentCursorCompletionErrorKind =
  | 'aborted'
  | 'first_suggestion_timeout'
  | 'timeout'
  | 'session_busy'
  | 'session_not_found'
  | 'unconfigured'
  | 'network'
  | 'provider'
  | 'no_completion'
  | 'unknown'

export class DocumentCursorCompletionError extends Error {
  constructor(
    readonly kind: DocumentCursorCompletionErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'DocumentCursorCompletionError'
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'name' in error && error.name === 'AbortError'
}

/** 熔断/重试决策依赖的错误分类：只有 session_not_found 可安全重试。 */
export function classifyDocumentCursorCompletionError(error: unknown): DocumentCursorCompletionErrorKind {
  if (error instanceof DocumentCursorCompletionError) return error.kind
  if (isAbortError(error)) return 'aborted'
  const message = error instanceof Error ? error.message : String(error)
  if (/agent_session_not_found|session not found/i.test(message)) return 'session_not_found'
  // 网关 409 session_busy：上一个被 supersede 的 run 尚未落库 run.cancelled，
  // session.status 仍是 running。桥层只透传网关 message（无状态码），按文案识别。
  if (/agent_session_busy|session_busy|already has an active run/i.test(message)) return 'session_busy'
  if (/runtime_config_not_ready/i.test(message)) return 'unconfigured'
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket hang up/i.test(message)) {
    return 'network'
  }
  if (/HTTP 4\d\d|HTTP 5\d\d|status (code )?4\d\d|status (code )?5\d\d|请求失败（[45]\d\d|rate.?limit/i.test(message)) {
    return 'provider'
  }
  return 'unknown'
}

/**
 * 补全熔断：连续失败（abort/session 失联除外）后指数退避，打开期间
 * 直接跳过请求而不是每个击键窗口都全链路白跑。进程级单例——补全服务
 * 是单例子进程，多个编辑器共享同一份退避状态。
 */
export class DocumentCursorCompletionCircuitBreaker {
  private consecutiveFailures = 0
  private openUntilMs = 0
  private lastCooldownMs = 0

  constructor(
    private readonly failureThreshold = 3,
    private readonly baseCooldownMs = 5_000,
    private readonly maxCooldownMs = 60_000,
  ) {}

  shouldAttempt(nowMs = Date.now()): boolean {
    return nowMs >= this.openUntilMs
  }

  cooldownRemainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.openUntilMs - nowMs)
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.lastCooldownMs = 0
    this.openUntilMs = 0
  }

  recordFailure(nowMs = Date.now()): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures < this.failureThreshold) return
    const nextCooldown = this.lastCooldownMs
      ? Math.min(this.lastCooldownMs * 2, this.maxCooldownMs)
      : this.baseCooldownMs
    this.lastCooldownMs = nextCooldown
    this.openUntilMs = nowMs + nextCooldown
  }
}

export const documentCursorCompletionCircuitBreaker = new DocumentCursorCompletionCircuitBreaker()

function levenshteinDistance(left: string, right: string): number {
  const leftCharacters = Array.from(left)
  const rightCharacters = Array.from(right)
  let previous = rightCharacters.map((_, index) => index + 1)
  previous.unshift(0)

  for (let leftIndex = 0; leftIndex < leftCharacters.length; leftIndex += 1) {
    const current = [leftIndex + 1]
    for (let rightIndex = 0; rightIndex < rightCharacters.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (leftCharacters[leftIndex] === rightCharacters[rightIndex] ? 0 : 1),
      ))
    }
    previous = current
  }
  return previous[rightCharacters.length]
}

function isSingleAdjacentTransposition(left: string, right: string): boolean {
  const leftCharacters = Array.from(left)
  const rightCharacters = Array.from(right)
  if (leftCharacters.length !== rightCharacters.length) return false
  const mismatches = leftCharacters
    .map((character, index) => character === rightCharacters[index] ? -1 : index)
    .filter((index) => index >= 0)
  if (mismatches.length !== 2 || mismatches[1] !== mismatches[0] + 1) return false
  const [first, second] = mismatches
  return leftCharacters[first] === rightCharacters[second]
    && leftCharacters[second] === rightCharacters[first]
}

function leadingAsciiToken(value: string): string {
  return value.match(/^[A-Za-z_$][A-Za-z0-9_$'-]*/u)?.[0] ?? ''
}

function trailingAsciiToken(value: string): string {
  return value.match(/[A-Za-z_$][A-Za-z0-9_$'-]*$/u)?.[0] ?? ''
}

/**
 * Treat the model's replacement length as a correction request, never as an
 * authoritative deletion range. Only a locally verifiable adjacent token can
 * be replaced.
 */
export function validatedDocumentCursorReplacement(
  blockPrefix: string,
  suggestionText: string,
  requestedReplaceCharacters: number,
): number {
  if (requestedReplaceCharacters <= 0 || !suggestionText) return 0

  const previousAsciiToken = trailingAsciiToken(blockPrefix)
  const correctedAsciiToken = leadingAsciiToken(suggestionText)
  if (previousAsciiToken && correctedAsciiToken) {
    const previous = previousAsciiToken.toLocaleLowerCase()
    const corrected = correctedAsciiToken.toLocaleLowerCase()
    const transposition = isSingleAdjacentTransposition(previous, corrected)
    const distance = transposition ? 1 : levenshteinDistance(previous, corrected)
    const longestLength = Math.max(Array.from(previous).length, Array.from(corrected).length)
    const lengthDifference = Math.abs(
      Array.from(previous).length - Array.from(corrected).length,
    )
    if (previous !== corrected
      && (longestLength >= 4 || (longestLength === 3 && transposition))
      && lengthDifference <= 2
      && distance <= 2
      && (transposition || 1 - (distance / longestLength) >= 0.7)) {
      return Array.from(previousAsciiToken).length
    }
    return 0
  }

  // Chinese text has no reliable local word boundary here. A semantic
  // continuation must never be promoted to deletion based on model output.
  return 0
}

interface StreamDocumentCursorCompletionOptions {
  signal: AbortSignal
  onSuggestion: (suggestion: DocumentCursorCompletionSuggestion) => void
  responseLanguage?: StartAgentRunInput['responseLanguage']
  /** 纯轮询模式的拉取间隔（无推送通道时）。 */
  pollIntervalMs?: number
  /** 推送模式的对账回退间隔：事件唤醒为主，超时兜底拉一次防漏。 */
  reconcileIntervalMs?: number
  /** 总超时。 */
  timeoutMs?: number
  /** 首个可用建议的 deadline：超时即取消 run——迟到的建议对补全没有价值。 */
  firstSuggestionMs?: number
  /** 会话/订阅复用通道；缺省时退回每次建删会话的旧路径。 */
  channel?: DocumentCursorCompletionSessionChannel
  /**
   * 写作风格注入块解析器（§7.1）：缓存实现由调用方注入，本模块保持 window 无关
   * （ported 模块纯净性）。缺省不注入风格。
   */
  resolveWritingStyleBlock?: () => Promise<string | null>
}

export function buildDocumentCursorCompletionPrompt(
  input: DocumentCursorCompletionRequest,
  responseLanguage: StartAgentRunInput['responseLanguage'] = 'zh-CN',
): string {
  const t = i18n.getFixedT(responseLanguage, 'common')
  return [
    t('contextRoom:documentCursorCompletionAgent.promptInstruction'),
    t('contextRoom:documentCursorCompletionAgent.correctionRule'),
    // 指令段是全量固定文本（不随块类型插值）：system/skill 提示词 +
    // 用户消息头部字节稳定，provider 的前缀缓存才能跨请求命中；
    // 具体格式语境由 <EDITOR_CONTEXT> 的 blockType/formatContext 数据承载。
    t('contextRoom:documentCursorCompletionAgent.formatRules'),
    t('contextRoom:documentCursorCompletionAgent.structureRule'),
    '',
    '<PREFIX>',
    input.contextBefore,
    '</PREFIX>',
    '<CURSOR />',
    '<SUFFIX>',
    input.contextAfter,
    '</SUFFIX>',
    ...(input.blockSuffix !== undefined ? [
      '<CURRENT_BLOCK_SUFFIX>',
      input.blockSuffix,
      '</CURRENT_BLOCK_SUFFIX>',
    ] : []),
    ...(input.nearbyBlocks ? [
      '<TIPTAP_NEARBY_BLOCKS>',
      JSON.stringify(input.nearbyBlocks),
      '</TIPTAP_NEARBY_BLOCKS>',
    ] : []),
    '',
    '<EDITOR_CONTEXT>',
    JSON.stringify({
      documentName: input.documentName,
      completionMode: input.completionMode ?? 'inline',
      ...(input.avoidText ? { avoidText: input.avoidText } : {}),
      blockPrefix: input.blockPrefix,
      blockType: input.blockType,
      formatContext: input.formatContext,
    }),
    '</EDITOR_CONTEXT>',
    ...(input.writingStyleBlock ? [
      '',
      '<WRITING_STYLE>',
      input.writingStyleBlock,
      '</WRITING_STYLE>',
    ] : []),
  ].join('\n')
}

function repeatedPrefixLength(contextBefore: string, output: string): number {
  const before = contextBefore.slice(-160)
  const maximum = Math.min(before.length, output.length)
  for (let length = maximum; length >= 2; length -= 1) {
    if (output.startsWith(before.slice(-length))) return length
  }
  return 0
}

function repeatedSuffixLength(contextAfter: string, output: string): number {
  const after = contextAfter.slice(0, 160)
  const maximum = Math.min(after.length, output.length)
  for (let length = maximum; length >= 2; length -= 1) {
    if (output.endsWith(after.slice(0, length))) return length
  }
  return 0
}

/** 段落档上限：2-4 句、合计约 300 码点。 */
const PARAGRAPH_MAX_CHARACTERS = 300
const PARAGRAPH_MAX_SENTENCES = 4

/** 句末标点（与 inline 单句截断同一 alternation，加 g 供段落档收集多边界）。 */
const SENTENCE_END_PATTERN = /[。！？!?]|\.(?=\s|$)/gu

/**
 * 段落档截断：取前 4 个句末边界中最大的「累计 ≤300 码点」边界切片；
 * 无边界或首句即超限时按码点硬切（模型偶尔整段无句读）。
 */
function truncateParagraphCompletion(output: string): string {
  const boundaries: number[] = []
  for (const match of output.matchAll(SENTENCE_END_PATTERN)) {
    boundaries.push(match.index + match[0].length)
    if (boundaries.length >= PARAGRAPH_MAX_SENTENCES) break
  }
  for (let count = boundaries.length; count >= 1; count -= 1) {
    const candidate = output.slice(0, boundaries[count - 1])
    if (Array.from(candidate).length <= PARAGRAPH_MAX_CHARACTERS) {
      return candidate.trimEnd()
    }
  }
  return Array.from(output).slice(0, PARAGRAPH_MAX_CHARACTERS).join('')
}

/**
 * 提示词模板标记：模型把请求模板当补全输出（如实测出现过的 "<CURSOR />" 回显）
 * 即认定整条输出在复述指令而非给内容，作废处理（parse 返回空 → no_completion，
 * 不进熔断、不留 ghost）。误伤面可忽略：全大写尖括号标签不会是正常文档内容。
 */
const PROMPT_TEMPLATE_MARKER = /<\/?(?:PREFIX|SUFFIX|EDITOR_CONTEXT|TIPTAP_NEARBY_BLOCKS|CURRENT_BLOCK_SUFFIX|WRITING_STYLE|writing_style)>|<CURSOR\s*\/?>/iu

export function sanitizeDocumentCursorCompletion(
  value: string,
  contextBefore: string,
  blockType = 'paragraph',
  contextAfter = '',
  formatContext?: DocumentCursorCompletionFormatContext,
  completionMode: DocumentCursorCompletionMode = 'inline',
): string {
  const isCodeBlock = blockType === 'codeBlock'
  let output = value.trimEnd()
  output = output.replace(/^```[^\r\n]*(?:\r?\n|$)/, '')
  output = output.replace(/(?:\r?\n)?```[ \t]*$/, '')
  output = output.replace(/^(?:补全|续写|建议)(?:内容|文本)?\s*[:：]\s*/i, '')
  output = output.replace(/^completion\s*[:：]\s*/i, '')
  if (PROMPT_TEMPLATE_MARKER.test(output)) return ''
  if (!isCodeBlock) output = output.replace(/\r?\n+/g, ' ')
  if (!isCodeBlock && formatContext?.list) {
    output = output.replace(
      /^\s*(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)/u,
      '',
    )
  } else if (!isCodeBlock && blockType === 'heading') {
    output = output.replace(/^\s*#{1,6}\s+/u, '')
  } else if (!isCodeBlock && formatContext?.ancestorTypes.includes('blockquote')) {
    output = output.replace(/^\s*>\s?/u, '')
  }
  if (!isCodeBlock && formatContext?.activeMarks.includes('code')) {
    output = output.replace(/^`([^`\r\n]+)`$/u, '$1')
  }
  if (!isCodeBlock && formatContext?.activeMarks.includes('bold')) {
    output = output
      .replace(/^\*\*([\s\S]+)\*\*$/u, '$1')
      .replace(/^__([\s\S]+)__$/u, '$1')
  }
  if (!isCodeBlock && formatContext?.activeMarks.includes('italic')) {
    output = output
      .replace(/^\*([^*\r\n]+)\*$/u, '$1')
      .replace(/^_([^_\r\n]+)_$/u, '$1')
  }
  if (!isCodeBlock && formatContext?.activeMarks.includes('strike')) {
    output = output.replace(/^~~([\s\S]+)~~$/u, '$1')
  }
  if (!isCodeBlock && formatContext?.activeMarks.includes('link')) {
    output = output.replace(/^\[([^\]\r\n]+)\]\([^)\r\n]+\)$/u, '$1')
  }
  if (!isCodeBlock && formatContext?.ancestorTypes
    .some((type) => type === 'tableCell' || type === 'tableHeader')) {
    output = output.replace(/^\s*\|\s*([\s\S]*?)\s*\|\s*$/u, '$1')
  }
  const repeated = repeatedPrefixLength(contextBefore, output)
  if (repeated > 0) output = output.slice(repeated)
  const repeatedAfter = repeatedSuffixLength(contextAfter, output)
  if (repeatedAfter > 0) output = output.slice(0, -repeatedAfter)
  output = output.replace(/^["“](.*)["”]$/u, '$1')
  if (!output.trim()) return ''
  if (!isCodeBlock) {
    if (completionMode === 'paragraph') {
      output = truncateParagraphCompletion(output)
    } else {
      const sentence = output.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$))/u)?.[0]
      if (sentence) output = sentence.trimEnd()
    }
  }
  const maximum = isCodeBlock ? 160 : completionMode === 'paragraph' ? PARAGRAPH_MAX_CHARACTERS : 80
  return Array.from(output).slice(0, maximum).join('')
}

function stripCompletionFence(value: string): string {
  return value
    .replace(/^```[^\r\n]*(?:\r?\n|$)/, '')
    .replace(/(?:\r?\n)?```[ \t]*$/, '')
}

export function parseDocumentCursorCompletion(
  value: string,
  input: Pick<DocumentCursorCompletionRequest, 'blockPrefix' | 'blockType' | 'contextBefore' | 'contextAfter' | 'formatContext' | 'completionMode'>,
): DocumentCursorCompletionSuggestion {
  const raw = stripCompletionFence(value)
  const newline = raw.search(/\r?\n/u)
  let body = raw
  let replaceCharacters = 0

  if (newline < 0) {
    const possibleHeader = raw.trim().toUpperCase()
    if ('KEEP'.startsWith(possibleHeader)
      || 'REPLACE'.startsWith(possibleHeader)
      || /^REPLACE\s*:\s*\d{0,2}$/u.test(possibleHeader)) {
      return { text: '', replaceCharacters: 0 }
    }
  } else {
    const header = raw.slice(0, newline).trim()
    const replacement = header.match(/^REPLACE\s*:\s*(\d{1,3})$/iu)
    if (header.toUpperCase() === 'KEEP') {
      body = raw.slice(newline).replace(/^\r?\n/u, '')
    } else if (replacement) {
      body = raw.slice(newline).replace(/^\r?\n/u, '')
      replaceCharacters = Math.min(Number(replacement[1]), 32)
    }
  }

  const text = sanitizeDocumentCursorCompletion(
    body,
    input.contextBefore,
    input.blockType,
    input.contextAfter,
    input.formatContext,
    input.completionMode,
  )
  return {
    text,
    replaceCharacters: text
      ? validatedDocumentCursorReplacement(input.blockPrefix, text, replaceCharacters)
      : 0,
  }
}

function eventText(event: AgentEvent, key: 'delta' | 'content' | 'message'): string | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const value = (event.payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function abortError(): DOMException {
  return new DOMException('Document cursor completion cancelled', 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function deleteTemporarySession(
  api: DocumentCursorCompletionAgentApi,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await api.deleteSession(sessionId)
      return
    } catch {
      if (attempt === 4) return
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 40))
    }
  }
}

export interface DocumentCursorCompletionChannelOptions {
  roomId: string
  roomTitle?: string
  documentName: string
  responseLanguage?: StartAgentRunInput['responseLanguage']
}

/**
 * 补全会话通道：按编辑器生命周期复用一个 agent 会话和一条 websocket
 * 订阅，替代「每次补全 createSession → … → deleteSession」的往返 churn。
 *
 * 会话失效（404，如补全服务重启）由调用方 invalidate 后自动重建。
 * 订阅失败不致命：流式循环仍以对账拉取兜底。注意 main 侧订阅按
 * webContents 单会话——多个编辑器实例并存时后订阅者会顶掉前者，
 * 被顶掉的编辑器退化为对账节奏，正确性不受影响。
 */
export class DocumentCursorCompletionSessionChannel {
  private session: AgentSession | null = null
  private creating: Promise<AgentSession> | null = null
  private subscribedSessionId: string | null = null
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private disposed = false
  readonly supportsPush: boolean

  constructor(
    private readonly api: DocumentCursorCompletionAgentApi,
    private readonly input: DocumentCursorCompletionChannelOptions,
  ) {
    this.supportsPush = Boolean(api.subscribe && api.unsubscribe && api.onEvent)
    api.onEvent?.((frame: AgentSocketFrame) => {
      if (frame.type !== 'event') return
      if (frame.event.sessionId !== this.session?.id) return
      for (const listener of [...this.listeners]) listener(frame.event)
    })
  }

  /** 幂等获取（或创建）复用会话；并发调用共享同一次创建。 */
  async acquireSession(): Promise<AgentSession> {
    if (this.disposed) {
      throw new DocumentCursorCompletionError('aborted', 'completion session channel disposed')
    }
    if (this.session) return this.session
    this.creating ??= this.api.createSession({
      pageLabel: i18n.getFixedT(this.input.responseLanguage ?? 'zh-CN', 'common')(
        'contextRoom:documentCursorCompletionAgent.pageLabel',
        { name: this.input.documentName },
      ),
      roomId: this.input.roomId,
    }).then((session) => {
      this.session = session
      return session
    }).finally(() => {
      this.creating = null
    })
    return this.creating
  }

  /** 丢弃缓存的会话（下次 acquireSession 重建）；订阅句柄随会话 id 失效。 */
  invalidateSession(): void {
    this.session = null
  }

  /** 推送模式下保证订阅已发起；必须在 startRun 之前调用以免漏早期事件。 */
  async ensureSubscribed(): Promise<void> {
    if (!this.supportsPush || !this.session) return
    const sessionId = this.session.id
    if (this.subscribedSessionId === sessionId) return
    try {
      await this.api.subscribe?.(sessionId)
      if (this.disposed) {
        // dispose 发生在订阅 IPC 在途时：立即退订，避免孤儿 socket。
        await this.api.unsubscribe?.().catch(() => undefined)
        return
      }
      this.subscribedSessionId = sessionId
    } catch {
      // 订阅失败退回对账拉取节奏；不阻塞补全请求。
    }
  }

  addEventListener(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 尽力拆除：退订 + 删会话；异步执行，不阻塞调用方。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const api = this.api
    const session = this.session
    const wasSubscribed = this.subscribedSessionId !== null
    this.session = null
    this.subscribedSessionId = null
    this.listeners.clear()
    void (async () => {
      if (wasSubscribed) await api.unsubscribe?.().catch(() => undefined)
      if (session) await deleteTemporarySession(api, session.id)
    })()
  }
}

const DEFAULT_STREAM_TIMEOUT_MS = 10_000
/** session_busy 退避：150/300/600/1200ms 共 4 次，覆盖网关释放旧 run 的秒级窗口。 */
const SESSION_BUSY_RETRY_LIMIT = 4
const SESSION_BUSY_RETRY_BASE_MS = 150
const DEFAULT_FIRST_SUGGESTION_MS = 4_000
const DEFAULT_RECONCILE_INTERVAL_MS = 500

export async function streamDocumentCursorCompletion(
  api: DocumentCursorCompletionAgentApi,
  input: DocumentCursorCompletionRequest,
  options: StreamDocumentCursorCompletionOptions,
): Promise<DocumentCursorCompletionSuggestion> {
  const channel = options.channel ?? null
  const pushMode = Boolean(channel?.supportsPush)
  const pollIntervalMs = options.pollIntervalMs ?? 70
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
  const firstSuggestionMs = options.firstSuggestionMs ?? DEFAULT_FIRST_SUGGESTION_MS
  const startedAt = Date.now()
  let sessionId: string | null = null
  let runId: string | null = null
  let cancelPromise: Promise<unknown> | null = null
  let runSettled = false
  let rawText = ''
  let afterSeq = 0
  let sawUsableSuggestion = false
  let wakeResolver: (() => void) | null = null

  const cancelRun = () => {
    if (!runId || cancelPromise || runSettled) return
    cancelPromise = api.cancelRun(runId).catch(() => undefined)
  }
  const onAbort = () => {
    cancelRun()
    wakeResolver?.()
  }
  options.signal.addEventListener('abort', onAbort)

  let failureMessage: string | null = null
  const processEvent = (event: AgentEvent): 'completed' | 'failed' | 'cancelled' | null => {
    if (event.type === 'message.delta') {
      const delta = eventText(event, 'delta')
      if (delta) {
        rawText += delta
        const suggestion = parseDocumentCursorCompletion(rawText, input)
        if (suggestion.text) sawUsableSuggestion = true
        options.onSuggestion(suggestion)
      }
    } else if (event.type === 'message.completed') {
      const content = eventText(event, 'content')
      if (content !== null) rawText = content
      const suggestion = parseDocumentCursorCompletion(rawText, input)
      if (suggestion.text) sawUsableSuggestion = true
      options.onSuggestion(suggestion)
    } else if (event.type === 'run.completed') {
      return 'completed'
    } else if (event.type === 'run.failed' || event.type === 'run.interrupted') {
      failureMessage = eventText(event, 'message')
      return 'failed'
    } else if (event.type === 'run.cancelled') {
      return 'cancelled'
    }
    return null
  }

  // 推送事件先进队列，循环内按 seq 去重排序后与拉取结果合并处理。
  const pushedEvents: AgentEvent[] = []
  const removePushListener = channel?.addEventListener((event) => {
    if (event.seq <= afterSeq) return
    pushedEvents.push(event)
    wakeResolver?.()
  }) ?? null

  /** 推送模式：任意事件唤醒；纯轮询模式：固定间隔。 */
  const waitForNext = async (): Promise<void> => {
    if (pushedEvents.length) return
    if (!pushMode) return wait(pollIntervalMs, options.signal)
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        globalThis.clearTimeout(timer)
        options.signal.removeEventListener('abort', onWaitAbort)
        wakeResolver = null
        resolve()
      }
      const timer = globalThis.setTimeout(settle, reconcileIntervalMs)
      const onWaitAbort = () => {
        globalThis.clearTimeout(timer)
        wakeResolver = null
        reject(abortError())
      }
      if (options.signal.aborted) {
        onWaitAbort()
        return
      }
      options.signal.addEventListener('abort', onWaitAbort, { once: true })
      wakeResolver = settle
    })
  }

  try {
    throwIfAborted(options.signal)
    // 风格块走 TTL 缓存解析：命中时零 IPC 开销，失败静默为不注入。
    const writingStyleBlock = await (options.resolveWritingStyleBlock?.() ?? Promise.resolve(null))
    throwIfAborted(options.signal)
    let run: AgentRun
    let rebuiltSession = false
    let busyRetries = 0
    for (;;) {
      const session = channel
        ? await channel.acquireSession()
        : await api.createSession({
          pageLabel: i18n.getFixedT(options.responseLanguage ?? 'zh-CN', 'common')('contextRoom:documentCursorCompletionAgent.pageLabel', { name: input.documentName }),
          roomId: input.roomId,
        })
      sessionId = session.id
      if (channel) await channel.ensureSubscribed()
      try {
        run = await api.startRun(session.id, {
          prompt: buildDocumentCursorCompletionPrompt(
            writingStyleBlock ? { ...input, writingStyleBlock } : input,
            options.responseLanguage,
          ),
          idempotencyKey: crypto.randomUUID(),
          responseLanguage: options.responseLanguage,
          captureMemory: false,
          recallMemory: false,
          toolsEnabled: false,
          context: {
            selectedRoomId: input.roomId,
            rooms: [{
              id: input.roomId,
              title: input.roomTitle?.trim() || input.documentName,
            }],
          },
        })
        break
      } catch (error) {
        const errorKind = classifyDocumentCursorCompletionError(error)
        // 复用会话可能已被服务端丢弃（补全服务重启）：换新会话重试一次。
        if (channel && !rebuiltSession && errorKind === 'session_not_found') {
          rebuiltSession = true
          channel.invalidateSession()
          sessionId = null
          continue
        }
        // 会话还在释放上一个被 supersede 的 run（网关等 run.cancelled 落库才回
        // idle，实测可达秒级）：同会话指数退避重试，而不是把竞态当 provider 失败。
        if (errorKind === 'session_busy' && busyRetries < SESSION_BUSY_RETRY_LIMIT) {
          busyRetries += 1
          await wait(SESSION_BUSY_RETRY_BASE_MS * 2 ** (busyRetries - 1), options.signal)
          continue
        }
        throw error
      }
    }
    runId = run.id
    if (options.signal.aborted) {
      cancelRun()
      throw abortError()
    }

    let settleOutcome: 'completed' | 'failed' | 'cancelled' | null = null
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal)
      // 推送队列非空时直接消费推送（零 HTTP）；否则做一次增量对账拉取。
      const batch = pushedEvents.splice(0)
      if (!batch.length || !pushMode) {
        const events = await api.getEvents(sessionId, run.id, afterSeq)
        batch.push(...events)
      }
      batch.sort((left, right) => left.seq - right.seq)
      for (const event of batch) {
        if (event.seq <= afterSeq) continue
        afterSeq = event.seq
        const outcome = processEvent(event)
        if (outcome && !settleOutcome) settleOutcome = outcome
      }
      if (settleOutcome) {
        // 终局前做最后一次对账：拉取 + 竞态期间推来的事件合并处理，
        // 避免 socket 乱序/掉线漏掉 message.completed 导致陈旧收尾。
        const finalEvents = [...pushedEvents.splice(0)]
        finalEvents.push(...(await api.getEvents(sessionId, run.id, afterSeq)))
        finalEvents.sort((left, right) => left.seq - right.seq)
        for (const event of finalEvents) {
          if (event.seq <= afterSeq) continue
          afterSeq = event.seq
          const outcome = processEvent(event)
          if (outcome && !settleOutcome) settleOutcome = outcome
        }
        runSettled = true
        if (settleOutcome === 'completed') {
          const suggestion = parseDocumentCursorCompletion(rawText, input)
          if (!suggestion.text) {
            throw new DocumentCursorCompletionError(
              'no_completion',
              i18n.t('contextRoom:documentCursorCompletionAgent.noUsableCompletion'),
            )
          }
          return suggestion
        }
        if (settleOutcome === 'failed') {
          throw new DocumentCursorCompletionError(
            'provider',
            failureMessage || i18n.t('contextRoom:documentCursorCompletionAgent.failed'),
          )
        }
        throw abortError()
      }
      // 首个可用建议 deadline：迟到的建议对补全没有价值。
      if (!sawUsableSuggestion && Date.now() - startedAt >= firstSuggestionMs) {
        cancelRun()
        throw new DocumentCursorCompletionError(
          'first_suggestion_timeout',
          i18n.t('contextRoom:documentCursorCompletionAgent.timedOut'),
        )
      }
      await waitForNext()
    }
    cancelRun()
    throw new DocumentCursorCompletionError(
      'timeout',
      i18n.t('contextRoom:documentCursorCompletionAgent.timedOut'),
    )
  } finally {
    removePushListener?.()
    options.signal.removeEventListener('abort', onAbort)
    if (!runSettled) cancelRun()
    if (cancelPromise) await cancelPromise
    if (!channel && sessionId) await deleteTemporarySession(api, sessionId)
  }
}
