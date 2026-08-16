import { Brain, Check, ChevronRight, Copy, FileText, Folder, FolderKanban, Link2, RotateCcw, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import { parseAgentNavigationTarget } from './agentNavigation'
import { formatAgentOutput } from './agentOutputFormat'
import { parseAgentRoomSelectionResult } from './agentRoomSelection'
import { useLinkedAgentRun, type LinkedAgentRunState } from './useLinkedAgentRun'
import type { DisplayAgentMessage, DisplayAgentToolCall } from './useAgentSession'
import type { AgentNavigationTarget, AgentRoomReference, AgentSessionLink } from '@nxcore/agent-contract'

const quickPrompts = [
  ['总结当前页面的重点，并列出下一步', '总结当前页面最重要的内容，并按优先级列出下一步。'],
  ['检查当前上下文中的风险与冲突', '检查当前上下文中可能存在的风险、冲突和遗漏。'],
  ['基于当前上下文整理待办事项', '基于当前上下文整理一份清晰的待办事项。'],
] as const

function ThinkingStatus({ label }: { label: string }) {
  return (
    <div className="agent-thinking" role="status">
      <span className="agent-thinking-text" data-text={label}>{label}</span>
    </div>
  )
}

function ReasoningBlock({ active, content }: { active: boolean; content: string }) {
  if (!content) return null
  return (
    <details className="agent-reasoning" open={active}>
      <summary><Brain aria-hidden="true" />思考过程</summary>
      <div className="agent-reasoning-content"><FormattedAgentText content={content} /></div>
    </details>
  )
}

function getThinkingLabel(message: DisplayAgentMessage | undefined, tools: DisplayAgentToolCall[]): string {
  if (message?.content.trim()) return '正在生成回答...'
  const runningTool = tools.find((tool) => tool.status === 'running' || tool.status === 'pending')
  if (runningTool) return '正在调用工具...'
  if (tools.length > 0) return '正在整理结果...'
  return '正在分析问题...'
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
  const availableById = new Map(availableRooms.map((room) => [room.id, room]))
  return (
    <section className="agent-room-selection" aria-label="选择文档所在 Room">
      <header>
        <span><FolderKanban aria-hidden="true" /><strong>选择文档所在 Room</strong></span>
        <button type="button" aria-label="取消选择 Room" title="取消" disabled={busy} onClick={onCancel}>
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
              title={currentRoom ? room.title : `${listedRoom.title}（已不可用）`}
              onClick={() => currentRoom && onSelect(room)}
            >
              <Folder aria-hidden="true" />
              <span>
                <strong>{room.title}</strong>
                <small>{currentRoom ? room.kind ?? 'Room' : '已不可用'}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          )
        }) : <p>暂无可用 Room</p>}
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
  const match = generatedDocumentPattern.exec(content)
  if (!match || match.index === undefined) return <FormattedAgentText content={content} />

  const before = content.slice(0, match.index).trim()
  const after = content.slice(match.index + match[0].length).trim()
  const title = match[1].trim()

  return (
    <>
      {before ? <FormattedAgentText content={before} /> : null}
      <div className="agent-artifact" role="status" aria-label={`文档已生成：${title}`}>
        <span className="agent-artifact-icon" aria-hidden="true"><FileText /></span>
        <span className="agent-artifact-copy">
          <strong>{title}</strong>
          <small>文档已生成</small>
        </span>
      </div>
      {after ? <FormattedAgentText content={after} /> : null}
    </>
  )
}

const navigationPageLabels: Record<string, string> = {
  home: '首页',
  rooms: 'Context Room',
  docs: '文档',
  sources: '数据源',
  memory: '记忆',
  tasks: '任务',
  diary: '日记',
}

