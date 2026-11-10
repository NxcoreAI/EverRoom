import type { ReactNode } from 'react'
import { ClipboardList, FileText, LineChart, Presentation } from 'lucide-react'

import { BrandRibbon } from '@/components/ui/BrandRibbon'

/**
 * 主区空态 hero（品牌时刻）：缎带 + 问候 + 大输入框 + 建议 chips。
 *
 * 纯展示组件：输入内容由 ConversationPane 持有（首条发送走 useAgentSession.sendPrompt，
 * 网关侧自动建会话）。输入框本体已换成 AgentComposer（与会话态同一组件），因此
 * 「智能档位」「+」等底栏控件在草稿态同样可用——这里只保留 hero 版式（缎带/标题/
 * 批注徽章/建议 chips），输入框通过 children 插槽注入。
 */
export interface ConversationEmptyProps {
  /** hero 版式内渲染的大输入框（AgentComposer + 批注徽章）。 */
  children: ReactNode
  /** 渲染在大输入框正上方的附加行（待发送批注徽章）：hero 垂直居中，外挂会飘到很上面。 */
  aboveInput?: ReactNode
  /** 点建议 chip：把建议文案填进输入框（由 ConversationPane 持有草稿）。 */
  onSuggestion?: (prompt: string) => void
}

interface HeroSuggestion {
  label: string
  prompt: string
  Icon: typeof FileText
}

const HERO_SUGGESTIONS: HeroSuggestion[] = [
  { label: '写周报', prompt: '帮我写一份本周的工作周报', Icon: FileText },
  { label: '分析数据', prompt: '帮我分析一份数据表，找出关键趋势和异常', Icon: LineChart },
  { label: '做 PPT', prompt: '帮我把这些材料整理成一份演示文稿', Icon: Presentation },
  { label: '整理会议纪要', prompt: '帮我整理会议纪要，提炼结论和待办事项', Icon: ClipboardList },
]

export function ConversationEmpty({ children, aboveInput, onSuggestion }: ConversationEmptyProps) {
  return (
    <div className="wb-conversation-hero">
      <div className="wb-hero">
        <div className="wb-hero-brand">
          <BrandRibbon size={44} animated />
        </div>

        <h1 className="wb-hero-title">EverOffice，我帮你</h1>

        {aboveInput ? <div className="wb-hero-above-input">{aboveInput}</div> : null}

        <div className="wb-hero-input">{children}</div>

        <div className="wb-hero-chips" aria-label="建议任务">
          {HERO_SUGGESTIONS.map(({ label, prompt, Icon }) => (
            <button
              key={label}
              type="button"
              className="wb-hero-chip"
              onClick={() => onSuggestion?.(prompt)}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
