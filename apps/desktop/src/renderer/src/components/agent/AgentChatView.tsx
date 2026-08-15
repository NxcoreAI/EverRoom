import { Brain, Check, Copy, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { DisplayAgentMessage, DisplayAgentToolCall } from './useAgentSession'

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
      <p>{content}</p>
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

export function AgentChatView({
  activeRunId,
  composer,
  draftHasContent,
  error,
  loading,
  messages,
  onRetryPrompt,
  onSelectPrompt,
  reasoningByRun,
  runCompletedAtByRun,
  runStartedAtByRun,
  submitting,
  toolCallsByRun,
}: {
  activeRunId: string | null
  composer: ReactNode
  draftHasContent: boolean
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  onRetryPrompt: (prompt: string) => void
  onSelectPrompt: (prompt: string) => void
  reasoningByRun: Record<string, string>
  runCompletedAtByRun: Record<string, string>
  runStartedAtByRun: Record<string, string>
  submitting: boolean
  toolCallsByRun: Record<string, DisplayAgentToolCall[]>
}) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const hasConversation = messages.length > 0 || Boolean(activeRunId) || loading || submitting || Boolean(error)

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
  }, [activeRunId, messages, toolCallsByRun])

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
      data-empty={String(!hasConversation)}
    >
      <div className="agent-chat-empty-heading"><h2>开始一段新对话</h2></div>
      <div ref={conversationRef} className="agent-conversation" aria-live="polite">
          {messages.map((message, index) => {
            if (message.role === 'system') return null
            const tools = toolCallsByRun[message.runId] ?? []
            const previousUserMessage = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user')
            const showActions = message.role === 'assistant' && !message.streaming && Boolean(message.content.trim())

            if (message.role === 'user') {
              return <article key={message.id} className="agent-message" data-role="user"><p>{message.content}</p></article>
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
                  <article className="agent-message" data-role="assistant"><p>{message.content}</p></article>
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
          {loading && messages.length === 0 ? <div className="agent-loading">正在载入会话...</div> : null}
          {error ? <div className="agent-error" role="alert">{error}</div> : null}
      </div>
      {composer}
      <div className="agent-chat-quick-prompts" aria-label="快捷提示">
        {quickPrompts.map(([label, prompt]) => (
          <button key={label} type="button" onClick={() => onSelectPrompt(prompt)}>{label}</button>
        ))}
      </div>
    </section>
  )
}
