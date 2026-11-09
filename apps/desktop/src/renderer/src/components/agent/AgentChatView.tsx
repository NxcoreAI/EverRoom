import { ArrowDown, Check, ChevronRight, Copy, FileText, Link2, RotateCcw } from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import { AgentAnswerDetails } from './AgentAnswerDetails'
import { AgentShellApproval } from './AgentShellApproval'
import { ReasoningBlock } from './ReasoningBlock'
import {
  SlidesProgressCard,
  selectSlidesTasks,
  slidesTaskEntries,
  type SlidesProgressState,
  type SlidesTaskEntry,
} from './SlidesProgressCard'
import { slidesFailureSuppressed } from './slides/slidesState'
import { AgentAuthChallengeCard, useAgentAuthChallenge } from './AgentAuthChallengeCard'
import {
  AGENT_CHAT_REPIN_DISTANCE_PX,
  AGENT_CHAT_WHEEL_UP_DETACH_PX,
  isGeometryClampScroll,
  isNestedScrollerWheel,
  wheelDownChaseBand,
} from './agentChatScroll'
import type { PendingShellApproval } from './agentShellApprovals'
import type { AgentRunActivity } from './agentRunActivity'
import { agentTurnFilesFromTools } from './agentTurnFiles'
import { AgentTurnFilesCard } from './AgentTurnFilesCard'
import { parseAgentNavigationTarget } from './agentNavigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLinkedAgentRun, type LinkedAgentRunState } from './useLinkedAgentRun'
import type { DisplayAgentMessage, DisplayAgentToolCall } from './useAgentSession'
import type { MentionedItem } from './agentMentions'
import { modelPreferenceFromAgentId, type AgentNavigationTarget, type AgentNoteCard, type AgentRoomReference, type AgentSessionLink, type PendingAgentIntent, type RoomDocument } from '@nxcore/agent-contract'
import type { AgentApprovalDecision } from '@/shared/sources'
import { writeTextToClipboard } from '@/lib/systemClipboard'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import { pageLabelKey } from '@/data/navigation'

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

