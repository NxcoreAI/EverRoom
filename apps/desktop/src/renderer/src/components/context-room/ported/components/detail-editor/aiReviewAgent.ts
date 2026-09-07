import i18n from '@/i18n/i18next'
import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSessionSnapshot,
  StartAgentRunInput,
} from '@nxcore/agent-contract'

/**
 * 文档 AI 审阅（评论建议）：一键按钮触发的罐头审阅 run。
 * 与补全 agent 的关键差异：不传 toolsEnabled（默认 true），agent 需要
 * context_room_document_read + context_room_document_comment_add 工具链；
 * 完成检测轮询 getEvents（不用 agent.subscribe——它会顶掉聊天页的单会话订阅）。
 */

export interface DocumentAiReviewAgentApi {
  createSession(input: { pageLabel: string; roomId?: string | null }): Promise<AgentSession>
  getSession(sessionId: string): Promise<AgentSessionSnapshot>
  startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
}

export type DocumentAiReviewOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface DocumentAiReviewRunInput {
  sessionId: string
  roomId: string
  documentId: string
  documentTitle: string
  /** flush 后的权威版本，防止审阅旧内容。 */
  version: number
  responseLanguage: StartAgentRunInput['responseLanguage']
}

export interface DocumentAiReviewRunOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

const TERMINAL_RUN_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])
const OUTCOME_BY_EVENT: Record<string, DocumentAiReviewOutcome> = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.interrupted': 'interrupted',
}
const SESSION_BUSY_PATTERN = /agent_session_busy|session_busy|already has an active run/i

export function buildDocumentAiReviewPrompt(
  input: { documentTitle: string },
  responseLanguage: StartAgentRunInput['responseLanguage'] = 'zh-CN',
): string {
  const t = i18n.getFixedT(responseLanguage, 'common')
  return t('contextRoom:aiReviewAgent.prompt', { title: input.documentTitle })
}

export function isSessionBusyError(error: unknown): boolean {
  return error instanceof Error && SESSION_BUSY_PATTERN.test(error.message)
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('aborted'))
    return
  }
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(signal.reason ?? new Error('aborted'))
  }, { once: true })
})

/** 轮询 run 直到终态；abort/超时只停止轮询（run 在服务端继续，评论经推送照样到达）。 */
export async function pollDocumentAiReviewRun(
  api: DocumentAiReviewAgentApi,
  sessionId: string,
  runId: string,
  options: DocumentAiReviewRunOptions = {},
): Promise<DocumentAiReviewOutcome> {
  const interval = options.pollIntervalMs ?? 1_500
  const deadline = Date.now() + (options.timeoutMs ?? 300_000)
  let afterSeq = 0
  for (;;) {
    const events = await api.getEvents(sessionId, runId, afterSeq)
    for (const event of events) {
      afterSeq = Math.max(afterSeq, event.seq)
      if (TERMINAL_RUN_EVENTS.has(event.type)) return OUTCOME_BY_EVENT[event.type] ?? 'failed'
    }
    if (Date.now() > deadline) return 'failed'
    await sleep(interval, options.signal)
  }
}

/** 发起并跟踪一次 AI 审阅 run。session_busy 时抛出原始错误，由调用方挂到在途 run。 */
export async function runDocumentAiReview(
  api: DocumentAiReviewAgentApi,
  input: DocumentAiReviewRunInput,
  options: DocumentAiReviewRunOptions = {},
): Promise<DocumentAiReviewOutcome> {
  const run = await api.startRun(input.sessionId, {
    prompt: buildDocumentAiReviewPrompt({ documentTitle: input.documentTitle }, input.responseLanguage),
    idempotencyKey: crypto.randomUUID(),
    responseLanguage: input.responseLanguage,
    captureMemory: false,
    // 召回 Room 记忆（聚焦当前房间）：审阅建议结合记忆里的用户背景、目标与事实。
    recallMemory: true,
    memoryScope: 'room',
    // 不传 toolsEnabled（默认 true）：审阅需要文档读取与评论工具。
    context: {
      selectedRoomId: input.roomId,
      activeDocument: {
        roomId: input.roomId,
        documentId: input.documentId,
        title: input.documentTitle,
        version: input.version,
        defaultAnchor: 'end',
      },
    },
  })
  return pollDocumentAiReviewRun(api, input.sessionId, run.id, options)
}
