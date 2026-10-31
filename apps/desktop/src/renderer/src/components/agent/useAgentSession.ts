import type {
  AgentContextUsage,
  AgentEvent,
  AgentActiveDocumentContext,
  AgentFileAttachment,
  AgentMessage,
  AgentModelPreference,
  AgentPermissionMode,
  AgentPermissionModeState,
  AgentRoomReference,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentThinkingLevel,
  CreateAgentSessionLinkInput,
} from '@nxcore/agent-contract'
import { createVersionedLocalStorageStore } from '@nxcore/migration-kit/local'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import type { AgentApprovalDecision } from '@/shared/sources'

import {
  createAgentRunActivityAccumulator,
  foldAgentRunActivityEvent,
  foldAgentRunActivityEvents,
  mergeAgentToolEvent,
  reduceAgentContextState,
  reduceAgentRunEvents,
  snapshotAgentRunActivity,
  type AgentRunActivity,
  type AgentRunActivityAccumulator,
  type DisplayAgentToolCall,
  type DisplayAgentToolStatus,
  type ReducedAgentRunEvents,
} from './agentRunActivity'
import { buildAgentRunContext } from './agentRunContext'
import type { MentionedAgent, MentionedItem } from './agentMentions'
import { plainTextFromMarkdown } from './agentTextUtils'
import { persistThinkingLevel, storedThinkingLevel } from './agentThinkingLevel'
import {
  applyShellApprovalEvent,
  reducePendingShellApprovals,
  type PendingShellApproval,
} from './agentShellApprovals'

export { mergeAgentToolEvent, reduceAgentRunEvents } from './agentRunActivity'
export type {
  AgentRunActivity,
  DisplayAgentToolCall,
  DisplayAgentToolStatus,
  ReducedAgentRunEvents,
} from './agentRunActivity'

export interface DisplayAgentMessage extends AgentMessage {
  streaming?: boolean
  /** 展示用：发送时 @ 点名的本机 Agent 名字，不落库，重载后消失。 */
  referencedAgentNames?: string[]
  /** 展示用：发送时 @ 的全部条目（含 Room/文件/对话记录），供消息区点击跳转；不落库。 */
  mentions?: MentionedItem[]
}

export function mergePendingAgentMessages(
  messages: DisplayAgentMessage[],
  pendingMessages: DisplayAgentMessage[],
): DisplayAgentMessage[] {
  if (pendingMessages.length === 0) return messages
  return [...messages, ...pendingMessages.filter((message) => !messages.some((existing) => (
    existing.id === message.id
    || (existing.runId === message.runId && existing.role === message.role && existing.content === message.content)
  )))]
}

export function removeAgentRunMessages(
  messages: DisplayAgentMessage[],
  runId: string,
): DisplayAgentMessage[] {
  return messages.filter((message) => message.runId !== runId)
}

/** run 进行中提交的消息：冻结发送参数排队，run 终态后由 flush effect 逐条发出。 */
export interface QueuedAgentSubmission {
  id: string
  prompt: string
  /** 排队时所属会话：允许运行中切会话后，不能把 A 的排队消息发进 B。 */
  sessionId?: string | null
  /** 用户可见文案（技术指令排队时保留人话气泡）。 */
  displayPrompt?: string
  selectedText?: string
  selectedRoomId?: string
  activeDocument?: AgentActiveDocumentContext | null
  attachments?: AgentFileAttachment[]
  referencedConversationId?: string
  mentionedAgents?: MentionedAgent[]
  mentions?: MentionedItem[]
}

const SESSION_KEY_BASE = 'nxcore-ce:agent-session'
const SESSION_KEY_VERSION = 2
/** 流式事件合并节拍：10fps 足够顺滑，同时把长对话的渲染负载压下来。 */
const AGENT_EVENT_FLUSH_MS = 100
const MODEL_PREFERENCE_STORAGE_KEY = 'nxcore-ce:agent-model-preference:v1'

function readStoredModelPreference(): AgentModelPreference {
  try {
    const raw = localStorage.getItem(MODEL_PREFERENCE_STORAGE_KEY)
    return raw === 'primary' || raw === 'lite' ? raw : 'smart'
  } catch {
    return 'smart'
  }
}

function persistModelPreference(tier: AgentModelPreference): void {
  try {
    localStorage.setItem(MODEL_PREFERENCE_STORAGE_KEY, tier)
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
}

const CHANNEL_PREFERENCE_STORAGE_KEY = 'nxcore-ce:agent-channel-preference:v1'

function readStoredChannelAgentId(): string | null {
  try {
    return localStorage.getItem(CHANNEL_PREFERENCE_STORAGE_KEY) || null
  } catch {
    return null
  }
}

function persistChannelAgentId(agentId: string | null): void {
  try {
    if (agentId) localStorage.setItem(CHANNEL_PREFERENCE_STORAGE_KEY, agentId)
    else localStorage.removeItem(CHANNEL_PREFERENCE_STORAGE_KEY)
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
}
// pre-v2 世代用复数 key 存 per-page map（keyBase 不同，框架走不到），
// 认领时框架外兜底一次：取任一会话 id 作为当前选择。
const LEGACY_SESSION_STORAGE_KEY = 'nxcore-ce:agent-sessions:v1'

function isUserSession(session: AgentSession): boolean {
  return session.pageLabel !== 'Remote Agent'
    && !session.pageLabel.startsWith('AI ')
}

function sessionScope(_pageLabel?: string, _roomId?: string | null): string {
  return 'global'
}

function createSessionStore() {
  return createVersionedLocalStorageStore<string>({
    keyBase: SESSION_KEY_BASE,
    version: SESSION_KEY_VERSION,
    adoptBaseline: () => '',
    fallback: '',
    migrations: [],
  })
}

function readLegacySession(): string | null {
  try {
    const legacy = localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)
    if (!legacy) return null
    const value: unknown = JSON.parse(legacy)
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.global === 'string') return record.global
    return Object.values(record).find((sessionId): sessionId is string => typeof sessionId === 'string') ?? null
  } catch {
    return null
  }
}

function readStoredSession(): string | null {
  try {
    const stored = createSessionStore().get()
    return stored || readLegacySession()
  } catch {
    return null
  }
}

function storeSession(sessionId: string | null): void {
  try {
    const store = createSessionStore()
    if (sessionId) store.set(sessionId)
    else store.clear()
  } catch {
    // Session persistence is optional when browser storage is unavailable.
  }
}

function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** 网关兜底标题 = run.accepted prompt 截 48 字（与网关 service 同源）；仅当权威标题仍等于兜底值才允许 AI 替换。 */
export function isAutoFallbackTitle(serverTitle: string | null | undefined, acceptedPrompt: string): boolean {
  return serverTitle?.trim() === acceptedPrompt.slice(0, 48).trim()
}

export interface UseAgentSessionOptions {
  /** 工作区工作台：会话清单按 workspaceId 过滤，新建会话归属该工作区。 */
  workspaceId?: string | null
  /**
   * 初始选中会话：
   * - undefined = 沿用原有行为（本地记忆 → 第一条）
   * - null = 草稿态（不自动选会话）
   * - string = 选中该会话
   */
  initialSessionId?: string | null
  /**
   * 会话分区键（缺省 = pageLabel）。停靠栏按文件隔离会话时应传文件的稳定 id：
   * 文件重命名、同名、超长（网关 pageLabel 上限 120）都不会把历史落进另一个分区。
   * pageLabel 只作为「当前页面」展示/运行时上下文，不参与分区。
   */
  sessionKey?: string
}

