import { Check, ChevronRight, CircleHelp, Copy, FileText, Folder, FolderKanban, Link2, MessageSquareText, RotateCcw, X } from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import { AgentShellApproval } from './AgentShellApproval'
import { SlidesProgressCard, slidesProgressFromToolCall, type SlidesProgressState } from './SlidesProgressCard'
import { AgentAuthChallengeCard, useAgentAuthChallenge } from './AgentAuthChallengeCard'
import {
  AGENT_CHAT_REPIN_DISTANCE_PX,
  AGENT_CHAT_UNPIN_GRACE_MS,
  AGENT_CHAT_WHEEL_REPIN_DISTANCE_PX,
} from './agentChatScroll'
import type { PendingShellApproval } from './agentShellApprovals'
import type { AgentRunActivity } from './agentRunActivity'
import { parseAgentDocumentIntentResult, type AgentDocumentIntentResult } from './agentDocumentIntent'
import { parseAgentNavigationTarget } from './agentNavigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseAgentRoomSelectionResult } from './agentRoomSelection'
import { AgentDocumentPicker } from './AgentDocumentPicker'
import { useRoomDocumentsState } from '../context-room/RoomDocumentsProvider'
import { uiText } from '../context-room/ported/adapters'
import {
  findPendingAgentDocumentSelection,
  type AgentDocumentSelectionItem,
  type AgentDocumentSelectionSubmission,
} from './agentDocumentSelection'
import { useLinkedAgentRun, type LinkedAgentRunState } from './useLinkedAgentRun'
import type { DisplayAgentMessage, DisplayAgentToolCall } from './useAgentSession'
import type { MentionedItem } from './agentMentions'
import { modelPreferenceFromAgentId, type AgentNavigationTarget, type AgentRoomReference, type AgentSessionLink, type PendingAgentIntent, type RoomDocument } from '@nxcore/agent-contract'
import type { ActiveDocumentDescriptor } from './activeDocumentContext'
import type { AgentApprovalDecision } from '../../../../shared/sources'
import { writeTextToClipboard } from '../../lib/systemClipboard'
import { useLocale, type Translate } from '../../i18n/LocaleContext'
import { pageLabelKey } from '../../data/navigation'

const quickPrompts = [
  ['surface:agentChat.quickPromptSummarizeLabel', 'surface:agentChat.quickPromptSummarize'],
  ['surface:agentChat.quickPromptRisksLabel', 'surface:agentChat.quickPromptRisks'],
  ['surface:agentChat.quickPromptTasksLabel', 'surface:agentChat.quickPromptTasks'],
] as const

function ThinkingStatus({ label, tail }: { label: string; tail?: string }) {
  return (
    <div className="agent-thinking" role="status">
      <span className="agent-thinking-text" data-text={label}>{label}</span>
      {tail ? <span className="agent-thinking-tail">{tail}</span> : null}
    </div>
  )
}

function hasLiveTool(tools: DisplayAgentToolCall[]): boolean {
  return tools.some((tool) => tool.status === 'running' || tool.status === 'pending')
}

function reasoningTail(text: string | undefined): string | undefined {
  if (!text) return undefined
  // 思考串会随流式无限变长，全量正则清洗每帧都跑；只清洗末尾一小段。
  const collapsed = text.slice(-2_000).replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(-140) : undefined
}

function getThinkingLabel(message: DisplayAgentMessage | undefined, tools: DisplayAgentToolCall[], t: Translate): string {
  if (hasLiveTool(tools)) return t('surface:agentChat.callingATool')
  if (message?.content.trim()) return t('surface:agentChat.writingAResponse')
  if (tools.length > 0) return t('surface:agentChat.organizingResults')
  return t('surface:agentChat.analyzing')
}

function localizeAgentAnswer(value: string, t: Translate): string {
  const createdDocument = /^文档《(.+)》已创建完成，内容已写入对应工作区。你可以在文档中继续查看或编辑。$/u.exec(value)
  return createdDocument
    ? t('surface:agentChat.documentTitleCreatedInWorkspace', { title: createdDocument[1]! })
    : value
}

function RoomSelection({
  availableRooms,
  busy,
  onCancel,
  onSelect,
  rooms,
}: {
  availableRooms: AgentRoomReference[]
  busy: boolean
  onCancel: () => void
  onSelect: (room: AgentRoomReference) => void
  rooms: AgentRoomReference[]
}) {
  const { t } = useLocale()
  const availableById = new Map(availableRooms.map((room) => [room.id, room]))
  return (
    <section className="agent-room-selection" aria-label={t('surface:agentChat.chooseARoomForTheDocument')}>
      <header>
        <span><FolderKanban aria-hidden="true" /><strong>{t('surface:agentChat.chooseARoomForTheDocument')}</strong></span>
        <button type="button" aria-label={t('surface:agentChat.cancelRoomSelection')} title={t('surface:agentChat.cancel')} disabled={busy} onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="agent-room-selection-list">
        {rooms.length ? rooms.map((listedRoom) => {
          const currentRoom = availableById.get(listedRoom.id)
          const room = currentRoom ?? listedRoom
          return (
            <button
              key={listedRoom.id}
              type="button"
              disabled={busy || !currentRoom}
              title={currentRoom ? room.title : t('surface:agentChat.titleUnavailable', { title: listedRoom.title })}
              onClick={() => currentRoom && onSelect(room)}
            >
              <Folder aria-hidden="true" />
              <span>
                <strong>{room.title}</strong>
                <small>{currentRoom ? t(uiText(room.kind ?? 'Room')) : t('surface:agentChat.unavailable')}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          )
        }) : <p>{t('surface:agentChat.noRoomsAvailable')}</p>}
      </div>
    </section>
  )
}

