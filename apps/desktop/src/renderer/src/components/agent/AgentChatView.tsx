import { MessageCircle } from 'lucide-react'

import { PRODUCT_AI_NAME } from '@/components/ui/brand'

const quickPrompts = [
  ['整理今天的工作重点', '总结今天最重要的工作，并按优先级排序'],
  ['整理会议行动项', '整理最近会议中的行动项'],
  ['分析文档与来源', '分析当前文档与来源中可能存在的风险'],
] as const

export function AgentChatView({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  return (
    <section className="agent-chat-conversation-frame">
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
    </section>
  )
}
