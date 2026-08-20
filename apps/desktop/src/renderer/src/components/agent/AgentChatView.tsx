import { Check, ChevronRight, CircleHelp, Copy, FileText, Folder, FolderKanban, Link2, MessageSquareText, RotateCcw, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { AgentRunActivity } from './agentRunActivity'
import { parseAgentDocumentIntentResult, type AgentDocumentIntentResult } from './agentDocumentIntent'
import { parseAgentNavigationTarget } from './agentNavigation'
import { formatAgentOutput } from './agentOutputFormat'
import { parseAgentRoomSelectionResult } from './agentRoomSelection'
import { AgentDocumentPicker } from './AgentDocumentPicker'
import { useRoomDocumentsState } from '../context-room/RoomDocumentsProvider'
import {
  findPendingAgentDocumentSelection,
  type AgentDocumentSelectionItem,
  type AgentDocumentSelectionSubmission,
} from './agentDocumentSelection'
import { useLinkedAgentRun, type LinkedAgentRunState } from './useLinkedAgentRun'
import type { DisplayAgentMessage, DisplayAgentToolCall } from './useAgentSession'
import type { AgentNavigationTarget, AgentRoomReference, AgentSessionLink, PendingAgentIntent, RoomDocument } from '@nxcore/agent-contract'
import type { ActiveDocumentDescriptor } from './activeDocumentContext'
import { writeTextToClipboard } from '../../lib/systemClipboard'
import { useLocale, type Translate } from '../../i18n/LocaleContext'
import { pageLabelKey } from '../../data/navigation'

const quickPrompts = [
  ['surface:agentChat.quickPromptSummarizeLabel', 'surface:agentChat.quickPromptSummarize'],
  ['surface:agentChat.quickPromptRisksLabel', 'surface:agentChat.quickPromptRisks'],
  ['surface:agentChat.quickPromptTasksLabel', 'surface:agentChat.quickPromptTasks'],
] as const

function ThinkingStatus({ label }: { label: string }) {
  return (
    <div className="agent-thinking" role="status">
      <span className="agent-thinking-text" data-text={label}>{label}</span>
    </div>
  )
}

function getThinkingLabel(message: DisplayAgentMessage | undefined, tools: DisplayAgentToolCall[], t: Translate): string {
  const runningTool = tools.find((tool) => tool.status === 'running' || tool.status === 'pending')
  if (runningTool) return t('surface:agentChat.callingATool')
  if (message?.content.trim()) return t('surface:agentChat.writingAResponse')
  if (tools.length > 0) return t('surface:agentChat.organizingResults')
  return t('surface:agentChat.analyzing')
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
                <small>{currentRoom ? room.kind ?? 'Room' : t('surface:agentChat.unavailable')}</small>
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

function FormattedAgentText({ content }: { content: string }) {
  return formatAgentOutput(content).map((block, index) => {
    if (block.type === 'paragraph') return <p key={`${index}:${block.text}`}>{block.text}</p>
    const List = block.ordered ? 'ol' : 'ul'
    return (
      <List key={`${index}:${block.items.join('\u0000')}`} className="agent-output-list">
        {block.items.map((item, itemIndex) => <li key={`${itemIndex}:${item}`}>{item}</li>)}
      </List>
    )
  })
}

function AssistantMessageContent({ content }: { content: string }) {
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
}

const navigationPageLabels: Record<string, string> = {
  home: 'surface:navigation.home',
  rooms: 'surface:navigation.contextRoom',
  docs: 'surface:navigation.documents',
  sources: 'surface:navigation.sources',
  memory: 'surface:navigation.memory',
  tasks: 'surface:navigation.tasks',
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

function LinkedRunProgress({ state }: { state: LinkedAgentRunState }) {
  const { t } = useLocale()
  const active = state.status === 'accepted' || state.status === 'running'
  const assistantMessage = [...state.messages].reverse().find((message) => message.role === 'assistant')
  const finalContent = state.documentPending
    ? ''
    : state.activity.hasTools
      ? state.activity.finalAnswer
        || state.activity.pendingAnswer
        || (state.activity.completed ? assistantMessage?.content || '' : '')
      : assistantMessage?.content || ''

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
          />
        ) : null}
        {state.status === 'completed' && !finalContent ? (
          <div className="agent-linked-status" role="status">{t('surface:agentChat.creationComplete')}</div>
        ) : null}
        {state.error ? <div className="agent-error" role="alert">{state.error}</div> : null}
      </section>
      {finalContent ? (
        <article className="agent-message" data-role="assistant">
          <AssistantMessageContent content={finalContent} />
        </article>
      ) : null}
    </>
  )
}

