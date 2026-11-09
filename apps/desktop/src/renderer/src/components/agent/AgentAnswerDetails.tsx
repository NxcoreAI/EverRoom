import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLocale } from '@/i18n/LocaleContext'

// 与 AgentChatView 一致的气泡内降级标题/链接/无图渲染。
const detailMarkdownComponents = {
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

/**
 * 分级答复的 L2 详情折叠区（gateway answer-tiering：模型用 [[details]]
 * 标记行切分，气泡默认只渲染 displayContent，差值在此展开）。
 *
 * 原生 details/summary：零 JS 状态、可访问性免费、历史消息回放直接可用。
 */
export const AgentAnswerDetails = memo(function AgentAnswerDetails({ details }: { details: string }) {
  const { t } = useLocale()
  const text = details.trim()
  if (!text) return null
  return (
    <details className="agent-answer-details">
      <summary>{t('surface:agentChat.answerDetailsToggle')}</summary>
      <div className="agent-markdown agent-answer-details-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={detailMarkdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    </details>
  )
})