export function useAgentSession(
  pageLabel: string,
  roomId: string | null,
  rooms: AgentRoomReference[],
  options: UseAgentSessionOptions = {},
) {
  const { locale, t } = useLocale()
  const api = window.nxcore?.agent
  const workspaceId = options.workspaceId ?? null
  const workspaceIdRef = useRef<string | null>(workspaceId)
  workspaceIdRef.current = workspaceId
  /** 会话读写的分区键：停靠栏 = 文件稳定 id；工作台 = workspaceId（缺省回退 pageLabel）。 */
  const sessionKey = options.sessionKey || pageLabel
  /** 只在挂载时生效：之后切会话由工作台调用 selectSessionById。 */
  const initialSessionIdRef = useRef<string | null | undefined>(options.initialSessionId)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [currentSession, setCurrentSession] = useState<AgentSession | null>(null)
  const [sessionLinks, setSessionLinks] = useState<AgentSessionLink[]>([])
  const [messages, setMessages] = useState<DisplayAgentMessage[]>([])
  const [toolCallsByRun, setToolCallsByRun] = useState<Record<string, DisplayAgentToolCall[]>>({})
  const [activityByRun, setActivityByRun] = useState<Record<string, AgentRunActivity>>({})
  const [runStartedAtByRun, setRunStartedAtByRun] = useState<Record<string, string>>({})
  const [runCompletedAtByRun, setRunCompletedAtByRun] = useState<Record<string, string>>({})
  const [reasoningByRun, setReasoningByRun] = useState<Record<string, string>>({})
  const [agentIdByRun, setAgentIdByRun] = useState<Record<string, string>>({})
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [scopeReady, setScopeReady] = useState(false)
  const [displayTitle, setDisplayTitle] = useState('')
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 用户主动停止的 run：卡片据此显示真实终态，不再永远「生成中…」。 */
  const [cancelledRunIds, setCancelledRunIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** 网关重启/异常中断的 run（有 run.interrupted、无 run.completed）：同上。 */
  const [interruptedRunIds, setInterruptedRunIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** 停止后的中性回执（不伪装成错误），由 AgentPanel 以 info toast 展示。 */
  const [runNotice, setRunNotice] = useState<{ id: string; message: string } | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<PendingShellApproval[]>([])
  const [resolvingApprovalIds, setResolvingApprovalIds] = useState<Set<string>>(() => new Set())
  /** 实时上下文用量 + 压缩中标记（context.usage / context.compaction 事件折叠）。 */
  const [contextUsage, setContextUsage] = useState<AgentContextUsage | null>(null)
  const [contextCompacting, setContextCompacting] = useState(false)
  /** 会话权限模式（GET 初始化 + PUT 响应 + 适配器 current_mode_update 事件三来源折叠）。 */
  const [permissionModeState, setPermissionModeState] = useState<AgentPermissionModeState | null>(null)
  /** 待发队列：run 进行中提交的消息先排队，run 终态后自动逐条发出。 */
  const [queuedSubmissions, setQueuedSubmissions] = useState<QueuedAgentSubmission[]>([])
  /** 手动重试载体：失败后重拉会话清单/快照（变更即重跑引导 effect）。 */
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce((nonce) => nonce + 1), [])
  const sequenceByRun = useRef(new Map<string, number>())
  /** 每个 run 的活动折叠器：实时事件按 seq 增量折叠，不再全量重放历史事件。 */
  const activityAccByRun = useRef(new Map<string, AgentRunActivityAccumulator>())
  /**
   * 流式事件按 AGENT_EVENT_FLUSH_MS 节拍批量入 state：每个 delta 一次 IPC + 一次
   * React 渲染，工具多、对话长时事件风暴会把主线程打满（表现为对话区卡死、
   * 滚动冻结在半途）。合并后渲染频率上限 = 10 次/秒。
   */
  const pendingEventsRef = useRef<AgentEvent[]>([])
  const agentEventFlushRef = useRef<number | null>(null)
  const terminalRunIdsRef = useRef(new Set<string>())
  const messageStartedRunIdsRef = useRef(new Set<string>())
  const sessionIdRef = useRef<string | null>(null)
  const activeScopeRef = useRef(sessionScope(pageLabel, roomId))
  /** AI 标题生成素材：runId → 网关脱敏后的用户 prompt（与兜底标题同源）。 */
  const userPromptByRun = useRef(new Map<string, string>())
  const assistantContentByRun = useRef(new Map<string, string>())
  /** 当前会话见过的全部 runId，用于判定「首个 run」才自动起标题。 */
  const sessionRunIds = useRef(new Set<string>())
  /** sessionId → 标题任务状态，防 socket 重放/断线恢复重复触发。 */
  const titleJobs = useRef(new Map<string, 'inflight' | 'done'>())
  const generateTitleRef = useRef<((sessionId: string, runId: string) => void) | null>(null)
  /** flush effect 互斥：防 StrictMode 双跑/依赖重触发时重复出队同一条。 */
  const queueFlushInFlightRef = useRef(false)
  const localeRef = useRef(locale)
  localeRef.current = locale
  /** applyEvent 是非 memo 事件处理器；t 走 ref，避免把 t 塞进依赖导致重订阅。 */
  const translateRef = useRef(t)
  translateRef.current = t

  const updateToolCall = useCallback((event: AgentEvent) => {
    setToolCallsByRun((current) => {
      const tools = current[event.runId] ?? []
      const next = mergeAgentToolEvent(tools, event)
      return next === tools ? current : { ...current, [event.runId]: next }
    })
  }, [])

  // 聊天入口导出：document_export 返回 awaiting_auth 时自动拉起本地授权流程，
  // 与"···"菜单导出面板的行为一致（方案 §6.4 两入口同一链路）。
  const autoStartExportAuth = useCallback((event: AgentEvent) => {
    const payload = event.payload as { name?: unknown; result?: unknown }
    if (payload.name !== 'document_export') return
    let summary: unknown = payload.result
    if (typeof summary === 'string') {
      try {
        summary = JSON.parse(summary)
      } catch {
        return
      }
    }
    if (!summary || typeof summary !== 'object') return
    const view = summary as {
      status?: unknown
      runId?: unknown
      documentId?: unknown
      roomId?: unknown
      provider?: unknown
      mode?: unknown
      challenge?: { provider?: unknown; phase?: unknown }
    }
    // 参数缺失：弹出对应文档的导出面板让用户补齐（方案 §6.4）。
    if (view.status === 'needs_input' && typeof view.documentId === 'string') {
      window.dispatchEvent(new CustomEvent('everroom:open-export-panel', {
        detail: { documentId: view.documentId, provider: view.provider },
      }))
      return
    }
    if (view.status !== 'awaiting_auth' || !view.challenge) return
    const provider = view.challenge.provider === 'notion' ? 'notion' : 'feishu'
    const phase = view.challenge.phase === 'app_setup' ? 'app_setup' : 'user_auth'
    const exportRunId = typeof view.runId === 'string' ? view.runId : undefined
    void window.nxcore?.agentAuth.start({ provider, phase, exportRunId }).catch(() => undefined)
  }, [])

  const applyEvent = useCallback((event: AgentEvent) => {
    const lastSequence = sequenceByRun.current.get(event.runId) ?? 0
    if (event.seq <= lastSequence) return
    sequenceByRun.current.set(event.runId, event.seq)
    let acc = activityAccByRun.current.get(event.runId)
    if (!acc) {
      acc = createAgentRunActivityAccumulator()
      activityAccByRun.current.set(event.runId, acc)
    }
    if (foldAgentRunActivityEvent(acc, event)) {
      const snapshot = snapshotAgentRunActivity(acc)
      setActivityByRun((current) => current[event.runId] === snapshot
        ? current
        : { ...current, [event.runId]: snapshot })
    }

    if (event.type === 'approval.requested' || event.type === 'approval.resolved') {
      setPendingApprovals((current) => applyShellApprovalEvent(current, event))
      return
    }

    // 适配器侧模式变更（CLI /permission-mode 等）：并入当前状态；PUT 切换不走事件（直接用响应）。
    if (event.type === 'session.permission_mode.updated') {
      const mode = (event.payload as { permissionMode?: unknown }).permissionMode
      if (typeof mode === 'string') {
        setPermissionModeState((current) => current && current.mode !== mode
          ? { ...current, mode: mode as AgentPermissionMode }
          : current)
      }
      return
    }

    if (event.type === 'context.usage' || event.type === 'context.compaction') {
      const next = reduceAgentContextState([event])
      if (event.type === 'context.usage') setContextUsage(next.usage)
      else setContextCompacting(next.compacting)
      return
    }

    if (event.type === 'run.accepted' || event.type === 'run.started') {
      if (event.type === 'run.accepted') {
        sessionRunIds.current.add(event.runId)
        const prompt = (event.payload as { prompt?: unknown }).prompt
        if (typeof prompt === 'string' && prompt.trim()) {
          // 技术指令入口（卡片/AI 修改）的事件 prompt 是内部指令，展示素材由 sendPrompt 写入
          // （displayMessage），这里只在没有更优值时兜底，避免把机器语言写进标题素材。
          if (!userPromptByRun.current.has(event.runId)) userPromptByRun.current.set(event.runId, prompt)
          setMessages((current) => {
            const existing = current.find((message) =>
              message.role === 'user'
              && (
                message.runId === event.runId
                || (message.runId === 'pending' && message.content === prompt)
              )
            )
              // displayPrompt 场景：乐观消息 content 是人话，与事件 prompt 不同；
              // 认领在途的 pending 气泡，绝不再把内部指令渲染成第二个用户气泡。
              ?? current.find((message) => message.role === 'user' && message.runId === 'pending')

            if (existing) {
              return current
                .filter((message) => message.id === existing.id || !(
                  message.id !== existing.id
                  && message.role === 'user'
                  && (message.content === prompt || message.content === existing.content)
                  && (message.runId === 'pending' || message.runId === event.runId)
                ))
                .map((message) => message.id === existing.id
                  ? { ...message, sessionId: event.sessionId, runId: event.runId }
                  : message
                )
            }

            return [...current, {
              id: `user-${event.runId}`,
              sessionId: event.sessionId,
              runId: event.runId,
              role: 'user',
              authorAgentId: null,
              content: prompt,
              createdAt: event.occurredAt,
            }]
          })
        }
      }
      setActiveRunId(event.runId)
      setRunStartedAtByRun((current) => current[event.runId]
        ? current
        : { ...current, [event.runId]: event.occurredAt })
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status: 'running' }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status: 'running' }
        : current)
      return
    }
    if (
      event.type === 'tool.requested' ||
      event.type === 'tool.started' ||
      event.type === 'tool.updated' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed'
    ) {
      updateToolCall(event)
      if (event.type === 'tool.completed') autoStartExportAuth(event)
      return
    }
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') setReasoningByRun((current) => ({
        ...current,
        [event.runId]: (current[event.runId] ?? '') + delta,
      }))
      return
    }
    if (event.type === 'message.started') {
      // 正文首现时创建流式消息；run 中途再次出现则说明运行时丢弃了上一波
      // 半截输出、从头重新生成（pi 自动重试，#199）——清空累计防止重复拼接。
      // 首个 message.started 不清 reasoning：a2a/cli 的思考可能先于它到达。
      const restarted = messageStartedRunIdsRef.current.has(event.runId)
      messageStartedRunIdsRef.current.add(event.runId)
      if (restarted) {
        setReasoningByRun((current) => {
          if (!(event.runId in current)) return current
          const { [event.runId]: _discarded, ...rest } = current
          return rest
        })
      }
      setMessages((current) => current.some((message) => message.id === `stream-${event.runId}`)
        ? current.map((message) => message.id === `stream-${event.runId}`
          ? { ...message, content: '', streaming: true }
          : message)
        : [...current, {
          id: `stream-${event.runId}`,
          sessionId: event.sessionId,
          runId: event.runId,
          role: 'assistant',
          content: '',
          createdAt: event.occurredAt,
          streaming: true,
        }])
      return
    }
    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta !== 'string') return
      setMessages((current) => {
        const id = `stream-${event.runId}`
        const existing = current.find((message) => message.id === id)
        if (!existing) {
          return [...current, {
            id,
            sessionId: event.sessionId,
            runId: event.runId,
            role: 'assistant',
            content: delta,
            createdAt: event.occurredAt,
            streaming: true,
          }]
        }
        return current.map((message) => message.id === id
          ? { ...message, content: message.content + delta }
          : message)
      })
      return
    }
    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      if (typeof content === 'string') assistantContentByRun.current.set(event.runId, content)
      setMessages((current) => {
        const streamId = `stream-${event.runId}`
        const existing = current.find((message) => message.id === streamId)
        if (!existing && typeof content === 'string') {
          return [...current, {
            id: streamId,
            sessionId: event.sessionId,
            runId: event.runId,
            role: 'assistant',
            content,
            createdAt: event.occurredAt,
            streaming: false,
          }]
        }
        return current.map((message) => message.id === streamId
          ? { ...message, content: typeof content === 'string' ? content : message.content, streaming: false }
          : message)
      })
      return
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      terminalRunIdsRef.current.add(event.runId)
      // 停止/中断是终态但曾长期只清 activeRun：卡片会永远停在「生成中…」。
      // 记下 runId 供卡片显示「已停止/已中断」，并给一句中性回执。
      if (event.type === 'run.cancelled') {
        setCancelledRunIds((current) => current.has(event.runId) ? current : new Set(current).add(event.runId))
        setRunNotice({
          id: event.runId,
          message: translateRef.current('surface:agentChat.slidesStoppedNotice'),
        })
      } else if (event.type === 'run.interrupted') {
        setInterruptedRunIds((current) => current.has(event.runId) ? current : new Set(current).add(event.runId))
      }
      setActiveRunId((current) => current === event.runId ? null : current)
      setMessages((current) => current.map((message) => message.runId === event.runId && message.streaming
        ? { ...message, streaming: false }
        : message))
      setRunCompletedAtByRun((current) => ({ ...current, [event.runId]: event.occurredAt }))
      setToolCallsByRun((current) => {
        const tools = current[event.runId]
        if (!tools || event.type === 'run.completed') return current
        const status: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
        return {
          ...current,
          [event.runId]: tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
            ? { ...tool, status, completedAt: event.occurredAt }
            : tool),
        }
      })
      const status = event.type === 'run.interrupted' ? 'interrupted' : 'idle'
      setContextCompacting(false)
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status, updatedAt: event.occurredAt }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status, updatedAt: event.occurredAt }
        : current)
      if (event.type === 'run.completed' && event.sessionId === sessionIdRef.current) {
        generateTitleRef.current?.(event.sessionId, event.runId)
      }
      if (event.type === 'run.failed') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : t('surface:useAgentSession.runFailed'))
      } else if (event.type === 'run.interrupted') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : t('surface:useAgentSession.runInterrupted'))
      }
    }
  }, [updateToolCall])

  /**
   * 把队列里积压的事件一次性应用掉；流式 delta 每 100ms 合并成一拍——
   * 文本流 10fps 足够顺滑，工具状态变化最多延迟一拍，渲染负载降一个量级。
   */
  const flushQueuedAgentEvents = useCallback(() => {
    agentEventFlushRef.current = null
    const queued = pendingEventsRef.current
    if (!queued.length) return
    pendingEventsRef.current = []
    const currentSessionId = sessionIdRef.current
    for (const event of queued) {
      if (event.sessionId !== currentSessionId) continue
      applyEvent(event)
    }
  }, [applyEvent])

  const scheduleAgentEventFlush = useCallback(() => {
    if (agentEventFlushRef.current !== null) return
    agentEventFlushRef.current = window.setTimeout(flushQueuedAgentEvents, AGENT_EVENT_FLUSH_MS)
  }, [flushQueuedAgentEvents])

  const hydrateSnapshot = useCallback(async (
    snapshot: AgentSessionSnapshot,
    pendingMessages: DisplayAgentMessage[] = [],
    expectedScope = activeScopeRef.current,
  ) => {
    if (expectedScope !== activeScopeRef.current || snapshot.session.id !== sessionIdRef.current) return false
    sequenceByRun.current.clear()
    activityAccByRun.current.clear()
    terminalRunIdsRef.current.clear()
    userPromptByRun.current.clear()
    assistantContentByRun.current.clear()
    sessionRunIds.current.clear()
    const runIds = [...new Set([
      ...snapshot.messages.map((message) => message.runId),
      ...(snapshot.activeRun ? [snapshot.activeRun.id] : []),
    ].filter((runId) => runId && runId !== 'pending'))]
    for (const runId of runIds) sessionRunIds.current.add(runId)
    const eventGroups = api
      ? await Promise.all(runIds.map(async (runId) => ({
        runId,
        events: await api.getEvents(snapshot.session.id, runId, 0),
      })))
      : []
    const nextSessionLinks = api ? await api.listSessionLinks(snapshot.session.id) : []
    const nextPermissionMode = api
      ? await api.getPermissionMode(snapshot.session.id).catch(() => null)
      : null
    const nextTools: Record<string, DisplayAgentToolCall[]> = {}
    const nextActivity: Record<string, AgentRunActivity> = {}
    const nextReasoning: Record<string, string> = {}
    const nextStartedAt: Record<string, string> = {}
    const nextCompletedAt: Record<string, string> = {}
    const nextAgentIdByRun: Record<string, string> = {}
    const nextApprovals: PendingShellApproval[] = []
    const nextCancelledRunIds = new Set<string>()
    const nextInterruptedRunIds = new Set<string>()
    const reducedByRun = new Map<string, ReducedAgentRunEvents>()
    for (const group of eventGroups) {
      const reduced = reduceAgentRunEvents(group.events)
      const savedAnswer = snapshot.messages.find((message) => (
        message.runId === group.runId && message.role === 'assistant'
      ))?.content ?? ''
      // 重放历史事件：有终态中断/停止且没有完成，就恢复卡片真实终态（live 之外的第二来源）。
      const hasCompleted = group.events.some((event) => event.type === 'run.completed')
      if (!hasCompleted && group.events.some((event) => event.type === 'run.cancelled')) {
        nextCancelledRunIds.add(group.runId)
      }
      if (!hasCompleted && group.events.some((event) => event.type === 'run.interrupted')) {
        nextInterruptedRunIds.add(group.runId)
      }
      reducedByRun.set(group.runId, reduced)
      sequenceByRun.current.set(group.runId, reduced.lastSequence)
      const acc = createAgentRunActivityAccumulator(savedAnswer)
      foldAgentRunActivityEvents(acc, group.events)
      activityAccByRun.current.set(group.runId, acc)
      nextActivity[group.runId] = snapshotAgentRunActivity(acc)
      if (reduced.tools.length) nextTools[group.runId] = reduced.tools
      if (reduced.reasoning) nextReasoning[group.runId] = reduced.reasoning
      if (reduced.startedAt) nextStartedAt[group.runId] = reduced.startedAt
      if (reduced.completedAt) nextCompletedAt[group.runId] = reduced.completedAt
      nextApprovals.push(...reducePendingShellApprovals(group.events))
    }
    // 会话级上下文状态跨 run 折叠（occurredAt 排序见 reducer）。
    const contextState = reduceAgentContextState(eventGroups.flatMap((group) => group.events))
    for (const message of snapshot.messages) {
      if (message.authorAgentId) nextAgentIdByRun[message.runId] = message.authorAgentId
    }
    if (snapshot.activeRun?.agentId) nextAgentIdByRun[snapshot.activeRun.id] = snapshot.activeRun.agentId
    if (snapshot.activeRun?.startedAt) nextStartedAt[snapshot.activeRun.id] = snapshot.activeRun.startedAt

    if (expectedScope !== activeScopeRef.current || snapshot.session.id !== sessionIdRef.current) return false

    const nextMessages = mergePendingAgentMessages(snapshot.messages, pendingMessages)
    if (snapshot.activeRun) {
      const reduced = reducedByRun.get(snapshot.activeRun.id)
      const hasAssistant = nextMessages.some((message) => (
        message.runId === snapshot.activeRun?.id && message.role === 'assistant'
      ))
      if (!hasAssistant && reduced && (reduced.messageStarted || reduced.streamingContent)) {
        nextMessages.push({
          id: `stream-${snapshot.activeRun.id}`,
          sessionId: snapshot.session.id,
          runId: snapshot.activeRun.id,
          role: 'assistant',
          content: reduced.streamingContent,
          createdAt: reduced.startedAt ?? snapshot.activeRun.createdAt,
          streaming: !reduced.messageCompleted,
        })
      }
    }

    setMessages(nextMessages)
    setSessionLinks(nextSessionLinks)
    setToolCallsByRun(nextTools)
    setActivityByRun(nextActivity)
    setReasoningByRun(nextReasoning)
    setAgentIdByRun(nextAgentIdByRun)
    setRunStartedAtByRun(nextStartedAt)
    setRunCompletedAtByRun(nextCompletedAt)
    setPendingApprovals(nextApprovals)
    setResolvingApprovalIds(new Set())
    setCancelledRunIds(nextCancelledRunIds)
    setInterruptedRunIds(nextInterruptedRunIds)
    setRunNotice(null)
    setContextUsage(contextState.usage)
    setContextCompacting(contextState.compacting)
    setPermissionModeState(nextPermissionMode)
    setActiveRunId(snapshot.activeRun?.id ?? null)
    setSessionId(snapshot.session.id)
    setCurrentSession(snapshot.session)
    const title = snapshot.session.title?.trim() || t('surface:useAgentSession.newConversation')
    setDisplayTitle(title)
    setScopeReady(true)
    setSessions((current) => current.some((session) => session.id === snapshot.session.id)
      ? current.map((session) => session.id === snapshot.session.id ? snapshot.session : session)
      : [snapshot.session, ...current])
    sessionIdRef.current = snapshot.session.id
    channelAgentRef.current = snapshot.session.channelAgentId ?? null
    storeSession(snapshot.session.id)
    return true
  }, [api])

  const selectSession = useCallback(async (
    session: AgentSession,
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<void> => {
    if (!api) return
    const expectedScope = sessionScope(pageLabel, roomId)
    setLoading(true)
    setScopeReady(false)
    setError(null)
    setSessionId(session.id)
    setCurrentSession(session)
    setDisplayTitle(session.title?.trim() || t('surface:useAgentSession.newConversation'))
    sessionIdRef.current = session.id
    channelAgentRef.current = session.channelAgentId ?? null
    try {
      await api.unsubscribe()
      const snapshot = await api.getSession(session.id)
      const hydrated = await hydrateSnapshot(snapshot, pendingMessages, expectedScope)
      if (!hydrated || expectedScope !== activeScopeRef.current) return
      storeSession(session.id)
      await api.subscribe(session.id)
    } catch (requestError) {
      if (expectedScope === activeScopeRef.current && session.id === sessionIdRef.current) {
        setConnected(false)
        setScopeReady(true)
        setError(requestErrorMessage(requestError, t('surface:useAgentSession.switchFailed')))
      }
    } finally {
      if (expectedScope === activeScopeRef.current && session.id === sessionIdRef.current) setLoading(false)
    }
  }, [api, hydrateSnapshot])

  useLayoutEffect(() => {
    let alive = true
    activeScopeRef.current = sessionScope(pageLabel, roomId)
    setScopeReady(false)
    setMessages([])
    setToolCallsByRun({})
    setActivityByRun({})
    setRunStartedAtByRun({})
    setRunCompletedAtByRun({})
    setReasoningByRun({})
    setAgentIdByRun({})
    setPendingApprovals([])
    setResolvingApprovalIds(new Set())
    setContextUsage(null)
    setContextCompacting(false)
    setPermissionModeState(null)
    setQueuedSubmissions([])
    setActiveRunId(null)
    setSessionId(null)
    setSessions([])
    setSessionLinks([])
    sessionIdRef.current = null
    channelAgentRef.current = null
    sequenceByRun.current.clear()
    activityAccByRun.current.clear()
    userPromptByRun.current.clear()
    assistantContentByRun.current.clear()
    sessionRunIds.current.clear()
    setError(null)
    setCancelledRunIds(new Set())
    setInterruptedRunIds(new Set())
    setRunNotice(null)

    if (api) {
      setLoading(true)
      // 停靠栏按 sessionKey（文件稳定 id）列会话，只看到本文件的会话；工作台
      // （workspaceId）模式下列出全部会话再按工作区过滤——工作区是会话分区键，
      // pageLabel 只是最后出现的界面。
      void api.listSessions(workspaceId ? undefined : sessionKey)
        .then(async (listedSessions) => {
          if (!alive) return
          const scoped = workspaceId
            ? listedSessions.filter((session) => session.workspaceId === workspaceId)
            : listedSessions
          const userSessions = scoped.filter(isUserSession)
          setSessions(userSessions)
          const requested = initialSessionIdRef.current
          const storedSessionId = readStoredSession()
          const wanted = requested !== undefined ? requested : storedSessionId
          // 显式传了 initialSessionId（工作台的会话视图）就严格按它选；未传（文件
          // 停靠栏）时「全局记住的会话」可能属于别的分区，找不到就回落到本分区最近
          // 一条，否则停靠栏会误停在草稿态、看不到本文件的对话记录。
          const selected = (wanted
            ? userSessions.find((session) => session.id === wanted)
            : undefined)
            ?? (requested === undefined ? userSessions[0] : undefined)
          if (selected) await selectSession(selected)
          else if (alive) {
            // 无历史会话：停在草稿态（不建会话），首条消息发出时才创建——
            // 避免空会话把档位/渠道在用户尚未选择时就锁死。
            setDisplayTitle(t('surface:useAgentSession.newConversation'))
            setScopeReady(true)
          }
        })
        .catch((requestError) => {
          if (alive) {
            setConnected(false)
            setScopeReady(true)
          }
          if (alive) setError(requestError instanceof Error ? requestError.message : t('surface:useAgentSession.loadFailed'))
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    } else {
      setScopeReady(true)
    }

    const removeListener = api?.onEvent((frame) => {
      const frameSessionId = frame.type === 'ready' ? frame.sessionId : frame.event.sessionId
      if (!alive || frameSessionId !== sessionIdRef.current) return
      if (frame.type === 'ready') {
        setConnected(true)
        if (frame.lastEventSeq > 0) {
          void api.getSession(frame.sessionId).then(hydrateSnapshot).catch((requestError) => {
            setError(requestError instanceof Error ? requestError.message : t('surface:useAgentSession.restoreFailed'))
          })
        }
      } else {
        pendingEventsRef.current.push(frame.event)
        scheduleAgentEventFlush()
      }
    })

    return () => {
      alive = false
      removeListener?.()
      if (agentEventFlushRef.current !== null) {
        window.clearTimeout(agentEventFlushRef.current)
      }
      agentEventFlushRef.current = null
      pendingEventsRef.current = []
      void api?.unsubscribe()
    }
  }, [api, applyEvent, hydrateSnapshot, reloadNonce, selectSession, scheduleAgentEventFlush, sessionKey, workspaceId])

  // 全局默认档位：新会话创建时锁定到 session.activeAgentId（后端权威）。
  // 切换只影响下一个新会话，进行中的会话档位以 currentSession.modelPreference 为准。
  const [modelPreferenceDefault, setModelPreferenceDefaultState] = useState<AgentModelPreference>(readStoredModelPreference)
  const modelPreferenceRef = useRef(modelPreferenceDefault)
  const setModelPreferenceDefault = useCallback((tier: AgentModelPreference) => {
    modelPreferenceRef.current = tier
    setModelPreferenceDefaultState(tier)
    persistModelPreference(tier)
  }, [])

  // 全局默认思考档位：只决定「下次新建会话」的默认值（null=跟随模型配置）；
  // 已有会话以 currentSession.thinkingLevel 为准，切换走 setSessionThinkingLevel。
  const [thinkingLevelDefault, setThinkingLevelDefaultState] = useState<AgentThinkingLevel | null>(storedThinkingLevel)
  const thinkingLevelRef = useRef(thinkingLevelDefault)
  const setThinkingLevelDefault = useCallback((level: AgentThinkingLevel | null) => {
    thinkingLevelRef.current = level
    setThinkingLevelDefaultState(level)
    persistThinkingLevel(level)
  }, [])

  // 全局默认渠道：新会话整体锁定到某个本机 CLI Agent（ACP 持久会话连续对话）。
  const [channelAgentIdDefault, setChannelAgentIdDefaultState] = useState<string | null>(readStoredChannelAgentId)
  const channelAgentDefaultRef = useRef(channelAgentIdDefault)
  const setChannelAgentIdDefault = useCallback((agentId: string | null) => {
    channelAgentDefaultRef.current = agentId
    setChannelAgentIdDefaultState(agentId)
    persistChannelAgentId(agentId)
  }, [])
  // 当前会话锁定的渠道（selectSession/hydrate 时镜像）；渠道会话每轮
  // startRun 都要显式带 targetAgentId，桌面端 main 才会重建 localAgent。
  const channelAgentRef = useRef<string | null>(null)

  const createSession = async (
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<AgentSession> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    if (activeRunId) throw new Error(t('surface:useAgentSession.stopBeforeCreating'))
    try {
      const session = await api.createSession({
        // 分区键必须与 listSessions 一致：停靠栏按 sessionKey（文件稳定 id）列会话，
        // 建会话若写死 'Agent' 或写成随文件改名的显示名，它永远列不出自己刚建的会话
        // （离开再回来即丢失）。pageLabel 只用于「当前页面」上下文。
        pageLabel: sessionKey,
        roomId: null,
        ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
        // 渠道优先：锁定后整个会话由该 CLI Agent 连续执行，档位被忽略。
        ...(channelAgentDefaultRef.current
          ? { channelAgentId: channelAgentDefaultRef.current }
          : { modelPreference: modelPreferenceRef.current }),
        // 思考档位不锁定会话：显式发 null 表示「跟随模型配置」，创建后仍可 PUT 修改。
        thinkingLevel: thinkingLevelRef.current ?? null,
      })
      setSessions((current) => [session, ...current])
      await selectSession(session, pendingMessages)
      return session
    } catch (createError) {
      setError(requestErrorMessage(createError, t('surface:useAgentSession.createFailed')))
      throw createError
    }
  }

  /** 新建对话＝回到草稿态：不建会话，首条消息发出时（ensureSession）才用当前档位/渠道默认创建。 */
  const startNewConversation = useCallback(async (): Promise<void> => {
    if (activeRunId) throw new Error(t('surface:useAgentSession.stopBeforeCreating'))
    await api?.unsubscribe()
    setSessionId(null)
    sessionIdRef.current = null
    storeSession(null)
    setCurrentSession(null)
    setSessionLinks([])
    channelAgentRef.current = null
    setMessages([])
    setToolCallsByRun({})
    setActivityByRun({})
    setRunStartedAtByRun({})
    setRunCompletedAtByRun({})
    setReasoningByRun({})
    setAgentIdByRun({})
    setPendingApprovals([])
    setResolvingApprovalIds(new Set())
    setContextUsage(null)
    setContextCompacting(false)
    setPermissionModeState(null)
    setQueuedSubmissions([])
    setActiveRunId(null)
    setDisplayTitle(t('surface:useAgentSession.newConversation'))
    sequenceByRun.current.clear()
    userPromptByRun.current.clear()
    assistantContentByRun.current.clear()
    sessionRunIds.current.clear()
    setError(null)
    setCancelledRunIds(new Set())
    setInterruptedRunIds(new Set())
    setRunNotice(null)
  }, [activeRunId, api, t])

  const ensureSession = async (pendingMessages: DisplayAgentMessage[]): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current
    return (await createSession(pendingMessages)).id
  }

  const renameSession = async (
    sessionIdToRename: string,
    title: string,
    options?: { silent?: boolean },
  ): Promise<void> => {
    if (!api || !title.trim()) return
    try {
      const updated = await api.updateSession(sessionIdToRename, { title: title.trim() })
      setSessions((current) => current.map((session) => session.id === updated.id ? updated : session))
      setCurrentSession((current) => current?.id === updated.id ? updated : current)
      if (updated.id === sessionIdRef.current) {
        setDisplayTitle(updated.title?.trim() ?? '')
      }
    } catch (requestError) {
      if (options?.silent) return
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.renameFailed')))
      throw requestError
    }
  }

  // 会话首轮完成后自动起标题：网关兜底标题 = run.accepted 的 prompt 截 48 字
  // （与网关 service 同源），只有权威标题仍等于该兜底值（用户未改名）才替换。
  const maybeGenerateSessionTitle = (targetSessionId: string, runId: string): void => {
    if (!api) return
    if (titleJobs.current.has(targetSessionId)) return
    if (sessionRunIds.current.size !== 1 || !sessionRunIds.current.has(runId)) return
    const acceptedPrompt = userPromptByRun.current.get(runId)
    if (!acceptedPrompt?.trim()) return
    const assistantText = plainTextFromMarkdown(assistantContentByRun.current.get(runId) ?? '')
    if (!assistantText) return
    titleJobs.current.set(targetSessionId, 'inflight')
    void (async () => {
      try {
        const snapshot = await api.getSession(targetSessionId)
        if (!isAutoFallbackTitle(snapshot.session.title, acceptedPrompt)) return
        const { title } = await api.generateSessionTitle({
          sessionId: targetSessionId,
          userText: acceptedPrompt,
          assistantText,
          language: localeRef.current,
        })
        const clean = title?.trim().slice(0, 48).trim()
        if (!clean) return
        await renameSession(targetSessionId, clean, { silent: true })
      } catch {
        // 标题生成是锦上添花：任何失败都静默保留截断兜底标题。
      } finally {
        titleJobs.current.set(targetSessionId, 'done')
      }
    })()
  }
  generateTitleRef.current = maybeGenerateSessionTitle

  const deleteSession = async (session: AgentSession): Promise<void> => {
    if (!api || session.status === 'running' || (session.id === sessionId && activeRunId)) return
    try {
      await api.deleteSession(session.id)
      const remaining = sessions.filter((item) => item.id !== session.id)
      setSessions(remaining)
      if (session.id === sessionIdRef.current) {
        await api.unsubscribe()
        const next = remaining[0]
        if (next) await selectSession(next)
        else {
          sessionIdRef.current = null
          channelAgentRef.current = null
          setSessionId(null)
          setCurrentSession(null)
          setDisplayTitle(t('surface:useAgentSession.newConversation'))
          setScopeReady(false)
          setSessionLinks([])
          setMessages([])
          setToolCallsByRun({})
          setActivityByRun({})
          setReasoningByRun({})
          setPendingApprovals([])
          setResolvingApprovalIds(new Set())
          setCancelledRunIds(new Set())
          setInterruptedRunIds(new Set())
          setRunNotice(null)
          setRunStartedAtByRun({})
          setRunCompletedAtByRun({})
          activityAccByRun.current.clear()
          setQueuedSubmissions([])
          sequenceByRun.current.clear()
          setConnected(false)
          storeSession(null)
          try {
            await createSession()
          } catch {
            setScopeReady(true)
          }
        }
      }
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.deleteFailed')))
      throw requestError
    }
  }

  const selectSessionById = async (sessionIdToSelect: string): Promise<void> => {
    if (!api || sessionIdToSelect === sessionIdRef.current) return
    const listed = sessions.find((session) => session.id === sessionIdToSelect)
    if (listed) {
      await selectSession(listed)
      return
    }
    const snapshot = await api.getSession(sessionIdToSelect)
    await selectSession(snapshot.session)
  }

  const createSessionLink = async (input: CreateAgentSessionLinkInput): Promise<AgentSessionLink> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    try {
      const link = await api.createSessionLink(input)
      if (link.sourceSessionId === sessionIdRef.current || link.targetSessionId === sessionIdRef.current) {
        setSessionLinks((current) => current.some((item) => item.id === link.id) ? current : [...current, link])
      }
      return link
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.createReferenceFailed')))
      throw requestError
    }
  }

  const markSessionLinkReturned = async (linkId: string): Promise<AgentSessionLink> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    try {
      const link = await api.markSessionLinkReturned(linkId)
      setSessionLinks((current) => current.map((item) => item.id === link.id ? link : item))
      return link
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.returnFailed')))
      throw requestError
    }
  }

  const sendPrompt = async (
    prompt: string,
    selectedText?: string,
    selectedRoomId?: string,
    activeDocument?: AgentActiveDocumentContext | null,
    replaceRunId?: string,
    attachments?: AgentFileAttachment[],
    targetAgentId?: string,
    referencedConversationId?: string,
    mentionedAgents?: MentionedAgent[],
    mentions?: MentionedItem[],
    /** 用户可见文案：卡片按钮等入口的 prompt 是技术指令，气泡/会话标题用它。 */
    displayPrompt?: string,
  ): Promise<string | null> => {
    const message = prompt.trim()
    const displayPromptValue = displayPrompt?.trim() || undefined
    // 技术指令只进运行时；落库/气泡/标题一律用 displayPrompt（缺省＝用户原话）。
    const displayMessage = displayPromptValue ?? message
    if ((!message && !attachments?.length) || loading || sending) return null
    if (activeRunId) {
      // 重试（replaceRunId）不排队：replace 只对已终态 run 有意义，排队会丢失其语义。
      if (replaceRunId) return null
      setQueuedSubmissions((current) => [...current, {
        id: crypto.randomUUID(),
        sessionId: sessionIdRef.current,
        prompt: message,
        ...(displayPromptValue ? { displayPrompt: displayPromptValue } : {}),
        selectedText,
        selectedRoomId,
        activeDocument,
        attachments,
        referencedConversationId,
        mentionedAgents,
        mentions,
      }])
      return null
    }
    if (replaceRunId) {
      setMessages((current) => removeAgentRunMessages(current, replaceRunId))
      setToolCallsByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setActivityByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setRunStartedAtByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setRunCompletedAtByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setReasoningByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setAgentIdByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      activityAccByRun.current.delete(replaceRunId)
      sequenceByRun.current.delete(replaceRunId)
      terminalRunIdsRef.current.delete(replaceRunId)
    }
    const optimisticId = `user-${crypto.randomUUID()}`
    const optimisticMessage: DisplayAgentMessage = {
      id: optimisticId,
      sessionId: sessionIdRef.current ?? 'pending',
      runId: 'pending',
      role: 'user',
      authorAgentId: null,
      content: displayMessage,
      createdAt: new Date().toISOString(),
      ...(mentionedAgents?.length && !channelAgentRef.current
        ? { referencedAgentNames: mentionedAgents.map((agent) => agent.displayName) }
        : {}),
      ...(mentions?.length ? { mentions } : {}),
    }

    setMessages((current) => mergePendingAgentMessages(current, [optimisticMessage]))
    setSending(true)
    setError(null)
    try {
      const currentSessionId = await ensureSession([optimisticMessage])
      // 渠道会话整段锁定在本机 CLI Agent：每轮显式带 targetAgentId，
      // 桌面端 main 才会走 localAgent 重建（沙箱与工作区授权链路）。
      const channelLocked = Boolean(channelAgentRef.current)
      const selectedAgentId = targetAgentId ?? channelAgentRef.current ?? 'main'
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, sessionId: currentSessionId }
        : item))
      const run = await api!.startRun(currentSessionId, {
        prompt: message,
        idempotencyKey: crypto.randomUUID(),
        // 技术指令照旧进运行时；displayPrompt 仅供落库/展示（网关不把它给 runtime）。
        ...(displayPromptValue ? { displayPrompt: displayPromptValue } : {}),
        // 'main' 时省略 targetAgentId：档位锁定在会话上，由网关按 session.activeAgentId 选运行时。
        ...(selectedAgentId !== 'main' ? { targetAgentId: selectedAgentId } : {}),
        invocationMode: 'explicit_switch',
        ...(replaceRunId ? { replaceRunId } : {}),
        responseLanguage: locale,
        // 渠道会话下 @ 其他 Agent / 引用对话是主代理专属能力，网关会拒
        // （referenced_*_requires_main_agent）；UI 已隐藏入口，这里兜底剥离，
        // 覆盖重试、外部注入等绕过输入框的路径。
        context: buildAgentRunContext(
          rooms,
          selectedText,
          selectedRoomId,
          activeDocument,
          pageLabel,
          attachments,
          channelLocked ? undefined : referencedConversationId,
          channelLocked ? undefined : mentionedAgents?.map((agent) => agent.id),
        ),
      })
      const runAgentId = run.agentId ?? selectedAgentId
      // AI 起标题素材用展示文案（网关兜底标题同源），避免 technical prompt 泄进标题。
      userPromptByRun.current.set(run.id, displayMessage)
      setAgentIdByRun((current) => current[run.id] === runAgentId
        ? current
        : { ...current, [run.id]: runAgentId })
      const updatedAt = new Date().toISOString()
      const runCompleted = terminalRunIdsRef.current.has(run.id)
      setSessions((current) => current.map((session) => session.id === currentSessionId
        ? {
            ...session,
            title: session.title ?? displayMessage.slice(0, 48),
            ...(!runCompleted ? { status: 'running' as const } : {}),
            updatedAt,
          }
        : session))
      setCurrentSession((current) => current?.id === currentSessionId
        ? {
            ...current,
            activeAgentId: runAgentId,
            title: current.title ?? displayMessage.slice(0, 48),
            ...(!runCompleted ? { status: 'running' as const } : {}),
            updatedAt,
          }
        : current)
      const nextTitle = currentSession?.id === currentSessionId && currentSession.title?.trim()
        ? currentSession.title.trim()
        : displayMessage.slice(0, 48)
      setDisplayTitle(nextTitle)
      if (!runCompleted) {
        setActiveRunId(run.id)
        setReasoningByRun((current) => ({ ...current, [run.id]: '' }))
      }
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, runId: run.id }
        : item))
      return run.id
    } catch (requestError) {
      if (optimisticId) {
        setMessages((current) => current.filter((message) => message.id !== optimisticId))
      }
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.sendFailed')))
      throw requestError
    } finally {
      setSending(false)
    }
  }

  const sendPromptRef = useRef(sendPrompt)
  sendPromptRef.current = sendPrompt

  /**
   * 确定性入口（进度卡按钮、AI 修改、产物库建文件）：hiddenPrompt 只交给运行时，
   * displayText 存进会话并渲染成用户气泡。排队/重试语义与 sendPrompt 完全一致。
   */
  const sendAgentAction = async (hiddenPrompt: string, displayText: string): Promise<string | null> => (
    sendPrompt(
      hiddenPrompt,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      displayText,
    )
  )

  // 队列排空：run 终态（activeRunId 清空）且无进行中发送时出队一条发出；
  // 新 run 启动会再次置 activeRunId，天然串行——网关 startRun 对 running
  // 会话直接抛 agent_session_busy，绝不并发。
  useEffect(() => {
    if (queuedSubmissions.length === 0 || activeRunId || loading || sending) return
    if (queueFlushInFlightRef.current) return
    // 允许运行中切会话后，队列必须认会：A 会话的排队消息不能在 B 会话里发出。
    if (queuedSubmissions[0]?.sessionId && queuedSubmissions[0].sessionId !== sessionIdRef.current) return
    const [next, ...rest] = queuedSubmissions
    setQueuedSubmissions(rest)
    queueFlushInFlightRef.current = true
    void (async () => {
      try {
        await sendPromptRef.current(
          next.prompt,
          next.selectedText,
          next.selectedRoomId,
          next.activeDocument,
          undefined,
          next.attachments,
          undefined,
          next.referencedConversationId,
          next.mentionedAgents,
          next.mentions,
          next.displayPrompt,
        )
      } catch {
        // 失败已在 sendPrompt 内 setError；丢弃该条继续排后面的，避免卡队列。
      } finally {
        queueFlushInFlightRef.current = false
      }
    })()
  }, [queuedSubmissions, activeRunId, loading, sending, sessionId])

  const submitPendingIntent = async (
    intentId: string,
    selectedRoomId: string,
    documentId?: string,
  ): Promise<string | null> => {
    if (!api || loading || sending) return null
    // 决策卡的「等待输入」态：run 还挂着，但用户必须能作答。
    // 这里不再静默 return null（审查指出的「看起来能点、点了没反应」），
    // 而是把「仍在处理中」显性告诉用户——真的提交不了时至少知道原因。
    if (activeRunId) {
      setError(t('surface:useAgentSession.agentBusy'))
      return null
    }
    setSending(true)
    setError(null)
    try {
      const { run } = await api.submitPendingIntent(intentId, {
        roomId: selectedRoomId,
        ...(documentId ? { documentId } : {}),
        idempotencyKey: crypto.randomUUID(),
        responseLanguage: locale,
      })
      const runCompleted = terminalRunIdsRef.current.has(run.id)
      const updatedAt = new Date().toISOString()
      setSessions((current) => current.map((session) => session.id === run.sessionId
        ? { ...session, ...(!runCompleted ? { status: 'running' as const } : {}), updatedAt }
        : session))
      setCurrentSession((current) => current?.id === run.sessionId
        ? { ...current, ...(!runCompleted ? { status: 'running' as const } : {}), updatedAt }
        : current)
      if (!runCompleted) {
        setActiveRunId(run.id)
        setReasoningByRun((current) => ({ ...current, [run.id]: '' }))
      }
      return run.id
    } catch (requestError) {
      const message = requestErrorMessage(requestError, t('surface:useAgentSession.continueFailed'))
      setError(/no longer available/i.test(message)
        ? t('surface:useAgentSession.selectionExpired')
        : /not allowed/i.test(message)
          ? t('surface:useAgentSession.roomUnavailable')
          : /active run/i.test(message) ? t('surface:useAgentSession.agentBusy') : message)
      throw requestError
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!api || !activeRunId) return
    try {
      await api.cancelRun(activeRunId)
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.stopFailed')))
    }
  }

  const resolveApproval = async (
    approvalId: string,
    decision: AgentApprovalDecision,
    feedback?: string,
  ): Promise<void> => {
    if (!api || resolvingApprovalIds.has(approvalId)) return
    setResolvingApprovalIds((current) => new Set(current).add(approvalId))
    setError(null)
    try {
      await api.resolveApproval(approvalId, decision, feedback)
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.approvalFailed')))
      throw requestError
    } finally {
      setResolvingApprovalIds((current) => {
        const next = new Set(current)
        next.delete(approvalId)
        return next
      })
    }
  }

  /** 切换会话权限模式：PUT 后以 GET 回读为权威值（applied=false 表示 run 间隙仅落库）。 */
  const setSessionPermissionMode = useCallback(async (mode: AgentPermissionMode): Promise<boolean> => {
    const targetSessionId = sessionIdRef.current
    if (!api || !targetSessionId) return false
    setError(null)
    try {
      await api.setPermissionMode(targetSessionId, mode)
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.permissionModeUpdateFailed')))
      return false
    }
    const next = await api.getPermissionMode(targetSessionId).catch(() => null)
    if (next) setPermissionModeState(next)
    else setPermissionModeState((current) => current && current.mode !== mode ? { ...current, mode } : current)
    return true
  }, [api, t])

  const removeQueuedSubmission = useCallback((id: string): void => {
    setQueuedSubmissions((current) => current.filter((item) => item.id !== id))
  }, [])

  /**
   * 切换会话思考档位（null=跟随模型配置）。
   * - 任何一次选择都持久化为「下次新会话默认值」；
   * - 会话已存在：PUT 修改（网关从下一轮 run 生效），并用响应回读值更新
   *   currentSession / sessions 列表；失败只报错，不改本地值；
   * - 草稿态（无会话/无 API）：只改默认值，首条消息建会话时带上。
   */
  const setSessionThinkingLevel = useCallback(async (level: AgentThinkingLevel | null): Promise<boolean> => {
    setThinkingLevelDefault(level)
    const targetSessionId = sessionIdRef.current
    if (!api || !targetSessionId) return true
    setError(null)
    let next: AgentThinkingLevel | null = level
    try {
      const result = await api.setThinkingLevel(targetSessionId, level)
      next = result.thinkingLevel
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.thinkingLevelUpdateFailed')))
      return false
    }
    setCurrentSession((current) => current && current.id === targetSessionId
      ? { ...current, thinkingLevel: next }
      : current)
    setSessions((current) => current.map((session) => session.id === targetSessionId
      ? { ...session, thinkingLevel: next }
      : session))
    return true
  }, [api, setThinkingLevelDefault, t])

  return {
    activeRunId,
    agentIdByRun,
    activityByRun,
    connected,
    contextUsage,
    contextCompacting,
    createSession,
    createSessionLink,
    currentSession,
    deleteSession,
    displayTitle,
    error,
    loading: loading || sending,
    messages,
    modelPreferenceDefault,
    setModelPreferenceDefault,
    thinkingLevelDefault,
    setThinkingLevelDefault,
    setSessionThinkingLevel,
    channelAgentIdDefault,
    setChannelAgentIdDefault,
    pendingApprovals,
    permissionMode: permissionModeState?.mode ?? null,
    permissionModeAvailable: permissionModeState?.available ?? [],
    setSessionPermissionMode,
    queuedSubmissions,
    removeQueuedSubmission,
    reload,
    reasoningByRun,
    runCompletedAtByRun,
    runStartedAtByRun,
    scopeReady,
    renameSession,
    startNewConversation,
    resolveApproval,
    resolvingApprovalIds,
    cancelledRunIds,
    interruptedRunIds,
    runNotice,
    markSessionLinkReturned,
    selectSession,
    selectSessionById,
    sendAgentAction,
    sendPrompt,
    sessionId,
    sessionLinks,
    sessions,
    stop,
    submitPendingIntent,
    toolCallsByRun,
  }
}