/** 徽标计数只算用户真正会看到的条目，system 事件不占位。 */
function countVisibleMessages(messages: DisplayAgentMessage[]): number {
  return messages.filter((message) => message.role !== 'system').length
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

function toolNavigationResult(tool: DisplayAgentToolCall): boolean {
  if (navigationTargetCache.has(tool)) return navigationTargetCache.get(tool)!
  const parsed = tool.status === 'completed' && Boolean(parseAgentNavigationTarget(tool.result))
  navigationTargetCache.set(tool, parsed)
  return parsed
}

/** run → 本轮产生的文件（解析在 agentTurnFiles 内部按工具对象缓存）。 */
const runTurnFiles = agentTurnFilesFromTools

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

// 与 agentNavigation 的 pages 集合同步：rooms/docs/sources/diary 等页面已下线，
// 历史链接里的旧 pageId 走 fallback（直接显示 pageId 字符串）。
const navigationPageLabels: Record<string, string> = {
  home: 'surface:navigation.home',
  office: 'surface:navigation.office',
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

/**
 * 文档批注卡片（用户气泡内，只读）：每条 = 原文摘录 + 我的注释。
 * 长文本行内截断，hover 卡片完整展示（title 原生 tooltip 即可，只读无操作）。
 */
function UserNoteCards({ cards }: { cards: AgentNoteCard[] }) {
  const noteText = (note: string) => note.length > 120 ? `${note.slice(0, 120)}…` : note
  const excerptText = (excerpt: string) => {
    const flat = excerpt.replace(/\s+/g, ' ').trim()
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
  }
  return (
    <div className="agent-note-cards" role="list">
      {cards.map((card, index) => (
        <div
          key={`${index}:${card.note.slice(0, 24)}`}
          className="agent-note-card"
          role="listitem"
          title={`${card.excerpt}\n——\n${card.note}`}
        >
          {card.title ? <div className="agent-note-card-source">{card.title}</div> : null}
          {card.excerpt ? <div className="agent-note-card-excerpt">{excerptText(card.excerpt)}</div> : null}
          <div className="agent-note-card-note">{noteText(card.note)}</div>
        </div>
      ))}
    </div>
  )
}

function LinkedRunProgress({ agentNamesById, state, failedRunIds }: {
  agentNamesById: Record<string, string>
  state: LinkedAgentRunState
  failedRunIds?: ReadonlySet<string> | undefined
}) {
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
        {/* 思考已按工具分段进时间线：有工具活动时不再重复顶部总块；无工具时整段展示。 */}
        {!state.activity.hasTools ? (
          <ReasoningBlock active={active} content={state.reasoning} />
        ) : null}
        {state.activity.hasTools ? (
          <AgentExecutionTimeline
            activity={state.activity}
            runStartedAt={state.startedAt}
            runCompletedAt={state.completedAt}
            continuing={state.documentPending}
            continuationLabel={t('surface:agentChat.editingDocumentLabel')}
            sessionId={state.sessionId}
            failedRunIds={failedRunIds}
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
  activeRunId,
  agentIdByRun,
  agentNamesById,
  activityByRun,
  composer,
  currentSessionId,
  draftHasContent,
  error,
  loading,
  messages,
  notificationRunTarget,
  onNotificationRunLocated,
  onRetryError,
  pendingApprovals = [],
  composerNotice,
  onRetryPrompt,
  onResolveApproval = () => undefined,
  onOpenSessionLink,
  onSlidesAction,
  onOpenDraft,
  onOpenMention,
  onSelectPrompt,
  cancelledRunIds,
  interruptedRunIds,
  failedRunIds,
  onContinueRun,
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
  activeRunId: string | null
  agentIdByRun: Record<string, string>
  agentNamesById: Record<string, string>
  activityByRun: Record<string, AgentRunActivity>
  composer: ReactNode
  currentSessionId: string | null
  draftHasContent: boolean
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  notificationRunTarget?: { key: string; runId: string } | null
  onNotificationRunLocated?: (key: string) => void
  /** 会话加载/运行报错后的手动重试（重连并重拉当前会话）；缺省只展示错误文案。 */
  onRetryError?: () => void
  pendingApprovals?: PendingShellApproval[]
  composerNotice?: ReactNode
  onRetryPrompt: (prompt: string, runId: string) => void
  onResolveApproval?: (approvalId: string, decision: AgentApprovalDecision, feedback?: string, choice?: string, text?: string) => void
  onOpenSessionLink: (link: AgentSessionLink) => void
  /** 卡片动作两段式：prompt 是运行时技术指令，displayText 是用户人话（气泡/标题）。 */
  onSlidesAction?: (prompt: string, displayText: string) => void
  onOpenDraft?: (documentId: string) => void
  /** 用户主动停止的 run：卡片显示「已停止」。 */
  cancelledRunIds?: ReadonlySet<string>
  /** 网关重启等原因被中断的 run：卡片显示「运行被中断」。 */
  interruptedRunIds?: ReadonlySet<string>
  /** 网关判定失败的 run：时间线标题显示「处理失败」（唯一权威口径）。 */
  failedRunIds?: ReadonlySet<string>
  /** 上一轮因输出额度耗尽而中断时提供：点「继续」接着做完，无需重述需求。 */
  onContinueRun?: () => void
  onOpenMention?: (item: MentionedItem) => void
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
  const [highlightedNotificationTarget, setHighlightedNotificationTarget] = useState<{
    key: string
    messageId: string
  } | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  /** 脱离底部期间新增的可见消息数：「回到最新」按钮的计数徽标（#297）。
   * unpin 时记下基准，随消息追加累加，回到底部清零。 */
  const detachedBaseCountRef = useRef(0)
  const [scrollDetached, setScrollDetached] = useState(false)
  const [detachedNewCount, setDetachedNewCount] = useState(0)
  const attachChatScroll = (element: HTMLElement) => {
    pinnedToBottomRef.current = true
    detachedBaseCountRef.current = 0
    wheelUpAccumRef.current = 0
    setScrollDetached(false)
    setDetachedNewCount(0)
    element.scrollTop = element.scrollHeight
    rememberGeometry(element)
  }
  const detachChatScroll = () => {
    if (!pinnedToBottomRef.current) return
    pinnedToBottomRef.current = false
    detachedBaseCountRef.current = countVisibleMessages(messages)
    setScrollDetached(true)
  }
  /** 上一帧的内容总高度：滚动事件比帧回调先触发，用它还原「滚动发生时的底部」，
   * 不被同一帧里流式插入的新高度污染（竞态消除的关键）。 */
  const lastScrollHeightRef = useRef(0)
  /** 上一帧的视口高度：视口变高同样会让浏览器 clamp scrollTop（几何收缩而非手势）。 */
  const lastClientHeightRef = useRef(0)
  /** 上滑手势的方向累计：触控板 ±0.5px 步进不能单发解除吸底（按钮会闪），
   * 但也不能永远不解除——累计到 AGENT_CHAT_WHEEL_UP_DETACH_PX 再真正 detach。 */
  const wheelUpAccumRef = useRef(0)
  /** 记录「上一帧几何」：scrollTop 方向只有在几何没收缩时才可信，clamp 判定依赖它。 */
  const rememberGeometry = (element: HTMLElement) => {
    lastScrollTopRef.current = element.scrollTop
    lastScrollHeightRef.current = element.scrollHeight
    lastClientHeightRef.current = element.clientHeight
  }
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
  // PPT 任务槽：卡片是任务不是挂件——最新一张 + 所有等待态 + 已完成回执，最多 3 张，其余折叠。
  const [slidesShowAll, setSlidesShowAll] = useState(false)
  useEffect(() => { setSlidesShowAll(false) }, [currentSessionId])
  const slidesTasks = useMemo(() => slidesTaskEntries(toolCallsByRun), [toolCallsByRun])
  const slidesSelection = useMemo(
    () => selectSlidesTasks(slidesTasks, slidesShowAll ? Number.MAX_SAFE_INTEGER : 3),
    [slidesShowAll, slidesTasks],
  )
  const slidesTaskCards = useMemo(() => {
    const cards: Array<{ entry: SlidesTaskEntry; compact: boolean }> = []
    // run 终止后仍是 failed 才亮失败卡（失败不许消失）；运行中的失败先压住。
    const suppressed = (entry: SlidesTaskEntry): boolean => slidesFailureSuppressed(entry, runCompletedAtByRun)
    if (slidesSelection.primary && !suppressed(slidesSelection.primary)) cards.push({ entry: slidesSelection.primary, compact: false })
    for (const entry of slidesSelection.waiting) {
      if (!suppressed(entry)) cards.push({ entry, compact: false })
    }
    for (const entry of slidesSelection.receipts) {
      if (!suppressed(entry)) cards.push({ entry, compact: true })
    }
    return cards
  }, [slidesSelection, runCompletedAtByRun])

  // 配图后台逐张生成轮询：轮询状态以 documentId 为 key，切换文档即清 state/ref；
  // 响应校验 documentId 与 updatedAt，旧响应不得覆盖新广播（修 P1-7 串台）。
  const pageImagesPollDoc = useMemo(() => {
    const entries = [slidesSelection.primary, ...slidesSelection.waiting]
      .filter((entry): entry is SlidesTaskEntry => Boolean(entry))
    const target = entries.find((entry) => entry.progress.stage === 'page_images_review'
      && typeof entry.progress.documentId === 'string'
      && (entry.progress.pages ?? []).some((page) => !page.url && !page.failed && !page.rejected))
    return target?.progress.documentId ?? null
  }, [slidesSelection])
  const [polledByDoc, setPolledByDoc] = useState<Record<string, SlidesProgressState>>({})
  const pollUpdatedAtByDoc = useRef(new Map<string, number>())
  const pollBroadcastUpdatedAt = useMemo(() => {
    const entry = [slidesSelection.primary, ...slidesSelection.waiting]
      .find((candidate) => candidate?.progress.documentId === pageImagesPollDoc && pageImagesPollDoc !== null)
    return entry?.progress.updatedAt ?? 0
  }, [pageImagesPollDoc, slidesSelection])
  // 每个 documentId 各自的广播游标：切文档时不拿 A 的 updatedAt 去拒收 B 的响应。
  const pollBroadcastRef = useRef(new Map<string, number>())
  if (pageImagesPollDoc && pollBroadcastUpdatedAt > 0) {
    pollBroadcastRef.current.set(
      pageImagesPollDoc,
      Math.max(pollBroadcastRef.current.get(pageImagesPollDoc) ?? 0, pollBroadcastUpdatedAt),
    )
  }
  useEffect(() => {
    // 切文档：丢掉别的文档的轮询快照与游标，防 A 的图与序号打到 B 文档。
    setPolledByDoc((prev) => {
      if (!pageImagesPollDoc) return Object.keys(prev).length ? {} : prev
      const kept = prev[pageImagesPollDoc]
      if (kept && Object.keys(prev).length === 1) return prev
      return kept ? { [pageImagesPollDoc]: kept } : {}
    })
    pollUpdatedAtByDoc.current.clear()
    if (!pageImagesPollDoc) return
    const seed = pollBroadcastRef.current.get(pageImagesPollDoc) ?? 0
    if (seed > 0) pollUpdatedAtByDoc.current.set(pageImagesPollDoc, seed)
    if (typeof window === 'undefined') return
    let cancelled = false
    const timer = window.setInterval(() => {
      void window.nxcore?.slides.pageImagesStatus(pageImagesPollDoc)
        .then((status) => {
          if (cancelled || !status || status.stage !== 'page_images_review') return
          if (status.documentId && status.documentId !== pageImagesPollDoc) return
          const updatedAt = status.updatedAt ?? 0
          const cursor = pollUpdatedAtByDoc.current.get(pageImagesPollDoc) ?? 0
          if (updatedAt < cursor) return
          if (updatedAt) pollUpdatedAtByDoc.current.set(pageImagesPollDoc, updatedAt)
          setPolledByDoc((prev) => ({ ...prev, [pageImagesPollDoc]: status as unknown as SlidesProgressState }))
        })
        .catch(() => undefined)
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pageImagesPollDoc])
  const slidesDisplayState = (entry: SlidesTaskEntry): SlidesProgressState => (
    (entry.progress.documentId && polledByDoc[entry.progress.documentId]) || entry.progress
  )
  const handleSlidesAction = (prompt: string, displayText: string) => {
    onSlidesAction?.(prompt, displayText)
  }
  const handleOpenDraft = (documentId: string) => {
    onOpenDraft?.(documentId)
  }

  const activeHasAssistant = activeRunId
    ? messages.some((message) => message.runId === activeRunId && message.role === 'assistant')
    : false
  const userRunIds = useMemo(() => new Set(
    messages.filter((message) => message.role === 'user').map((message) => message.runId),
  ), [messages])
  const activeRunHasUserMessage = Boolean(activeRunId && userRunIds.has(activeRunId))
  const activeNavigationLink = activeRunId
    ? outgoingLinks.find((link) => link.sourceRunId === activeRunId)
    : undefined
  const activeNavigationPending = activeRunId ? pendingNavigationByRun[activeRunId] : undefined
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
    lastClientHeightRef.current = 0
    wheelUpAccumRef.current = 0
    pinnedToBottomRef.current = true
    detachedBaseCountRef.current = 0
    setScrollDetached(false)
    setDetachedNewCount(0)
  }, [currentSessionId])

  useEffect(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.role !== 'user') continue
      if (message.id !== lastUserMessageIdRef.current) {
        lastUserMessageIdRef.current = message.id
        // 用户发出新消息 = 明确的「看最新」意图：无论当前是否脱离底部都回到底部。
        const element = conversationRef.current
        if (element) attachChatScroll(element)
        else pinnedToBottomRef.current = true
      }
      break
    }
    if (!pinnedToBottomRef.current) {
      setDetachedNewCount(Math.max(0, countVisibleMessages(messages) - detachedBaseCountRef.current))
    }
  }, [messages])

  useEffect(() => {
    if (!pinnedToBottomRef.current) return
    const element = conversationRef.current
    if (!element || notificationTargetMessageId) return
    element.scrollTop = element.scrollHeight
    // 主动搬动滚动位置时同步参照值（jsdom 等无原生 scroll 事件的环境也保持一致）
    rememberGeometry(element)
  }, [activeRunId, linkedRun.messages, linkedRun.reasoning, linkedRun.tools, messages, notificationTargetMessageId, pendingApprovals, toolCallsByRun])

  // DOM 级滚动跟随：吸底时内容一长就贴底，不依赖 React 状态形状。MutationObserver
  // 每次正文变化都会回调，逐次读 scrollHeight 强制布局，事件风暴下按帧合并掉。
  // 解除吸底后这里不做任何自动回吸（#297：流式出字慢时上滑阅读会被拽回底部）；
  // 恢复跟随只由用户手势触发——滚回底部附近、点「回到最新」、发新消息。
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
        lastClientHeightRef.current = element.clientHeight
        if (notificationTargetActiveRef.current) return
        if (!pinnedToBottomRef.current) return
        element.scrollTop = element.scrollHeight
        rememberGeometry(element)
      })
    })
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // 输入框高度/面板高度变化也会改尾部预留的 padding（--agent-composer-height 是
  // ResizeObserver 实测后写在 frame.style 上的，不是 DOM mutation，MutationObserver
  // 看不到）。吸底时若不重新贴底，输入框变高会让内容底部与输入框之间露出空隙，
  // 下一次流式增长再猛跳一下；变矮时浏览器会 clamp scrollTop，由 onScroll 的
  // clamp 判定吞掉，不会误 detach。
  useEffect(() => {
    const frame = conversationRef.current?.parentElement
    if (!frame || typeof ResizeObserver === 'undefined') return undefined
    const shell = frame.querySelector<HTMLElement>('.agent-composer-shell')
    let scheduled: number | null = null
    // 挪到下一帧再贴底：ResizeObserver 回调顺序不保证先于 composer 自己写
    // --agent-composer-height 的那次回调，本帧读到的 scrollHeight 可能还没含新 padding。
    const sync = () => {
      scheduled = null
      const element = conversationRef.current
      if (!element) return
      lastScrollHeightRef.current = element.scrollHeight
      lastClientHeightRef.current = element.clientHeight
      if (notificationTargetActiveRef.current) return
      if (!pinnedToBottomRef.current) return
      element.scrollTop = element.scrollHeight
      rememberGeometry(element)
    }
    const observer = new ResizeObserver(() => {
      if (scheduled !== null) return
      scheduled = requestAnimationFrame(sync)
    })
    observer.observe(frame)
    if (shell) observer.observe(shell)
    return () => {
      observer.disconnect()
      if (scheduled !== null) cancelAnimationFrame(scheduled)
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

  /** 「已复制」回执的自动复位：短暂展示后回到复制图标，保证再次点击仍有可见反馈。 */
  const copiedResetTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (copiedResetTimerRef.current !== null) window.clearTimeout(copiedResetTimerRef.current)
  }, [])

  const copyMessage = async (messageId: string, content: string) => {
    try {
      await writeTextToClipboard(content)
      setCopiedMessageId(messageId)
      if (copiedResetTimerRef.current !== null) window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = window.setTimeout(() => setCopiedMessageId(null), 1600)
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
          // 通知定位用的 scrollIntoView 是程序性滚动：别把它的方向当成手势
          //（同 MutationObserver / 贴底 effect 的处理，避免定位时被抢底或误脱离）。
          if (notificationTargetActiveRef.current) {
            rememberGeometry(element)
            return
          }
          const lastTop = lastScrollTopRef.current
          lastScrollTopRef.current = element.scrollTop
          if (element.scrollTop < lastTop - 1) {
            // scrollTop 变小不一定是用户上滑：输入框变矮（尾部 padding 收缩）、
            // 折叠卡/图片重排、视口变高时，浏览器把 scrollTop 夹回新的最大值并照常
            // 派发 scroll 事件。误判成手势会「人还在底部却脱离吸底」，下一次下滚
            // 又被吸回来，形成抖动闭环。几何收缩量与上移量一致时按 clamp 处理。
            if (isGeometryClampScroll({
              lastScrollTop: lastTop,
              scrollTop: element.scrollTop,
              lastScrollHeight: lastScrollHeightRef.current,
              scrollHeight: element.scrollHeight,
              lastClientHeight: lastClientHeightRef.current,
              clientHeight: element.clientHeight,
            })) {
              rememberGeometry(element)
              return
            }
            detachChatScroll()
            return
          }
          // 亚像素步进（触控板慢扫、滚轮平滑滚动收尾常为 ±0.5px）不能当方向信号：
          // 上滑初段必然还在回吸阈值内，落进回吸判定就会被逐步拽回底部
          //（表现为在底部上滑时抖动、慢扫离不开底部），只有明确向下才回吸。
          if (element.scrollTop <= lastTop + 1) return
          // 到过「上一帧的底部」即算跟到底：同一帧里流式插入会推高当前底部，
          // 用当前几何判定会被顶出阈值（概率性吸不上），上一帧高度没有这个问题。
          // 还没有任何内容批次时（初始为 0）退回当前高度，避免误判成「到底了」。
          const referenceHeight = lastScrollHeightRef.current || element.scrollHeight
          const reachedPreviousBottom = element.scrollTop
            >= referenceHeight - element.clientHeight - AGENT_CHAT_REPIN_DISTANCE_PX
          if (reachedPreviousBottom && !pinnedToBottomRef.current) attachChatScroll(element)
        }}
        onWheel={(event) => {
          // wheel 先于 scroll 事件：向上立即解除吸底，向上滚动不会被下一次
          // 强制滚底吃掉；向下且确实已到可见底部附近才视为「想跟回」。
          // 触控板慢扫/平滑滚动收尾是 ±0.5px 级亚像素步进：向上按方向累计到
          // 2px 才脱离（单发不闪按钮，极慢扫也能累计脱离），向下的亚像素/横向
          // 滚动（deltaY≈0）不做任何回吸。731c430b 只修了 onScroll，这里补齐。
          // 内层可滚动块（工具输出、房间选择列表）吃掉的手势不改写外层状态。
          const element = conversationRef.current
          if (!element) return
          if (isNestedScrollerWheel(event.target, element, event.deltaY)) return
          if (event.deltaY < 0) {
            wheelUpAccumRef.current += -event.deltaY
            if (wheelUpAccumRef.current < AGENT_CHAT_WHEEL_UP_DETACH_PX) return
            wheelUpAccumRef.current = 0
            detachChatScroll()
            return
          }
          wheelUpAccumRef.current = 0
          if (event.deltaY < 1) {
            // 极小的向下分量/纯横向滚动不构成反向手势：只衰减上滑累计，
            // 避免斜向慢扫或触控板噪声把「正在上滑」的累计直接清零。
            wheelUpAccumRef.current = Math.max(0, wheelUpAccumRef.current - event.deltaY)
            return
          }
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight
          // 追赶带随本次位移放款：流式爆发时固定 32px 永远追不上底部（生成进行中滑不到底）。
          if (distance <= wheelDownChaseBand(event.deltaY) && !pinnedToBottomRef.current) attachChatScroll(element)
        }}
      >
          {incomingLink ? (
            <>
              <SessionReference link={incomingLink} onOpen={() => onOpenSessionLink(incomingLink)} />
              <LinkedRunProgress agentNamesById={agentNamesById} failedRunIds={failedRunIds} state={linkedRun} />
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
            // 分级答复（answer-tiering）：displayContent 是默认展示层（L0+L1），
            // 差值折叠为「查看详情」。gateway 拼装的 content 以 displayContent
            // 为前缀（trim 边界可能有细微空白差，前缀校验失败就不分级——
            // 保守退化成整段展示，绝不丢内容）。流式期间照常流全文，run 完成
            // 切分级；无标记的消息 displayContent 为 undefined，行为不变。
            const tieredDisplay = activity?.finalDisplayContent ?? message.displayContent
            let displayFinalContent = rawFinalContent
            let tieredDetails: string | undefined
            if (
              tieredDisplay !== undefined && tieredDisplay.trim()
              && !message.streaming && rawFinalContent.trimStart().startsWith(tieredDisplay.trimEnd())
              && rawFinalContent.trim().length > tieredDisplay.trim().length
            ) {
              const prefixEnd = rawFinalContent.indexOf(tieredDisplay.trimEnd())
              const rest = prefixEnd >= 0 ? rawFinalContent.slice(prefixEnd + tieredDisplay.trimEnd().length) : ''
              if (rest.trim()) {
                displayFinalContent = tieredDisplay
                tieredDetails = rest
              }
            }
            const finalContent = localizeAgentAnswer(displayFinalContent, t)
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
              // 气泡正文：批注消息只显示输入框正文（displayContent）；空串＝纯批注
              // 发送——无气泡，只有上方卡片。旧数据/普通消息回退 content。
              const bubbleText = message.noteCards?.length
                ? (message.displayContent ?? message.content)
                : message.content
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
                  {/* 用户气泡 + 操作行（复制 / 重新发送）包成一个右对齐整体：
                      按钮与 agent 消息下方按钮同规格，默认隐藏、hover 整块才浮现。
                      纯批注消息（无气泡）不显示操作行——content 是展示文案，
                      重发会以新 run 重跑技术指令，语义不对。 */}
                  <div className="agent-user-turn" data-agent-message-id={message.id} data-notification-target={String(highlightedNotificationTarget?.messageId === message.id)}>
                    {message.noteCards?.length ? (
                      <UserNoteCards cards={message.noteCards} />
                    ) : null}
                    {bubbleText ? (
                      <>
                        <article className="agent-message" data-role="user">
                          <p>{bubbleText}</p>
                        </article>
                        <div className="agent-message-actions agent-user-actions">
                          <button
                            type="button"
                            aria-label={t('surface:agentChat.copyPrompt')}
                            title={t('surface:agentChat.copyPrompt')}
                            onClick={() => void copyMessage(message.id, message.content)}
                          >
                            <Copy aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('surface:agentChat.resend')}
                            title={t('surface:agentChat.resend')}
                            disabled={!message.content.trim() || message.content.includes('[附件：')}
                            onClick={() => onRetryPrompt(message.content, message.runId)}
                          >
                            <RotateCcw aria-hidden="true" />
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
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
                      // 时间线已带流动思考行（live）时，状态行不再重复 tail 预览。
                      tail={!hasToolActivity && !hasLiveTool(tools) && !rawFinalContent.trim()
                        ? reasoningTail(reasoningByRun[message.runId])
                        : undefined}
                    />
                  )
                  : null}
                {/* 思考已按工具分段进时间线（segment + live 行）：有工具活动时
                    不再在顶部渲染总块，避免同一段思考两处重复。 */}
                {!hasToolActivity ? (
                  <ReasoningBlock
                    active={message.runId === activeRunId}
                    content={reasoningByRun[message.runId] ?? ''}
                  />
                ) : null}
                {hasToolActivity && activity ? (
                  <AgentExecutionTimeline
                    activity={activity}
                    runStartedAt={runStartedAtByRun[message.runId]}
                    runCompletedAt={runCompletedAtByRun[message.runId]}
                    sessionId={currentSessionId}
                    failedRunIds={failedRunIds}
                  />
                ) : null}
                {partialContent ? (
                  <div className="agent-linked-status" role="status">{t('surface:agentChat.theRunEndedUnexpectedlyHereIsThePartial')}</div>
                ) : null}
                {finalContent ? (
                  <div className="agent-assistant-response">
                    <AgentResponseByline agentId={authorAgentId} names={agentNamesById} />
                    <article className="agent-message" data-role="assistant">
                      <AssistantMessageContent content={finalContent} />
                      {tieredDetails ? <AgentAnswerDetails details={localizeAgentAnswer(tieredDetails, t)} /> : null}
                    </article>
                  </div>
                ) : null}
                {(() => {
                  const turnFiles = runTurnFiles(tools)
                  return turnFiles.length > 0 ? <AgentTurnFilesCard files={turnFiles} /> : null
                })()}
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
                // 时间线已带流动思考行（live）时，状态行不再重复 tail 预览。
                tail={latestActivity?.hasTools ? undefined : reasoningTail(reasoningByRun[activeRunId])}
              />
              {/* 思考已按工具分段进时间线：有工具活动时不再重复顶部总块。 */}
              {!latestActivity?.hasTools ? (
                <ReasoningBlock active content={reasoningByRun[activeRunId] ?? ''} />
              ) : null}
              {latestActivity?.hasTools ? (
                <AgentExecutionTimeline
                  activity={latestActivity}
                  runStartedAt={runStartedAtByRun[activeRunId]}
                  runCompletedAt={runCompletedAtByRun[activeRunId]}
                  sessionId={currentSessionId}
                  failedRunIds={failedRunIds}
                />
              ) : null}
              {/* 本轮文件产物随生成实时出现（工具转终态即有 fileId），不必等正文。 */}
              <AgentTurnFilesCard files={runTurnFiles(latestTools)} />
            </div>
          ) : null}
          {activeRunId && activeHasAssistant && !latestStreamingMessage && !latestActivity?.hasTools
            ? (
              // 该分支下消息循环里最后一条 assistant 消息已带 active 的
              // ReasoningBlock（active=true），这里只补状态行，不再重复折叠块。
              <ThinkingStatus
                label={getThinkingLabel(undefined, latestTools, t)}
                tail={reasoningTail(reasoningByRun[activeRunId])}
              />
            )
            : null}          {composerNotice}
          {slidesTaskCards.length > 0 ? (
            <div className="agent-slides-task-stack">
              {slidesTaskCards.map(({ entry, compact }) => (
                <SlidesProgressCard
                  key={entry.tool.id}
                  state={slidesDisplayState(entry)}
                  toolRunning={entry.tool.status === 'running' || entry.tool.status === 'pending'}
                  busy={submitting}
                  startedAt={entry.tool.startedAt}
                  completedAt={entry.tool.completedAt}
                  runId={entry.tool.runId}
                  toolStatus={entry.tool.status}
                  compact={compact}
                  onAction={handleSlidesAction}
                  onOpenDraft={handleOpenDraft}
                  cancelledRunIds={cancelledRunIds}
                  interruptedRunIds={interruptedRunIds}
                />
              ))}
              {slidesSelection.foldedCount > 0 ? (
                <button
                  type="button"
                  className="agent-slides-folded"
                  onClick={() => setSlidesShowAll(true)}
                >
                  {t('surface:agentChat.SLIDES_MORE_TASKS', { count: slidesSelection.foldedCount })}
                </button>
              ) : null}
            </div>
          ) : null}
          <AgentShellApproval
            approvals={pendingApprovals}
            resolvingApprovalIds={resolvingApprovalIds}
            onResolve={onResolveApproval}
          />
          {loading && messages.length === 0 ? <div className="agent-loading">{t('surface:agentChat.loadingConversation')}</div> : null}
          {error ? (
            <div className="agent-error" role="alert">
              <span>{error}</span>
              {onContinueRun ? (
                <button type="button" className="agent-error-retry" onClick={onContinueRun}>
                  {t('surface:agentChat.continueRun')}
                </button>
              ) : null}
              {onRetryError ? (
                <button type="button" className="agent-error-retry" onClick={onRetryError}>
                  {t('surface:agentComposer.retry')}
                </button>
              ) : null}
            </div>
          ) : null}
      </div>
      {scrollDetached ? (
        <button
          type="button"
          className="agent-chat-jump-latest"
          aria-label={t('surface:agentChat.backToLatest')}
          title={t('surface:agentChat.backToLatest')}
          onClick={() => {
            const element = conversationRef.current
            if (element) attachChatScroll(element)
          }}
        >
          <ArrowDown aria-hidden="true" />
          {detachedNewCount > 0 ? <span className="agent-chat-jump-latest-count">{detachedNewCount}</span> : null}
        </button>
      ) : null}
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
