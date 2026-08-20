import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  CreateAgentSessionInput,
  StartAgentRunInput,
} from '@nxcore/agent-contract'

export interface DocumentCursorCompletionAgentApi {
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>
  deleteSession(sessionId: string): Promise<void>
  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
  startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
  cancelRun(runId: string): Promise<AgentRun>
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

export interface DocumentCursorCompletionRequest {
  roomId: string
  documentName: string
  contextBefore: string
  contextAfter: string
  blockPrefix: string
  blockSuffix?: string
  blockType: string
  formatContext: DocumentCursorCompletionFormatContext
  nearbyBlocks?: DocumentCursorCompletionNearbyBlock[]
}

export interface DocumentCursorCompletionSuggestion {
  text: string
  replaceCharacters: number
}

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
  pollIntervalMs?: number
  timeoutMs?: number
}

export function buildDocumentCursorCompletionPrompt(
  input: DocumentCursorCompletionRequest,
): string {
  const { formatContext } = input
  const insideCodeBlock = input.blockType === 'codeBlock'
    || formatContext.ancestorTypes.includes('codeBlock')
  let outputRule: string
  if (insideCodeBlock) {
    const language = formatContext.codeLanguage?.trim() || '未标注语言'
    outputRule = `光标位于 ${language} 代码块：只补全当前代码块内的原始代码，依据 codeLinePrefix 保持当前行缩进，允许必要换行，最多 160 个字符，不要添加代码围栏或语言标记。`
  } else if (formatContext.list) {
    const listLabel = formatContext.list.type === 'orderedList'
      ? '有序列表'
      : formatContext.list.type === 'taskList' ? '任务列表' : '无序列表'
    const taskState = formatContext.list.type === 'taskList'
      ? `，当前任务${formatContext.list.checked ? '已完成' : '未完成'}`
      : ''
    outputRule = `光标位于第 ${formatContext.list.depth} 层${listLabel}的当前条目中${taskState}：只补全当前条目正文，最多 80 个字符，不要换行，不要输出列表标记、复选框或创建下一条目。`
  } else if (input.blockType === 'heading') {
    outputRule = `光标位于 ${formatContext.headingLevel ?? '未知'} 级标题：只补全当前标题文字，最多 80 个字符，不要换行，不要输出 # 或创建新标题。`
  } else if (formatContext.ancestorTypes.includes('blockquote')) {
    outputRule = '光标位于引用块：只补全当前引用段落文字，最多 80 个字符，不要换行，不要输出 > 或创建新引用块。'
  } else if (formatContext.ancestorTypes.some((type) => type === 'tableCell' || type === 'tableHeader')) {
    outputRule = '光标位于表格单元格：只补全当前单元格内的文字，最多 80 个字符，不要换行，不要输出表格分隔符或创建行列。'
  } else {
    outputRule = '只补全当前文本块内的一个短语或一句话，最多 80 个字符，不要换行，不要创建标题、列表或其他新块。'
  }
  const markRule = formatContext.activeMarks.includes('code')
    ? '当前文字使用行内代码格式，只输出原始文本，不要添加反引号。'
    : formatContext.activeMarks.length > 0
      ? `当前文字 marks 为 ${formatContext.activeMarks.join(', ')}；只输出文字，不要重复添加 Markdown 格式标记。`
      : null
  return [
    '使用 document-cursor-completion Skill 完成富文本文档的 FIM 补全。只生成 <CURSOR /> 位置应出现的内容。',
    '若光标前存在明显错字可以按 Skill 协议纠正，否则只补充光标后的内容。',
    outputRule,
    ...(markRule ? [markRule] : []),
    '不要复述 PREFIX 或 SUFFIX；必须与当前 Tiptap 块类型、祖先结构和 marks 保持一致。',
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
      blockPrefix: input.blockPrefix,
      blockType: input.blockType,
      formatContext: input.formatContext,
    }),
    '</EDITOR_CONTEXT>',
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