function DocumentIntentClarification({
  busy,
  onConfirm,
  onReject,
  topic,
}: {
  busy: boolean
  onConfirm: () => void
  onReject: () => void
  topic: string
}) {
  const { t } = useLocale()
  return (
    <section className="agent-room-selection agent-document-intent" aria-label={t('surface:agentChat.confirmDocumentCreation')}>
      <header>
        <span><CircleHelp aria-hidden="true" /><strong>{t('surface:agentChat.confirmCreationMethod')}</strong></span>
      </header>
      <p className="agent-document-intent-question">{t('surface:agentChat.doYouWantToCreateADocumentAbout', { topic })}</p>
      <div className="agent-room-selection-list">
        <button type="button" disabled={busy} onClick={onConfirm}>
          <FileText aria-hidden="true" />
          <span><strong>{t('surface:agentChat.createDocument')}</strong><small>{t('surface:agentChat.nextChooseTheRoomWhereItWillBe')}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" disabled={busy} onClick={onReject}>
          <MessageSquareText aria-hidden="true" />
          <span><strong>{t('surface:agentChat.no')}</strong><small>{t('surface:agentChat.continueDescribingWhatYouNeed')}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}

const generatedDocumentPattern = /文档已成功生成[，,]\s*您可以查看：?\s*\[([^\]]+)\]\s*\(?([0-9a-f]{8}-[0-9a-f-]{27,})\)?/iu

const agentMarkdownComponents = {
  // 会话气泡内标题一律降级到 h4-h6，避免模型偶尔输出标题撑破布局。
  h1: ({ children }: { children?: ReactNode }) => <h4>{children}</h4>,
  h2: ({ children }: { children?: ReactNode }) => <h4>{children}</h4>,
  h3: ({ children }: { children?: ReactNode }) => <h5>{children}</h5>,
  h4: ({ children }: { children?: ReactNode }) => <h6>{children}</h6>,
  h5: ({ children }: { children?: ReactNode }) => <h6>{children}</h6>,
  h6: ({ children }: { children?: ReactNode }) => <h6>{children}</h6>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  img: () => null,
} as const

// pending* 意图扫描与导航判定每次渲染帧都会重扫全部工具调用，工具结果可能是
// 大 JSON 字符串（每次 JSON.parse 很贵）；按工具对象缓存解析结果。工具对象在
// 转终态后不再重建，缓存长期有效。
const navigationTargetCache = new WeakMap<DisplayAgentToolCall, boolean>()
const roomSelectionCache = new WeakMap<DisplayAgentToolCall, ReturnType<typeof parseAgentRoomSelectionResult>>()
const documentIntentCache = new WeakMap<DisplayAgentToolCall, ReturnType<typeof parseAgentDocumentIntentResult>>()

function toolNavigationResult(tool: DisplayAgentToolCall): boolean {
  if (navigationTargetCache.has(tool)) return navigationTargetCache.get(tool)!
  const parsed = tool.status === 'completed' && Boolean(parseAgentNavigationTarget(tool.result))
  navigationTargetCache.set(tool, parsed)
  return parsed
}

function toolRoomSelectionResult(tool: DisplayAgentToolCall) {
  if (roomSelectionCache.has(tool)) return roomSelectionCache.get(tool)
  const parsed = parseAgentRoomSelectionResult(tool.result)
  roomSelectionCache.set(tool, parsed)
  return parsed
}

function toolDocumentIntentResult(tool: DisplayAgentToolCall) {
  if (documentIntentCache.has(tool)) return documentIntentCache.get(tool)
  const parsed = parseAgentDocumentIntentResult(tool.result)
  documentIntentCache.set(tool, parsed)
  return parsed
}