function SessionReference({ link, onOpen }: { link: AgentSessionLink; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="agent-navigation-status agent-session-reference"
      title={`${link.sourcePageLabel} · ${link.target.title}`}
      onClick={onOpen}
    >
      <Link2 aria-hidden="true" />
      <span>引用自 {link.sourcePageLabel} · {link.target.title}</span>
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
  if (link) {
    return (
      <button
        type="button"
        className="agent-navigation-status"
        aria-label={`前往${navigationPageLabels[link.target.pageId] ?? link.target.pageId}`}
        title={link.target.title}
        onClick={() => onOpen(link)}
      >
        <Check aria-hidden="true" />
        <span>已前往「{link.target.title}」继续创建</span>
        <ChevronRight aria-hidden="true" />
      </button>
    )
  }
  if (!pending) return null
  return (
    <div className="agent-navigation-status is-pending" role="status" title={pending.title}>
      <Link2 aria-hidden="true" />
      <span>前往「{pending.title}」继续创建</span>
    </div>
  )
}

function LinkedRunProgress({ state }: { state: LinkedAgentRunState }) {
  const active = state.status === 'accepted' || state.status === 'running'
  const assistantMessage = [...state.messages].reverse().find((message) => message.role === 'assistant')

  return (
    <>
      <section className="agent-linked-run" aria-label="引用任务进度">
        {state.loading ? <ThinkingStatus label="正在同步工作进度..." /> : null}
        {active ? (
          <ThinkingStatus label={state.documentPending ? '正在编辑文档...' : getThinkingLabel(assistantMessage, state.tools)} />
        ) : null}
        <ReasoningBlock active={active} content={state.reasoning} />
        <AgentExecutionTimeline
          tools={state.tools}
          runStartedAt={state.startedAt}
          runCompletedAt={state.completedAt}
          continuing={state.documentPending}
          continuationLabel="正在编辑文档"
        />
        {state.status === 'completed' && !assistantMessage?.content ? (
          <div className="agent-linked-status" role="status">创建已完成</div>
        ) : null}
        {state.error ? <div className="agent-error" role="alert">{state.error}</div> : null}
      </section>
      {assistantMessage?.content ? (
        <article className="agent-message" data-role="assistant">
          <AssistantMessageContent content={assistantMessage.content} />
        </article>
      ) : null}
    </>
  )
}

export function AgentChatView({
  activeRunId,
  availableRooms,
  composer,
  currentSessionId,
  draftHasContent,
  error,
  loading,
  messages,
  onRetryPrompt,
  onOpenSessionLink,
  onSelectRoom,
  onSelectPrompt,
  pendingNavigationByRun,
  reasoningByRun,
  runCompletedAtByRun,
  runStartedAtByRun,
  scopeReady,
  sessionLinks,
  submitting,
  toolCallsByRun,
}: {
  activeRunId: string | null
  availableRooms: AgentRoomReference[]
  composer: ReactNode
  currentSessionId: string | null
  draftHasContent: boolean
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  onRetryPrompt: (prompt: string) => void
  onOpenSessionLink: (link: AgentSessionLink) => void
  onSelectRoom: (room: AgentRoomReference) => void
  onSelectPrompt: (prompt: string) => void
  pendingNavigationByRun: Record<string, AgentNavigationTarget>
  reasoningByRun: Record<string, string>
  runCompletedAtByRun: Record<string, string>
  runStartedAtByRun: Record<string, string>
  scopeReady: boolean
  sessionLinks: AgentSessionLink[]
  submitting: boolean
  toolCallsByRun: Record<string, DisplayAgentToolCall[]>
}) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [dismissedRoomSelections, setDismissedRoomSelections] = useState<Set<string>>(() => new Set())
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
  const activeHasAssistant = activeRunId
    ? messages.some((message) => message.runId === activeRunId && message.role === 'assistant')
    : false
  const pendingRoomSelection = useMemo(() => {
    const candidates = Object.values(toolCallsByRun)
      .flat()
      .filter((tool) => tool.name === 'context_room_list' && tool.status === 'completed')
      .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))
    for (const tool of candidates) {
      if (dismissedRoomSelections.has(tool.id)) continue
      const result = parseAgentRoomSelectionResult(tool.result)
      if (!result) continue
      const completedAt = Date.parse(tool.completedAt ?? tool.startedAt)
      const hasLaterUserMessage = messages.some((message) => (
        message.role === 'user' && Date.parse(message.createdAt) > completedAt
      ))
      if (!hasLaterUserMessage) return { tool, rooms: result.rooms }
    }
    return null
  }, [dismissedRoomSelections, messages, toolCallsByRun])

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
    if (!scopeReady) {
      setQuickPromptsReady(false)
      return
    }
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

  const copyMessage = async (message: DisplayAgentMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedMessageId(message.id)
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
      {confirmedEmpty ? <div className="agent-chat-empty-heading"><h2>开始一段新对话</h2></div> : null}
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
            const previousUserMessage = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user')
            const showActions = message.role === 'assistant' && !message.streaming && Boolean(message.content.trim())

            if (message.role === 'user') {
              const link = outgoingLinks.find((item) => item.sourceRunId === message.runId)
              const navigationResult = (toolCallsByRun[message.runId] ?? []).some((tool) => (
                tool.status === 'completed' && Boolean(parseAgentNavigationTarget(tool.result))
              ))
              const pending = !runCompletedAtByRun[message.runId] || navigationResult
                ? pendingNavigationByRun[message.runId]
                : undefined
              return (
                <Fragment key={message.id}>
                  <article className="agent-message" data-role="user"><p>{message.content}</p></article>
                  <RunNavigation link={link} pending={link ? undefined : pending} onOpen={onOpenSessionLink} />
                </Fragment>
              )
            }

            return (
              <div key={message.id} className="agent-assistant-turn">
                {message.streaming && message.runId === activeRunId
                  ? <ThinkingStatus label={getThinkingLabel(message, tools)} />
                  : null}
                <ReasoningBlock active={message.runId === activeRunId} content={reasoningByRun[message.runId] ?? ''} />
                <AgentExecutionTimeline
                  tools={tools}
                  runStartedAt={runStartedAtByRun[message.runId]}
                  runCompletedAt={runCompletedAtByRun[message.runId]}
                />
                {message.content ? (
                  <article className="agent-message" data-role="assistant"><AssistantMessageContent content={message.content} /></article>
                ) : null}
                {showActions ? (
                  <div className="agent-message-actions">
                    <button type="button" aria-label="复制回答" title="复制回答" onClick={() => void copyMessage(message)}>
                      {copiedMessageId === message.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      aria-label="重新生成"
                      title="重新生成"
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
              <ThinkingStatus label={getThinkingLabel(undefined, latestTools)} />
              <ReasoningBlock active content={reasoningByRun[activeRunId] ?? ''} />
              <AgentExecutionTimeline
                tools={latestTools}
                runStartedAt={runStartedAtByRun[activeRunId]}
                runCompletedAt={runCompletedAtByRun[activeRunId]}
              />
            </div>
          ) : null}
          {activeRunId && activeHasAssistant && !latestStreamingMessage
            ? <ThinkingStatus label={getThinkingLabel(undefined, latestTools)} />
            : null}
          {pendingRoomSelection ? (
            <RoomSelection
              availableRooms={availableRooms}
              busy={loading || submitting || Boolean(activeRunId)}
              rooms={pendingRoomSelection.rooms}
              onCancel={() => {
                setDismissedRoomSelections((current) => new Set(current).add(pendingRoomSelection.tool.id))
              }}
              onSelect={onSelectRoom}
            />
          ) : null}
          {loading && messages.length === 0 ? <div className="agent-loading">正在载入会话...</div> : null}
          {error ? <div className="agent-error" role="alert">{error}</div> : null}
      </div>
      {composer}
      <div className="agent-chat-quick-prompts" aria-label="快捷提示" aria-hidden={!quickPromptsReady}>
        {quickPrompts.map(([label, prompt]) => (
          <button key={label} type="button" onClick={() => onSelectPrompt(prompt)}>{label}</button>
        ))}
      </div>
    </section>
  )
}