export function sanitizeDocumentCursorCompletion(
  value: string,
  contextBefore: string,
  blockType = 'paragraph',
  contextAfter = '',
  formatContext?: DocumentCursorCompletionFormatContext,
): string {
  const isCodeBlock = blockType === 'codeBlock'
  let output = value.trimEnd()
  output = output.replace(/^```[^\r\n]*(?:\r?\n|$)/, '')
  output = output.replace(/(?:\r?\n)?```[ \t]*$/, '')
  output = output.replace(/^(?:补全|续写|建议)(?:内容|文本)?\s*[:：]\s*/i, '')
  output = output.replace(/^completion\s*[:：]\s*/i, '')
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
    const sentence = output.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$))/u)?.[0]
    if (sentence) output = sentence.trimEnd()
  }
  return Array.from(output).slice(0, isCodeBlock ? 160 : 80).join('')
}

function stripCompletionFence(value: string): string {
  return value
    .replace(/^```[^\r\n]*(?:\r?\n|$)/, '')
    .replace(/(?:\r?\n)?```[ \t]*$/, '')
}

export function parseDocumentCursorCompletion(
  value: string,
  input: Pick<DocumentCursorCompletionRequest, 'blockPrefix' | 'blockType' | 'contextBefore' | 'contextAfter' | 'formatContext'>,
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

export async function streamDocumentCursorCompletion(
  api: DocumentCursorCompletionAgentApi,
  input: DocumentCursorCompletionRequest,
  options: StreamDocumentCursorCompletionOptions,
): Promise<DocumentCursorCompletionSuggestion> {
  const pollIntervalMs = options.pollIntervalMs ?? 70
  const timeoutMs = options.timeoutMs ?? 30_000
  const startedAt = Date.now()
  let sessionId: string | null = null
  let runId: string | null = null
  let cancelPromise: Promise<unknown> | null = null
  let runSettled = false
  let rawText = ''
  let afterSeq = 0

  const cancelRun = () => {
    if (!runId || cancelPromise || runSettled) return
    cancelPromise = api.cancelRun(runId).catch(() => undefined)
  }
  const onAbort = () => cancelRun()
  options.signal.addEventListener('abort', onAbort)

  try {
    throwIfAborted(options.signal)
    const session = await api.createSession({
      pageLabel: `AI 补全 · ${input.documentName}`,
      roomId: input.roomId,
    })
    sessionId = session.id
    throwIfAborted(options.signal)
    const run = await api.startRun(session.id, {
      prompt: buildDocumentCursorCompletionPrompt(input),
      idempotencyKey: crypto.randomUUID(),
      responseLanguage: options.responseLanguage,
      captureMemory: false,
      recallMemory: false,
      toolsEnabled: false,
    })
    runId = run.id
    if (options.signal.aborted) {
      cancelRun()
      throw abortError()
    }

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal)
      const events = await api.getEvents(session.id, run.id, afterSeq)
      for (const event of events) {
        afterSeq = Math.max(afterSeq, event.seq)
        if (event.type === 'message.delta') {
          const delta = eventText(event, 'delta')
          if (delta) {
            rawText += delta
            options.onSuggestion(parseDocumentCursorCompletion(rawText, input))
          }
        } else if (event.type === 'message.completed') {
          const content = eventText(event, 'content')
          if (content !== null) rawText = content
          options.onSuggestion(parseDocumentCursorCompletion(rawText, input))
        } else if (event.type === 'run.completed') {
          runSettled = true
          const suggestion = parseDocumentCursorCompletion(rawText, input)
          if (!suggestion.text) throw new Error('Agent 没有返回可用的补全内容。')
          return suggestion
        } else if (event.type === 'run.failed' || event.type === 'run.interrupted') {
          runSettled = true
          throw new Error(eventText(event, 'message') || 'Agent 补全失败。')
        } else if (event.type === 'run.cancelled') {
          runSettled = true
          throw abortError()
        }
      }
      await wait(pollIntervalMs, options.signal)
    }
    cancelRun()
    throw new Error('Agent 补全超时。')
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    if (!runSettled) cancelRun()
    if (cancelPromise) await cancelPromise
    if (sessionId) await deleteTemporarySession(api, sessionId)
  }
}
