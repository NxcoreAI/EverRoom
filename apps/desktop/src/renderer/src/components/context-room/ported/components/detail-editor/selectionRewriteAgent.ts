import type { SubagentInvocation } from '@nxcore/agent-contract'
import i18n from '@/i18n/i18next'
import type { AppLocale } from '@/i18n/resources'
import type { RoomAgentSelectionRewriteInput } from '../../../../../../../shared/sources'

/**
 * 划词改写已迁入 context-room dispatch_only 子 Agent：dispatch 后轮询 invocation 至终态。
 * 见 gateway POST /v1/context-rooms/selection-rewrite 与 GET /v1/subagent-invocations/:id。
 */
export interface SelectionRewriteAgentApi {
  dispatchSelectionRewrite(input: RoomAgentSelectionRewriteInput): Promise<{ invocationId: string }>
  getSubagentInvocation(invocationId: string): Promise<SubagentInvocation>
  cancelSubagentInvocation(invocationId: string): Promise<SubagentInvocation>
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
  responseLanguage?: AppLocale
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface SelectionRewriteAgentResult {
  replacementText: string
  invocationId: string
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

function isTerminalStatus(status: SubagentInvocation['status']): boolean {
  return status !== 'accepted' && status !== 'running'
}

export async function streamSelectionRewrite(
  api: SelectionRewriteAgentApi,
  input: SelectionRewriteRequest,
  options: StreamSelectionRewriteOptions,
): Promise<SelectionRewriteAgentResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  let invocationId: string | null = null
  let cancelPromise: Promise<unknown> | null = null
  let settled = false
  const preserveWhitespace = input.formatContext?.blockType === 'codeBlock'
    || input.formatContext?.ancestorTypes.includes('codeBlock') === true

  const cancelInvocation = () => {
    if (!invocationId || cancelPromise) return
    cancelPromise = api.cancelSubagentInvocation(invocationId).catch(() => undefined)
  }
  const onAbort = () => cancelInvocation()
  options.signal.addEventListener('abort', onAbort)

  try {
    throwIfAborted(options.signal)
    const t = i18n.getFixedT(options.responseLanguage ?? 'zh-CN', 'common')
    const dispatched = await api.dispatchSelectionRewrite({
      roomId: input.roomId,
      documentName: input.documentName,
      selectedText: input.selectedText,
      instruction: input.instruction.trim() || t('contextRoom:selectionRewriteAgent.defaultInstruction'),
      contextBefore: input.contextBefore,
      contextAfter: input.contextAfter,
      blockType: input.formatContext?.blockType,
      responseLanguage: options.responseLanguage,
    })
    invocationId = dispatched.invocationId

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal)
      const invocation = await api.getSubagentInvocation(invocationId)
      if (invocation.status === 'completed') {
        settled = true
        // M2（doc-writer-subagent-plan §8）：doc-writer invocation 的替换文本在
        // structuredOutput.replacementText；text 回退兼容迁移期存量的 context-room invocation。
        const structured = invocation.result?.structuredOutput
        const structuredReplacement = structured && typeof structured === 'object' && !Array.isArray(structured)
          ? (structured as { replacementText?: unknown }).replacementText
          : null
        const rawText = typeof structuredReplacement === 'string' && structuredReplacement
          ? structuredReplacement
          : (invocation.result?.text ?? '')
        const output = sanitizeSelectionRewriteOutput(rawText, { preserveWhitespace })
        if (!output) throw new Error(i18n.t('contextRoom:selectionRewriteAgent.noReplacementText'))
        options.onText(output)
        return { replacementText: output, invocationId }
      }
      if (invocation.status === 'cancelled') {
        settled = true
        throw abortError()
      }
      if (isTerminalStatus(invocation.status)) {
        settled = true
        throw new Error(invocation.errorMessage || i18n.t('contextRoom:selectionRewriteAgent.failed'))
      }
      await wait(pollIntervalMs, options.signal)
    }
    cancelInvocation()
    throw new Error(i18n.t('contextRoom:selectionRewriteAgent.timedOut'))
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    if (!settled) cancelInvocation()
    if (cancelPromise) await cancelPromise
  }
}