// react-markdown 每次渲染都全量重解析整条消息：长对话里每个流式渲染帧都会把
// 全部历史消息重新解析一遍，主线程直接打满（表现为对话区卡死/滚动冻结）。
// memo 按内容缓存——历史消息内容不变就不再重解析，流式中那条每次只解析一条。
const FormattedAgentText = memo(function FormattedAgentText({ content }: { content: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={agentMarkdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
})

const AssistantMessageContent = memo(function AssistantMessageContent({ content }: { content: string }) {
  const { t } = useLocale()
  const match = generatedDocumentPattern.exec(content)
  if (!match || match.index === undefined) return <FormattedAgentText content={content} />

  const before = content.slice(0, match.index).trim()
  const after = content.slice(match.index + match[0].length).trim()
  const title = match[1].trim()

  return (
    <>
      {before ? <FormattedAgentText content={before} /> : null}
      <div className="agent-artifact" role="status" aria-label={t('surface:agentChat.documentCreatedTitle', { title })}>
        <span className="agent-artifact-icon" aria-hidden="true"><FileText /></span>
        <span className="agent-artifact-copy">
          <strong>{title}</strong>
          <small>{t('surface:agentChat.documentCreated')}</small>
        </span>
      </div>
      {after ? <FormattedAgentText content={after} /> : null}
    </>
  )
})

const fallbackAgentNames: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
}

function displayAgentName(agentId: string | null | undefined, names: Record<string, string>): string | null {
  if (!agentId || agentId === 'main') return null
  const provider = agentId.split(':', 1)[0] ?? ''
  return names[agentId] ?? fallbackAgentNames[provider] ?? (provider || agentId)
}

const modelTierBadgeKeys = {
  primary: 'surface:agentComposer.modelTierPrimary',
  lite: 'surface:agentComposer.modelTierLite',
} as const

function AgentResponseByline({ agentId, names }: { agentId?: string | null; names: Record<string, string> }) {
  const { t } = useLocale()
  const name = displayAgentName(agentId, names)
  // smart 是默认档位，沉默处理；仅非默认档位标注来源。
  const tier = modelPreferenceFromAgentId(agentId)
  const tierKey = tier && tier !== 'smart' ? modelTierBadgeKeys[tier] : null
  if (!name && !tierKey) return null
  return (
    <div className="agent-response-byline">
      {name ? <span>{name}</span> : null}
      {tierKey ? <span className="agent-model-tier-badge">{t(tierKey)}</span> : null}
    </div>
  )
}

const navigationPageLabels: Record<string, string> = {
  home: 'surface:navigation.home',
  office: 'surface:navigation.office',
  rooms: 'surface:navigation.contextRoom',
  docs: 'surface:navigation.documents',
  sources: 'surface:navigation.sources',
  memory: 'surface:navigation.memory',
  diary: 'surface:navigation.diary',
}

function SessionReference({ link, onOpen }: { link: AgentSessionLink; onOpen: () => void }) {
  const { t } = useLocale()
  const sourcePage = t(pageLabelKey(link.sourcePageLabel))
  return (
    <button
      type="button"
      className="agent-navigation-status agent-session-reference"
      title={`${sourcePage} · ${link.target.title}`}
      onClick={onOpen}
    >
      <Link2 aria-hidden="true" />
      <span>{t('surface:agentChat.referencedFromSourceTitle', { source: sourcePage, title: link.target.title })}</span>
      <ChevronRight aria-hidden="true" />
    </button>
  )
}

function RunNavigation({
  link,
  onOpen,
  pending,
}: {
  link?: AgentSessionLink
  onOpen: (link: AgentSessionLink) => void
  pending?: AgentNavigationTarget
}) {
  const { t } = useLocale()
  if (link) {
    const page = t(navigationPageLabels[link.target.pageId] ?? link.target.pageId)
    return (
      <button
        type="button"
        className="agent-navigation-status"
        aria-label={t('surface:agentChat.goToPage', { page })}
        title={link.target.title}
        onClick={() => onOpen(link)}
      >
        <Check aria-hidden="true" />
        <span>{t('surface:agentChat.continuedCreationInTitle', { title: link.target.title })}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    )
  }
  if (!pending) return null
  return (
    <div className="agent-navigation-status is-pending" role="status" title={pending.title}>
      <Link2 aria-hidden="true" />
      <span>{t('surface:agentChat.continueCreationInTitle', { title: pending.title })}</span>
    </div>
  )
}

function LinkedRunProgress({ agentNamesById, state }: { agentNamesById: Record<string, string>; state: LinkedAgentRunState }) {
  const { t } = useLocale()
  const active = state.status === 'accepted' || state.status === 'running'
  const assistantMessage = [...state.messages].reverse().find((message) => message.role === 'assistant')
  const rawFinalContent = state.documentPending
    ? ''
    : state.activity.hasTools
      ? state.activity.finalAnswer
        || state.activity.pendingAnswer
        || (state.activity.completed ? assistantMessage?.content || '' : '')
      : assistantMessage?.content || ''
  const finalContent = localizeAgentAnswer(rawFinalContent, t)

  return (
    <>
      <section className="agent-linked-run" aria-label={t('surface:agentChat.referencedTaskProgress')}>
        {state.loading ? <ThinkingStatus label={t('surface:agentChat.syncingProgress')} /> : null}
        {active ? (
          <ThinkingStatus label={state.documentPending ? t('surface:agentChat.editingDocument') : getThinkingLabel(assistantMessage, state.tools, t)} />
        ) : null}
        {state.activity.hasTools ? (
          <AgentExecutionTimeline
            activity={state.activity}
            runStartedAt={state.startedAt}
            runCompletedAt={state.completedAt}
            continuing={state.documentPending}
            continuationLabel={t('surface:agentChat.editingDocumentLabel')}
            sessionId={state.sessionId}
          />
        ) : null}
        {state.status === 'completed' && !finalContent ? (
          <div className="agent-linked-status" role="status">{t('surface:agentChat.creationComplete')}</div>
        ) : null}
        {state.error ? <div className="agent-error" role="alert">{state.error}</div> : null}
      </section>
      {finalContent ? (
        <div className="agent-assistant-response">
          <AgentResponseByline agentId={assistantMessage?.authorAgentId} names={agentNamesById} />
          <article className="agent-message" data-role="assistant">
            <AssistantMessageContent content={finalContent} />
          </article>
        </div>
      ) : null}
    </>
  )
}

export function AgentChatView({
  activeDocument,
  activeRunId,
  agentIdByRun,
  agentNamesById,
  activityByRun,
  availableRooms,
  composer,
  currentSessionId,
  draftHasContent,
  error,
  loading,
  messages,
  notificationRunTarget,
  onNotificationRunLocated,
  pendingApprovals = [],
  composerNotice,
  onRetryPrompt,
  onResolveApproval = () => undefined,
  onOpenSessionLink,
  onOpenDraftDocument,
  onSlidesGenerate,
  onOpenMention,
  onRejectDocumentIntent,
  onSelectRoom,
  onSelectDocument,
  onSelectPrompt,
  pendingNavigationByRun,
  reasoningByRun = {},
  runCompletedAtByRun,
  runStartedAtByRun,
  resolvingApprovalIds = new Set<string>(),
  scopeReady,
  sessionLinks,
  starterPrompts = null,
  submitting,
  toolCallsByRun,
}: {
  activeDocument: ActiveDocumentDescriptor | null
  activeRunId: string | null
  agentIdByRun: Record<string, string>
  agentNamesById: Record<string, string>
  activityByRun: Record<string, AgentRunActivity>
  availableRooms: AgentRoomReference[]
  composer: ReactNode
  currentSessionId: string | null
  draftHasContent: boolean
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  notificationRunTarget?: { key: string; runId: string } | null
  onNotificationRunLocated?: (key: string) => void
  pendingApprovals?: PendingShellApproval[]
  composerNotice?: ReactNode
  onRetryPrompt: (prompt: string, runId: string) => void
  onResolveApproval?: (approvalId: string, decision: AgentApprovalDecision, feedback?: string) => void
  onOpenSessionLink: (link: AgentSessionLink) => void
  onOpenDraftDocument?: (documentId: string) => void
  onSlidesGenerate?: (message: string) => void
  onOpenMention?: (item: MentionedItem) => void
  onRejectDocumentIntent: () => void
  onSelectRoom: (
    room: AgentRoomReference,
    intent: PendingAgentIntent,
    document?: AgentDocumentSelectionItem,
  ) => Promise<void>
  onSelectDocument: (selection: AgentDocumentSelectionSubmission) => void
  onSelectPrompt: (prompt: string) => void
  pendingNavigationByRun: Record<string, AgentNavigationTarget>
  reasoningByRun?: Record<string, string>
  runCompletedAtByRun: Record<string, string>
  runStartedAtByRun: Record<string, string>
  resolvingApprovalIds?: ReadonlySet<string>
  scopeReady: boolean
  sessionLinks: AgentSessionLink[]
  /** 按最近活动生成的动态开场推荐；null/空时回退静态 quickPrompts。 */
  starterPrompts?: string[] | null
  submitting: boolean
  toolCallsByRun: Record<string, DisplayAgentToolCall[]>
}) {
  const { t } = useLocale()
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [dismissedDocumentIntents, setDismissedDocumentIntents] = useState<Set<string>>(() => new Set())
  const [dismissedRoomSelections, setDismissedRoomSelections] = useState<Set<string>>(() => new Set())
  const [dismissedDocumentSelections, setDismissedDocumentSelections] = useState<Set<string>>(() => new Set())
  const [confirmedDocumentIntent, setConfirmedDocumentIntent] = useState<(
    AgentDocumentIntentResult & { pendingIntent: PendingAgentIntent }
  ) | null>(null)
  const [pendingIntentDocumentSelection, setPendingIntentDocumentSelection] = useState<{
    room: AgentRoomReference
    intent: PendingAgentIntent
    toolId: string | null
  } | null>(null)
  const [highlightedNotificationTarget, setHighlightedNotificationTarget] = useState<{
    key: string
    messageId: string
  } | null>(null)
  const handledDocumentSelectionsRef = useRef(new Set<string>())
  const { documentsByRoom } = useRoomDocumentsState()
  const conversationRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastUnpinAtRef = useRef(0)
  /** 上一帧的内容总高度：滚动事件比帧回调先触发，用它还原「滚动发生时的底部」，
   * 不被同一帧里流式插入的新高度污染（竞态消除的关键）。 */
  const lastScrollHeightRef = useRef(0)
  const lastUserMessageIdRef = useRef<string | null>(null)
  const previousSessionIdRef = useRef(currentSessionId)
  const hasConversation = messages.length > 0 || sessionLinks.length > 0 || pendingApprovals.length > 0
    || Boolean(activeRunId) || Boolean(error)
  const confirmedEmpty = scopeReady && !hasConversation
  const [emptyLayout, setEmptyLayout] = useState(confirmedEmpty)
  const previousEmptyRef = useRef(confirmedEmpty)
  const [quickPromptsReady, setQuickPromptsReady] = useState(confirmedEmpty)
  const [contentReady, setContentReady] = useState(!confirmedEmpty)
  const previousContentEmptyRef = useRef(confirmedEmpty)
  const previousContentSessionRef = useRef(currentSessionId)
  const incomingLink = [...sessionLinks].reverse().find((link) => link.targetSessionId === currentSessionId)
  const outgoingLinks = useMemo(
    () => sessionLinks.filter((link) => link.sourceSessionId === currentSessionId),
    [currentSessionId, sessionLinks],
  )
  const linkedRun = useLinkedAgentRun(incomingLink ?? null)
  const notificationTargetMessageId = useMemo(() => {
    if (!notificationRunTarget) return null
    const runMessages = messages.filter((message) => (
      message.runId === notificationRunTarget.runId && message.role !== 'system'
    ))
    return runMessages.find((message) => message.role === 'assistant')?.id
      ?? runMessages[0]?.id
      ?? null
  }, [messages, notificationRunTarget])
  const notificationTargetActiveRef = useRef(false)
  useEffect(() => { notificationTargetActiveRef.current = Boolean(notificationTargetMessageId) }, [notificationTargetMessageId])

  const latestStreamingMessage = useMemo(
    () => [...messages].reverse().find((message) => (
      message.runId === activeRunId && message.role === 'assistant' && message.streaming
    )),
    [activeRunId, messages],
  )
  const latestTools = activeRunId ? toolCallsByRun[activeRunId] ?? [] : []
  const latestActivity = activeRunId ? activityByRun[activeRunId] : undefined
  // PPT 逐页进度卡：最近一次带进度载荷的 slides_draft（进行中的优先）。
  const slidesProgress = useMemo(() => {
    const candidates = Object.values(toolCallsByRun)
      .flat()
      .map((tool) => ({ tool, progress: slidesProgressFromToolCall(tool) }))
      .filter((entry): entry is { tool: DisplayAgentToolCall; progress: SlidesProgressState } => entry.progress !== null)
    if (candidates.length === 0) return null
    const live = candidates.filter((entry) => entry.tool.status === 'running' || entry.tool.status === 'pending')
    const pool = live.length > 0 ? live : candidates
    return pool.reduce((latest, entry) =>
      Date.parse(entry.tool.startedAt) > Date.parse(latest.tool.startedAt) ? entry : latest)
  }, [toolCallsByRun])
  const activeHasAssistant = activeRunId
    ? messages.some((message) => message.runId === activeRunId && message.role === 'assistant')
    : false
  const userRunIds = useMemo(() => new Set(
    messages.filter((message) => message.role === 'user').map((message) => message.runId),
  ), [messages])
  const activeRunPending = Boolean(activeRunId && !runCompletedAtByRun[activeRunId])
  const activeRunHasUserMessage = Boolean(activeRunId && userRunIds.has(activeRunId))
  const activeNavigationLink = activeRunId
    ? outgoingLinks.find((link) => link.sourceRunId === activeRunId)
    : undefined
  const activeNavigationPending = activeRunId ? pendingNavigationByRun[activeRunId] : undefined
  const pendingRoomSelection = useMemo(() => {
    const candidates = Object.values(toolCallsByRun)
      .flat()
      .filter((tool) => tool.name === 'context_room_list' && tool.status === 'completed')
      .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
    for (const tool of candidates) {
      if (dismissedRoomSelections.has(tool.id)) continue
      const result = toolRoomSelectionResult(tool)
      if (!result?.pendingIntent) continue
      const completedAt = Date.parse(tool.completedAt ?? tool.startedAt)
      const hasLaterUserMessage = messages.some((message) => (
        message.role === 'user' && Date.parse(message.createdAt) > completedAt
      ))
      const hasLaterRun = Boolean(activeRunId && activeRunId !== tool.runId)
        || Object.entries({ ...runStartedAtByRun, ...runCompletedAtByRun }).some(([runId, occurredAt]) => (
          runId !== tool.runId && Date.parse(occurredAt) >= completedAt
        ))
      if (!hasLaterUserMessage && !hasLaterRun) return { tool, result }
    }
    return null
  }, [activeRunId, dismissedRoomSelections, messages, runCompletedAtByRun, runStartedAtByRun, toolCallsByRun])
  // 授权卡片按时间插进消息流：挑战出现时锚定 startedAt，新消息自然把它顶上去。
  const authChallenge = useAgentAuthChallenge()
  const authCardInsertIndex = useMemo(() => {
    if (!authChallenge) return -1
    const startedAt = Date.parse(authChallenge.startedAt)
    if (Number.isNaN(startedAt)) return messages.length
    for (let index = 0; index < messages.length; index += 1) {
      if (Date.parse(messages[index]!.createdAt) > startedAt) return index
    }
    return messages.length
  }, [authChallenge?.id, authChallenge?.startedAt, messages])

  const pendingDocumentIntent = useMemo(() => {
    const candidates = Object.values(toolCallsByRun)
      .flat()
      .filter((tool) => tool.name === 'context_room_document_intent' && tool.status === 'completed')
      .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
    for (const tool of candidates) {
      if (dismissedDocumentIntents.has(tool.id)) continue
      const result = toolDocumentIntentResult(tool)
      if (!result?.pendingIntent) continue
      const completedAt = Date.parse(tool.completedAt ?? tool.startedAt)
      const hasLaterUserMessage = messages.some((message) => (
        message.role === 'user' && Date.parse(message.createdAt) > completedAt
      ))
      const hasLaterRun = Boolean(activeRunId && activeRunId !== tool.runId)
        || Object.entries({ ...runStartedAtByRun, ...runCompletedAtByRun }).some(([runId, occurredAt]) => (
          runId !== tool.runId && Date.parse(occurredAt) >= completedAt
        ))
      if (!hasLaterUserMessage && !hasLaterRun) return { tool, result }
    }
    return null
  }, [activeRunId, dismissedDocumentIntents, messages, runCompletedAtByRun, runStartedAtByRun, toolCallsByRun])
  const roomSelection = pendingIntentDocumentSelection ? null : pendingRoomSelection
    ? {
        toolId: pendingRoomSelection.tool.id,
        rooms: pendingRoomSelection.result.rooms,
        intent: pendingRoomSelection.result.pendingIntent!,
      }
    : confirmedDocumentIntent
      ? {
          toolId: null,
          rooms: availableRooms.filter((room) => confirmedDocumentIntent.pendingIntent.allowedRoomIds.includes(room.id)),
          intent: confirmedDocumentIntent.pendingIntent,
        }
      : null
  const pendingIntentDocuments = useMemo(() => {
    if (!pendingIntentDocumentSelection) return []
    const allowedDocumentIds = new Set(pendingIntentDocumentSelection.intent.allowedDocumentIds)
    return (documentsByRoom[pendingIntentDocumentSelection.room.id] ?? [])
      .filter((document: RoomDocument) => allowedDocumentIds.has(document.id))
      .map((document: RoomDocument) => ({
        documentId: document.id,
        roomId: document.roomId,
        title: document.title,
        version: document.version,
        status: document.status,
      }))
  }, [documentsByRoom, pendingIntentDocumentSelection])
  const pendingDocumentSelection = useMemo(() => {
    if (activeDocument) return null
    return findPendingAgentDocumentSelection(
      Object.values(toolCallsByRun).flat(),
      messages,
      dismissedDocumentSelections,
    )
  }, [activeDocument, dismissedDocumentSelections, messages, toolCallsByRun])

  useEffect(() => {
    setConfirmedDocumentIntent(null)
    setPendingIntentDocumentSelection(null)
  }, [currentSessionId])

  useEffect(() => {
    const reset = () => setCopiedMessageId(null)
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') reset()
    }
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  // 自动滚底遵循 stick-to-bottom：用户上翻离开底部后暂停跟随，滚回底部恢复。
  // 新用户消息与会话切换重新锚定底部（#199：此前无条件滚底，流中断后的周期
  // state 更新会把用户反复拽回底部，表现为滚动卡死）。
  useEffect(() => {
    if (previousSessionIdRef.current === currentSessionId) return
    previousSessionIdRef.current = currentSessionId
    lastUserMessageIdRef.current = null
    lastScrollTopRef.current = 0
    lastScrollHeightRef.current = 0
    lastUnpinAtRef.current = 0
    pinnedToBottomRef.current = true
  }, [currentSessionId])

  useEffect(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.role !== 'user') continue
      if (message.id !== lastUserMessageIdRef.current) {
        lastUserMessageIdRef.current = message.id
        pinnedToBottomRef.current = true
      }
      return
    }
  }, [messages])

  useEffect(() => {
    if (!pinnedToBottomRef.current) return
    const element = conversationRef.current
    if (!element || notificationTargetMessageId) return
    element.scrollTop = element.scrollHeight
    // 主动搬动滚动位置时同步参照值（jsdom 等无原生 scroll 事件的环境也保持一致）
    lastScrollTopRef.current = element.scrollTop
  }, [activeRunId, linkedRun.messages, linkedRun.reasoning, linkedRun.tools, messages, notificationTargetMessageId, pendingApprovals, toolCallsByRun])

  // DOM 级滚动跟随：吸底时内容一长就贴底，不依赖 React 状态形状。MutationObserver
  // 每次正文变化都会回调，逐次读 scrollHeight 强制布局，事件风暴下按帧合并掉。
  useEffect(() => {
    const element = conversationRef.current
    if (!element || typeof MutationObserver === 'undefined') return undefined
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (notificationTargetActiveRef.current) return
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        lastScrollHeightRef.current = element.scrollHeight
        if (notificationTargetActiveRef.current) return
        if (!pinnedToBottomRef.current) {
          // 每个内容批次都补一次恢复判定：滚动事件在触发前一帧可能被流式增长
          // 顶出阈值（概率性吸不上），这里持续兜底；解除保护期内不回吸。
          if (Date.now() - lastUnpinAtRef.current < AGENT_CHAT_UNPIN_GRACE_MS) return
          if (element.scrollHeight - element.scrollTop - element.clientHeight > AGENT_CHAT_REPIN_DISTANCE_PX) return
          pinnedToBottomRef.current = true
        }
        element.scrollTop = element.scrollHeight
        lastScrollTopRef.current = element.scrollTop
      })
    })
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  useLayoutEffect(() => {
    if (scopeReady) setEmptyLayout(confirmedEmpty)
  }, [confirmedEmpty, scopeReady])

  useEffect(() => {
    if (!scopeReady) return
    const wasEmpty = previousEmptyRef.current
    previousEmptyRef.current = confirmedEmpty
    if (!confirmedEmpty) {
      setQuickPromptsReady(false)
      return
    }
    if (wasEmpty || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setQuickPromptsReady(true)
      return
    }
    setQuickPromptsReady(false)
  }, [confirmedEmpty, scopeReady])

  useLayoutEffect(() => {
    if (!scopeReady) {
      setContentReady(false)
      return
    }
    const wasEmpty = previousContentEmptyRef.current
    const sessionChanged = previousContentSessionRef.current !== currentSessionId
    previousContentSessionRef.current = currentSessionId
    if (confirmedEmpty) {
      previousContentEmptyRef.current = true
      setContentReady(false)
      return
    }
    if (loading) {
      setContentReady(false)
      return
    }
    previousContentEmptyRef.current = false
    if (!wasEmpty && !sessionChanged) {
      setContentReady(true)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setContentReady(true)
      return
    }
    setContentReady(false)
    const timer = window.setTimeout(() => setContentReady(true), wasEmpty ? 320 : 80)
    return () => window.clearTimeout(timer)
  }, [confirmedEmpty, currentSessionId, loading, scopeReady])

  useLayoutEffect(() => {
    if (!contentReady || !notificationRunTarget || !notificationTargetMessageId) return
    const conversation = conversationRef.current
    if (!conversation) return
    const target = Array.from(conversation.querySelectorAll<HTMLElement>('[data-agent-message-id]'))
      .find((element) => element.dataset.agentMessageId === notificationTargetMessageId)
    if (!target) return

    target.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    })
    setHighlightedNotificationTarget({
      key: notificationRunTarget.key,
      messageId: notificationTargetMessageId,
    })
    onNotificationRunLocated?.(notificationRunTarget.key)
  }, [contentReady, notificationRunTarget, notificationTargetMessageId, onNotificationRunLocated])

  useEffect(() => {
    if (!highlightedNotificationTarget) return
    const timer = window.setTimeout(() => {
      setHighlightedNotificationTarget((current) => (
        current?.key === highlightedNotificationTarget.key ? null : current
      ))
    }, 2_400)
    return () => window.clearTimeout(timer)
  }, [highlightedNotificationTarget])

  const copyMessage = async (messageId: string, content: string) => {
    try {
      await writeTextToClipboard(content)
      setCopiedMessageId(messageId)
    } catch {
      setCopiedMessageId(null)
    }
  }

  // 逐条向上找「最近一条用户消息」是 O(M²) 渲染成本，改成随循环顺带维护。
  let lastUserMessage: DisplayAgentMessage | undefined

  return (
    <section
      className="agent-chat-conversation-frame"
      data-drafting={String(draftHasContent)}
      data-content-ready={String(contentReady)}
      data-empty={String(emptyLayout)}
      data-prompts-ready={String(quickPromptsReady)}
      onTransitionEnd={(event) => {
        if (
          emptyLayout
          && event.propertyName === 'bottom'
          && (event.target as HTMLElement).classList.contains('agent-composer-shell')
        ) setQuickPromptsReady(true)
      }}
    >
      {emptyLayout ? <div className="agent-chat-empty-heading"><h2>{t('surface:agentChat.startANewConversation')}</h2></div> : null}
      <div
        ref={conversationRef}
        className="agent-conversation"
        aria-live="polite"
        onScroll={(event) => {
          // 吸底判定不能只看瞬时距离：流式增长每帧可达数百像素，解除吸底后
          // 「距离≤32px」永远追不上（视图会冻在某个高度，#对话区卡住）。
          // 只有真的向上滚才解除；向下滚到接近底部则恢复吸底。
          const element = event.currentTarget
          const lastTop = lastScrollTopRef.current
          lastScrollTopRef.current = element.scrollTop
          if (element.scrollTop < lastTop - 1) {
            pinnedToBottomRef.current = false
            lastUnpinAtRef.current = Date.now()
            return
          }
          // 到过「上一帧的底部」即算跟到底：同一帧里流式插入会推高当前底部，
          // 用当前几何判定会被顶出阈值（概率性吸不上），上一帧高度没有这个问题。
          // 还没有任何内容批次时（初始为 0）退回当前高度，避免误判成「到底了」。
          const referenceHeight = lastScrollHeightRef.current || element.scrollHeight
          const reachedPreviousBottom = element.scrollTop
            >= referenceHeight - element.clientHeight - AGENT_CHAT_REPIN_DISTANCE_PX
          if (reachedPreviousBottom) pinnedToBottomRef.current = true
        }}
        onWheel={(event) => {
          // wheel 先于 scroll 事件：向上立即解除吸底，向上滚动不会被下一次
          // 强制滚底吃掉；向下且已接近底部视为「想跟回」，直接重新吸底——
          // 不留给流式增长在 scroll 事件触发前冲过阈值的竞态窗口。
          const element = conversationRef.current
          if (!element) return
          if (event.deltaY < 0) {
            pinnedToBottomRef.current = false
            lastUnpinAtRef.current = Date.now()
            return
          }
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight
          if (distance < AGENT_CHAT_WHEEL_REPIN_DISTANCE_PX) {
            pinnedToBottomRef.current = true
            lastUnpinAtRef.current = 0
          }
        }}
      >
          {incomingLink ? (
            <>
              <SessionReference link={incomingLink} onOpen={() => onOpenSessionLink(incomingLink)} />
              <LinkedRunProgress agentNamesById={agentNamesById} state={linkedRun} />
            </>
          ) : null}
          {messages.map((message, index) => {
            if (message.role === 'system') return null
            const previousUserMessage = lastUserMessage
            const tools = toolCallsByRun[message.runId] ?? []
            const activity = activityByRun[message.runId]
            const hasToolActivity = Boolean(activity?.hasTools)
            const rawFinalContent = hasToolActivity
              ? activity?.finalAnswer || activity?.pendingAnswer || (
                activity?.completed && !message.streaming && runCompletedAtByRun[message.runId] ? message.content : ''
              )
              : message.content
            const finalContent = localizeAgentAnswer(rawFinalContent, t)
            const partialContent = Boolean(
              hasToolActivity && activity && !activity.completed && runCompletedAtByRun[message.runId] && finalContent,
            )
            const showActions = message.role === 'assistant' && !message.streaming
              && !partialContent && Boolean(finalContent.trim())
            const link = outgoingLinks.find((item) => item.sourceRunId === message.runId)
            const navigationResult = (toolCallsByRun[message.runId] ?? []).some(toolNavigationResult)
            const pending = !runCompletedAtByRun[message.runId] || navigationResult
              ? pendingNavigationByRun[message.runId]
              : undefined
            const runHasUserMessage = userRunIds.has(message.runId)
            const authorAgentId = message.authorAgentId ?? agentIdByRun[message.runId]

            if (message.role === 'user') {
              lastUserMessage = message
              const mentionItems: MentionedItem[] | null = message.mentions?.length ? message.mentions : null
              const mentionClickable = (item: MentionedItem) => item.kind === 'room' || item.kind === 'file'
                || (item.kind === 'conversation' && (item.provider === undefined || item.provider === 'everroom'))
              return (
                <Fragment key={message.id}>
                  {index === authCardInsertIndex ? <AgentAuthChallengeCard /> : null}
                  {mentionItems
                    ? mentionItems.map((item) => (
                      mentionClickable(item) && onOpenMention ? (
                        <button
                          key={`${item.kind}:${item.id}`}
                          type="button"
                          className="agent-user-mention agent-user-mention-link"
                          data-kind={item.kind}
                          title={t('surface:agentChat.mentionJumpTitle', { name: item.displayName })}
                          onClick={() => onOpenMention(item)}
                        >
                          @{item.displayName}
                        </button>
                      ) : (
                        <span key={`${item.kind}:${item.id}`} className="agent-user-mention" data-kind={item.kind}>@{item.displayName}</span>
                      )
                    ))
                    : message.referencedAgentNames?.map((name) => (
                      <span key={name} className="agent-user-mention">@{name}</span>
                    ))}
                  <article
                    className="agent-message"
                    data-agent-message-id={message.id}
                    data-notification-target={String(highlightedNotificationTarget?.messageId === message.id)}
                    data-role="user"
                  >
                    <p>{message.content}</p>
                    <button
                      type="button"
                      className="agent-user-copy"
                      data-copied={String(copiedMessageId === message.id)}
                      aria-label={t('surface:agentChat.copyPrompt')}
                      title={t('surface:agentChat.copyPrompt')}
                      onClick={() => void copyMessage(message.id, message.content)}
                    >
                      {copiedMessageId === message.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    </button>
                  </article>
                  <RunNavigation link={link} pending={link ? undefined : pending} onOpen={onOpenSessionLink} />
                </Fragment>
              )
            }

            return (
              <Fragment key={message.id}>
              {index === authCardInsertIndex ? <AgentAuthChallengeCard /> : null}
              <div
                className="agent-assistant-turn"
                data-agent-message-id={message.id}
                data-notification-target={String(highlightedNotificationTarget?.messageId === message.id)}
              >
                {!runHasUserMessage ? (
                  <RunNavigation link={link} pending={link ? undefined : pending} onOpen={onOpenSessionLink} />
                ) : null}
                {message.streaming && message.runId === activeRunId
                  ? (
                    <ThinkingStatus
                      label={getThinkingLabel(message, tools, t)}
                      tail={!hasLiveTool(tools) && !rawFinalContent.trim()
                        ? reasoningTail(reasoningByRun[message.runId])
                        : undefined}
                    />
                  )
                  : null}
                {hasToolActivity && activity ? (
                  <AgentExecutionTimeline
                    activity={activity}
                    runStartedAt={runStartedAtByRun[message.runId]}
                    runCompletedAt={runCompletedAtByRun[message.runId]}
                    sessionId={currentSessionId}
                  />
                ) : null}
                {partialContent ? (
                  <div className="agent-linked-status" role="status">{t('surface:agentChat.theRunEndedUnexpectedlyHereIsThePartial')}</div>
                ) : null}
                {finalContent ? (
                  <div className="agent-assistant-response">
                    <AgentResponseByline agentId={authorAgentId} names={agentNamesById} />
                    <article className="agent-message" data-role="assistant"><AssistantMessageContent content={finalContent} /></article>
                  </div>
                ) : null}
                {showActions ? (
                  <div className="agent-message-actions">
                    <button type="button" aria-label={t('surface:agentChat.copyResponse')} title={t('surface:agentChat.copyResponse')} onClick={() => void copyMessage(message.id, finalContent)}>
                      {copiedMessageId === message.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      aria-label={t('surface:agentChat.regenerate')}
                      title={t('surface:agentChat.regenerate')}
                      disabled={!previousUserMessage || previousUserMessage.content.includes('[附件：')}
                      onClick={() => previousUserMessage && onRetryPrompt(previousUserMessage.content, message.runId)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              </Fragment>
            )
          })}
          {authCardInsertIndex >= messages.length ? <AgentAuthChallengeCard /> : null}
          {activeRunId && !activeHasAssistant ? (
            <div className="agent-assistant-turn is-pending">
              {!activeRunHasUserMessage ? (
                <RunNavigation
                  link={activeNavigationLink}
                  pending={activeNavigationLink ? undefined : activeNavigationPending}
                  onOpen={onOpenSessionLink}
                />
              ) : null}
              <AgentResponseByline agentId={agentIdByRun[activeRunId]} names={agentNamesById} />
              <ThinkingStatus
                label={getThinkingLabel(undefined, latestTools, t)}
                tail={reasoningTail(reasoningByRun[activeRunId])}
              />
              {latestActivity?.hasTools ? (
                <AgentExecutionTimeline
                  activity={latestActivity}
                  runStartedAt={runStartedAtByRun[activeRunId]}
                  runCompletedAt={runCompletedAtByRun[activeRunId]}
                  sessionId={currentSessionId}
                />
              ) : null}
            </div>
          ) : null}
          {activeRunId && activeHasAssistant && !latestStreamingMessage && !latestActivity?.hasTools
            ? (
              <ThinkingStatus
                label={getThinkingLabel(undefined, latestTools, t)}
                tail={reasoningTail(reasoningByRun[activeRunId])}
              />
            )
            : null}
          {composerNotice}
          {slidesProgress ? (
            <SlidesProgressCard
              state={slidesProgress.progress}
              toolRunning={slidesProgress.tool.status === 'running' || slidesProgress.tool.status === 'pending'}
              busy={Boolean(activeRunId) || submitting}
              onOpenDraft={onOpenDraftDocument}
              onGenerate={onSlidesGenerate}
            />
          ) : null}
          <AgentShellApproval
            approvals={pendingApprovals}
            resolvingApprovalIds={resolvingApprovalIds}
            onResolve={onResolveApproval}
          />
          {pendingDocumentIntent ? (
            <DocumentIntentClarification
              busy={loading || submitting || activeRunPending}
              topic={pendingDocumentIntent.result.topic}
              onConfirm={() => {
                setDismissedDocumentIntents((current) => new Set(current).add(pendingDocumentIntent.tool.id))
                setConfirmedDocumentIntent({
                  ...pendingDocumentIntent.result,
                  pendingIntent: pendingDocumentIntent.result.pendingIntent!,
                })
              }}
              onReject={() => {
                setDismissedDocumentIntents((current) => new Set(current).add(pendingDocumentIntent.tool.id))
                onRejectDocumentIntent()
              }}
            />
          ) : null}
          {roomSelection ? (
            <RoomSelection
              availableRooms={availableRooms}
              busy={loading || submitting || activeRunPending}
              rooms={roomSelection.rooms}
              onCancel={() => {
                if (roomSelection.toolId) {
                  setDismissedRoomSelections((current) => new Set(current).add(roomSelection.toolId!))
                }
                setConfirmedDocumentIntent(null)
              }}
              onSelect={(room) => {
                if (roomSelection.intent.targetCapability !== 'document.create') {
                  setPendingIntentDocumentSelection({
                    room,
                    intent: roomSelection.intent,
                    toolId: roomSelection.toolId,
                  })
                  return
                }
                void onSelectRoom(room, roomSelection.intent).then(() => {
                  if (roomSelection.toolId) {
                    setDismissedRoomSelections((current) => new Set(current).add(roomSelection.toolId!))
                  }
                  setConfirmedDocumentIntent(null)
                }).catch(() => undefined)
              }}
            />
          ) : null}
          {pendingIntentDocumentSelection ? (
            <AgentDocumentPicker
              busy={loading || submitting || activeRunPending}
              documents={pendingIntentDocuments}
              onCancel={() => setPendingIntentDocumentSelection(null)}
              onSelect={(document) => {
                const selection = pendingIntentDocumentSelection
                void onSelectRoom(selection.room, selection.intent, document).then(() => {
                  if (selection.toolId) {
                    setDismissedRoomSelections((current) => new Set(current).add(selection.toolId!))
                  }
                  setConfirmedDocumentIntent(null)
                  setPendingIntentDocumentSelection(null)
                }).catch(() => undefined)
              }}
            />
          ) : pendingDocumentSelection ? (
            <AgentDocumentPicker
              busy={loading || submitting || activeRunPending}
              documents={pendingDocumentSelection.documents}
              onCancel={() => {
                handledDocumentSelectionsRef.current.add(pendingDocumentSelection.toolId)
                setDismissedDocumentSelections((current) => new Set(current).add(pendingDocumentSelection.toolId))
              }}
              onSelect={(document) => {
                if (handledDocumentSelectionsRef.current.has(pendingDocumentSelection.toolId)) return
                handledDocumentSelectionsRef.current.add(pendingDocumentSelection.toolId)
                setDismissedDocumentSelections((current) => new Set(current).add(pendingDocumentSelection.toolId))
                onSelectDocument({
                  document,
                  originalPrompt: pendingDocumentSelection.originalPrompt,
                  toolId: pendingDocumentSelection.toolId,
                })
              }}
            />
          ) : null}
          {loading && messages.length === 0 ? <div className="agent-loading">{t('surface:agentChat.loadingConversation')}</div> : null}
          {error ? <div className="agent-error" role="alert">{error}</div> : null}
      </div>
      {composer}
      <div className="agent-chat-quick-prompts" aria-label={t('surface:agentChat.suggestedPrompts')} aria-hidden={!quickPromptsReady}>
        {starterPrompts?.length
          ? starterPrompts.map((prompt) => (
            <button key={prompt} type="button" onClick={() => onSelectPrompt(prompt)}>{prompt}</button>
          ))
          : quickPrompts.map(([label, prompt]) => (
            <button key={label} type="button" onClick={() => onSelectPrompt(t(prompt))}>{t(label)}</button>
          ))}
      </div>
    </section>
  )
}
