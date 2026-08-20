import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  CreateAgentSessionInput,
  StartAgentRunInput,
} from '@nxcore/agent-contract'

export interface SelectionRewriteAgentApi {
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>
  deleteSession(sessionId: string): Promise<void>
  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
  startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
  cancelRun(runId: string): Promise<AgentRun>
}

export interface SelectionRewriteRequest {
  roomId: string
  documentName: string
  selectedText: string
  instruction: string
  contextBefore: string
  contextAfter: string
  formatContext?: SelectionRewriteFormatContext
}

export interface SelectionRewriteFormatContext {
  blockType: string
  ancestorTypes: string[]
  codeLanguage?: string | null
}

interface StreamSelectionRewriteOptions {
  signal: AbortSignal
  onText: (text: string) => void
  responseLanguage?: StartAgentRunInput['responseLanguage']
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface SelectionRewriteAgentResult {
  replacementText: string
  sessionId: string
  runId: string
}

const DEFAULT_INSTRUCTION = '保持原意，重写得更清晰、自然。'

export function buildSelectionRewritePrompt(input: SelectionRewriteRequest): string {
  const payload = {
    instruction: input.instruction.trim() || DEFAULT_INSTRUCTION,
    selectedText: input.selectedText,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    ...(input.formatContext ? { formatContext: input.formatContext } : {}),
  }
  return [
    '使用 selection-rewrite Skill 重写文档中的指定选区。',
    '',
    JSON.stringify(payload),
  ].join('\n')
}

export function sanitizeSelectionRewriteOutput(
  value: string,
  options: { preserveWhitespace?: boolean } = {},
): string {
  const preserveWhitespace = options.preserveWhitespace === true
  let output = preserveWhitespace ? value : value.trimStart()
  const openingFence = /^```([^\r\n]*)(?:\r?\n|$)/.exec(output)
  const fenceLanguage = openingFence?.[1]?.trim().toLowerCase() ?? ''
  const unwrapFence = preserveWhitespace
    || fenceLanguage === ''
    || fenceLanguage === 'text'
    || fenceLanguage === 'plain'
    || fenceLanguage === 'plaintext'
    || fenceLanguage === 'markdown'
    || fenceLanguage === 'md'
  if (openingFence && unwrapFence) {
    output = output.slice(openingFence[0].length)
    output = output.replace(/(\r?\n)```[ \t]*$/, '$1')
  }
  if (preserveWhitespace) return output
  output = output.replace(/^(?:改写|重写)(?:(?:后的)?(?:文档)?(?:选区)?(?:内容|文本|结果)(?:如下)?)?\s*[:：]\s*/i, '')
  output = output.replace(/^replacement\s*[:：]\s*/i, '')
  return output.trimEnd()
}

function abortError(): DOMException {
  return new DOMException('Selection rewrite cancelled', 'AbortError')
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

function eventText(event: AgentEvent, key: 'delta' | 'content' | 'message'): string | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const value = (event.payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

async function deleteTemporarySession(api: SelectionRewriteAgentApi, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.deleteSession(sessionId)
      return
    } catch {
      if (attempt < 2) await new Promise((resolve) => globalThis.setTimeout(resolve, 80))
    }
  }
}

export async function streamSelectionRewrite(
  api: SelectionRewriteAgentApi,
  input: SelectionRewriteRequest,
  options: StreamSelectionRewriteOptions,
): Promise<SelectionRewriteAgentResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 70
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  let sessionId: string | null = null
  let runId: string | null = null
  let cancelPromise: Promise<unknown> | null = null
  let runSettled = false
  let completed = false
  let rawText = ''
  let afterSeq = 0
  const preserveWhitespace = input.formatContext?.blockType === 'codeBlock'
    || input.formatContext?.ancestorTypes.includes('codeBlock') === true

  const cancelRun = () => {
    if (!runId || cancelPromise) return
    cancelPromise = api.cancelRun(runId).catch(() => undefined)
  }
  const onAbort = () => cancelRun()
  options.signal.addEventListener('abort', onAbort)

  try {
    throwIfAborted(options.signal)
    const session = await api.createSession({
      pageLabel: `AI 重写 · ${input.documentName}`,
      roomId: input.roomId,
    })
    sessionId = session.id
    throwIfAborted(options.signal)
    const run = await api.startRun(session.id, {
      prompt: buildSelectionRewritePrompt(input),
      idempotencyKey: crypto.randomUUID(),
      responseLanguage: options.responseLanguage,
      captureMemory: false,
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
            options.onText(sanitizeSelectionRewriteOutput(rawText, { preserveWhitespace }))
          }
        } else if (event.type === 'message.completed') {
          const content = eventText(event, 'content')
          if (content !== null) rawText = content
          options.onText(sanitizeSelectionRewriteOutput(rawText, { preserveWhitespace }))
        } else if (event.type === 'run.completed') {
          runSettled = true
          const output = sanitizeSelectionRewriteOutput(rawText, { preserveWhitespace })
          if (!output) throw new Error('Agent 没有返回可替换的文本。')
          completed = true
          return { replacementText: output, sessionId: session.id, runId: run.id }
        } else if (event.type === 'run.failed' || event.type === 'run.interrupted') {
          runSettled = true
          const message = eventText(event, 'message')
          throw new Error(message || 'Agent 重写失败。')
        } else if (event.type === 'run.cancelled') {
          runSettled = true
          throw abortError()
        }
      }
      await wait(pollIntervalMs, options.signal)
    }
    cancelRun()
    throw new Error('Agent 重写超时。')
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    if (!runSettled) cancelRun()
    if (cancelPromise) await cancelPromise
    if (sessionId && !completed) await deleteTemporarySession(api, sessionId)
  }
}
