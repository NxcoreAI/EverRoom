import { Brain, LoaderCircle, MessageCircle } from 'lucide-react'

import { PRODUCT_AI_NAME } from '@/components/ui/brand'
import type { DisplayAgentMessage } from './useAgentSession'

const quickPrompts = [
  ['整理今天的工作重点', '总结今天最重要的工作，并按优先级排序'],
  ['整理会议行动项', '整理最近会议中的行动项'],
  ['分析文档与来源', '分析当前文档与来源中可能存在的风险'],
] as const

export function AgentChatView({
  activeRunId,
  error,
  loading,
  messages,
  onSelectPrompt,
  reasoning,
}: {
  activeRunId: string | null
  error: string | null
  loading: boolean
  messages: DisplayAgentMessage[]
  onSelectPrompt: (prompt: string) => void
  reasoning: string
}) {
  const awaitingReply = Boolean(activeRunId) && !messages.some((message) => (
    message.role === 'assistant' && message.runId === activeRunId
  ))
  const hasConversation = messages.length > 0 || loading || Boolean(error)

  return (
    <section className="agent-chat-conversation-frame">
      {!hasConversation ? (
        <div className="agent-chat-empty">
          <MessageCircle aria-hidden="true" />
          <span>更懂你的 {PRODUCT_AI_NAME}</span>
          <small>结合当前工作区上下文，帮你梳理任务、会议和文档。</small>
          <div className="agent-chat-quick-prompts" aria-label="快捷提示">
            {quickPrompts.map(([label, prompt]) => (
              <button key={label} type="button" onClick={() => onSelectPrompt(prompt)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="agent-conversation" aria-live="polite">
          {reasoning ? (
            <details className="agent-reasoning" open={Boolean(activeRunId)}>
              <summary><Brain aria-hidden="true" />思考过程</summary>
              <p>{reasoning}</p>
            </details>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} className="agent-message" data-role={message.role}>
              <div className="agent-message-meta">
                <span>{message.role === 'user' ? '你' : PRODUCT_AI_NAME}</span>
                {message.streaming ? <LoaderCircle className="spin" aria-label="正在生成" /> : null}
              </div>
              <p>{message.content || ' '}</p>
            </article>
          ))}
          {loading ? (
            <div className="agent-loading">
              <LoaderCircle className="spin" />
              {messages.length > 0 ? '正在连接 Agent，等待回复' : '正在载入会话'}
            </div>
          ) : awaitingReply ? (
            <div className="agent-loading">
              <LoaderCircle className="spin" />消息已发送，正在等待回复
            </div>
          ) : null}
          {error ? <div className="agent-error" role="alert">{error}</div> : null}
        </div>
      )}
    </section>
  )
}