export function AgentChatView({
  activeDocument,
  activeRunId,
  activityByRun,
  availableRooms,
  composer,
  currentSessionId,
  draftHasContent,
  error,
  loading,
  messages,
  onRetryPrompt,
  onOpenSessionLink,
  onRejectDocumentIntent,
  onSelectRoom,
  onSelectDocument,
  onSelectPrompt,
  pendingNavigationByRun,
  runCompletedAtByRun,
  runStartedAtByRun,
  scopeReady,
  sessionLinks,
  submitting,
  toolCallsByRun,
}: {
  activeDocument: ActiveDocumentDescriptor | null
  activeRunId: string | null
  activityByRun: Record<string, AgentRunActivity>
  availableRooms: AgentRoomReference[]
  composer: ReactNode
  currentSessionId: string | null
  draftHasContent: boolean
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  onRetryPrompt: (prompt: string) => void
  onOpenSessionLink: (link: AgentSessionLink) => void
  onRejectDocumentIntent: () => void
  onSelectRoom: (
    room: AgentRoomReference,
    intent: PendingAgentIntent,
    document?: AgentDocumentSelectionItem,
  ) => Promise<void>
  onSelectDocument: (selection: AgentDocumentSelectionSubmission) => void
  onSelectPrompt: (prompt: string) => void
  pendingNavigationByRun: Record<string, AgentNavigationTarget>
  runCompletedAtByRun: Record<string, string>
  runStartedAtByRun: Record<string, string>
  scopeReady: boolean
  sessionLinks: AgentSessionLink[]
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
  const handledDocumentSelectionsRef = useRef(new Set<string>())
  const { documentsByRoom } = useRoomDocumentsState()
  const conversationRef = useRef<HTMLDivElement>(null)
  const hasConversation = messages.length > 0 || sessionLinks.length > 0
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

  const latestStreamingMessage = useMemo(
    () => [...messages].reverse().find((message) => (
      message.runId === activeRunId && message.role === 'assistant' && message.streaming
    )),
    [activeRunId, messages],
  )
  const latestTools = activeRunId ? toolCallsByRun[activeRunId] ?? [] : []
  const latestActivity = activeRunId ? activityByRun[activeRunId] : undefined
  const activeHasAssistant = activeRunId
    ? messages.some((message) => message.runId === activeRunId && message.role === 'assistant')
    : false
  const activeRunPending = Boolean(activeRunId && !runCompletedAtByRun[activeRunId])
  const activeRunHasUserMessage = Boolean(activeRunId && messages.some((message) => (
    message.role === 'user' && message.runId === activeRunId
  )))
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
      const result = parseAgentRoomSelectionResult(tool.result)
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
  const pendingDocumentIntent = useMemo(() => {
    const candidates = Object.values(toolCallsByRun)
      .flat()
      .filter((tool) => tool.name === 'context_room_document_intent' && tool.status === 'completed')
      .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
    for (const tool of candidates) {
      if (dismissedDocumentIntents.has(tool.id)) continue
      const result = parseAgentDocumentIntentResult(tool.result)
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

  useEffect(() => {
    const element = conversationRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [activeRunId, linkedRun.messages, linkedRun.reasoning, linkedRun.tools, messages, toolCallsByRun])

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

  const copyMessage = async (messageId: string, content: string) => {
    try {
      await writeTextToClipboard(content)
      setCopiedMessageId(messageId)
    } catch {
      setCopiedMessageId(null)
    }
  }

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
      <div ref={conversationRef} className="agent-conversation" aria-live="polite">
          {incomingLink ? (
            <>
              <SessionReference link={incomingLink} onOpen={() => onOpenSessionLink(incomingLink)} />
              <LinkedRunProgress state={linkedRun} />
            </>
          ) : null}
          {messages.map((message, index) => {
            if (message.role === 'system') return null
            const tools = toolCallsByRun[message.runId] ?? []
            const activity = activityByRun[message.runId]
            const hasToolActivity = Boolean(activity?.hasTools)
            const finalContent = hasToolActivity
              ? activity?.finalAnswer || activity?.pendingAnswer || (
                activity?.completed && !message.streaming && runCompletedAtByRun[message.runId] ? message.content : ''
              )
              : message.content
            const partialContent = Boolean(
              hasToolActivity && activity && !activity.completed && runCompletedAtByRun[message.runId] && finalContent,
            )
            const previousUserMessage = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user')
            const showActions = message.role === 'assistant' && !message.streaming
              && !partialContent && Boolean(finalContent.trim())
            const link = outgoingLinks.find((item) => item.sourceRunId === message.runId)
            const navigationResult = (toolCallsByRun[message.runId] ?? []).some((tool) => (
              tool.status === 'completed' && Boolean(parseAgentNavigationTarget(tool.result))
            ))
            const pending = !runCompletedAtByRun[message.runId] || navigationResult
              ? pendingNavigationByRun[message.runId]
              : undefined
            const runHasUserMessage = messages.some((item) => (
              item.role === 'user' && item.runId === message.runId
            ))

            if (message.role === 'user') {
              return (
                <Fragment key={message.id}>
                  <article className="agent-message" data-role="user"><p>{message.content}</p></article>
                  <RunNavigation link={link} pending={link ? undefined : pending} onOpen={onOpenSessionLink} />
                </Fragment>
              )
            }

            return (
              <div key={message.id} className="agent-assistant-turn">
                {!runHasUserMessage ? (
                  <RunNavigation link={link} pending={link ? undefined : pending} onOpen={onOpenSessionLink} />
                ) : null}
                {message.streaming && message.runId === activeRunId
                  ? <ThinkingStatus label={getThinkingLabel(message, tools, t)} />
                  : null}
                {hasToolActivity && activity ? (
                  <AgentExecutionTimeline
                    activity={activity}
                    runStartedAt={runStartedAtByRun[message.runId]}
                    runCompletedAt={runCompletedAtByRun[message.runId]}
                  />
                ) : null}
                {partialContent ? (
                  <div className="agent-linked-status" role="status">{t('surface:agentChat.theRunEndedUnexpectedlyHereIsThePartial')}</div>
                ) : null}
                {finalContent ? (
                  <article className="agent-message" data-role="assistant"><AssistantMessageContent content={finalContent} /></article>
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
                      disabled={!previousUserMessage}
                      onClick={() => previousUserMessage && onRetryPrompt(previousUserMessage.content)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {activeRunId && !activeHasAssistant ? (
            <div className="agent-assistant-turn is-pending">
              {!activeRunHasUserMessage ? (
                <RunNavigation
                  link={activeNavigationLink}
                  pending={activeNavigationLink ? undefined : activeNavigationPending}
                  onOpen={onOpenSessionLink}
                />
              ) : null}
              <ThinkingStatus label={getThinkingLabel(undefined, latestTools, t)} />
              {latestActivity?.hasTools ? (
                <AgentExecutionTimeline
                  activity={latestActivity}
                  runStartedAt={runStartedAtByRun[activeRunId]}
                  runCompletedAt={runCompletedAtByRun[activeRunId]}
                />
              ) : null}
            </div>
          ) : null}
          {activeRunId && activeHasAssistant && !latestStreamingMessage && !latestActivity?.hasTools
            ? <ThinkingStatus label={getThinkingLabel(undefined, latestTools, t)} />
            : null}
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
        {quickPrompts.map(([label, prompt]) => (
          <button key={label} type="button" onClick={() => onSelectPrompt(t(prompt))}>{t(label)}</button>
        ))}
      </div>
    </section>
  )
}
