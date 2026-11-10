import { Brain } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

export function reasoningParagraphs(content: string): string[] {
  // 思考流是纯文本增量：按空行分段渲染，不走 Markdown 解析
  //（流式期间每帧全量重解析长思考串会把主线程打满，参考 FormattedAgentText 的教训）。
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 流动 tail：与状态行「正在整理结果 …」后面的思考预览同款——末尾片段单行截断。 */
function reasoningTailText(content: string): string {
  const collapsed = content.slice(-2_000).replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(-140) : ''
}

/** 小节摘要：思考封段后标签直接用首行文本，不再显示「思考」字样。 */
function reasoningFirstLine(content: string, limit = 60): string {
  const first = reasoningParagraphs(content)[0] ?? ''
  return first.length > limit ? `${first.slice(0, limit)}…` : first
}

/**
 * Agent 思考过程（reasoning.delta 累积文本）：默认折叠的 <details>。
 * - variant="block"（默认）：挂在 assistant 消息流上（无工具 run 的整段思考），
 *   summary 运行中「思考中…」、结束后「思考过程」。
 * - variant="segment"：内嵌在执行时间线里，表示「导致下方这次工具调用的思考段」。
 *   思考流式中标签是 shimmer「思考中…」；封段后直接显示这段思考的首行文本
 *  （不显示「思考」字样），更像一条自然的叙述行。
 * - variant="live"：时间线尾部正在流动的未封段思考——shimmer 标签「思考中…」+
 *   实时滚动的 tail 预览（与状态行「正在整理结果」后的 tail 同款视觉）；
 *   点击可展开读全文。下一个工具出现即被封段、本行自然消失。
 * 默认折叠、绝不自动展开；用户展开且 run 仍在进行时，内容自动跟随流式滚到底部。
 */
export const ReasoningBlock = memo(function ReasoningBlock({
  active = false,
  content,
  variant = 'block',
}: {
  /** run 仍在进行（reasoning.delta 还在流式到达）。 */
  active?: boolean
  content: string
  variant?: 'block' | 'segment' | 'live'
}) {
  const { t } = useLocale()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const paragraphs = reasoningParagraphs(content)
  const charCount = content.trim().length

  useEffect(() => {
    const details = detailsRef.current
    const element = contentRef.current
    // details 关闭时内容 display:none，scrollTop 不生效；只在展开 + 运行中跟随。
    if (!details?.open || !element || !active) return
    element.scrollTop = element.scrollHeight
  }, [active, paragraphs.length])

  if (charCount === 0) return null

  const className = variant === 'block'
    ? 'agent-reasoning'
    : `agent-reasoning agent-reasoning-${variant}`

  return (
    <details
      className={className}
      data-active={String(active)}
      data-variant={variant}
      ref={detailsRef}
    >
      <summary>
        {variant === 'live' ? (
          <>
            <Brain aria-hidden="true" strokeWidth={1.8} />
            <span className="agent-thinking-text" data-text={t('surface:agentChat.thinking')}>
              {t('surface:agentChat.thinking')}
            </span>
            <span className="agent-reasoning-live-tail">{reasoningTailText(content)}</span>
          </>
        ) : variant === 'segment' ? (
          <>
            <Brain aria-hidden="true" strokeWidth={1.8} />
            {/* 封段即思考结束：标签直接是这段思考的首行文本（流式阶段由
                时间线尾部的 live 行承载，不在这里）。 */}
            <span className="agent-reasoning-summary-text">{reasoningFirstLine(content)}</span>
          </>
        ) : (
          <>
            <Brain aria-hidden="true" strokeWidth={1.8} />
            {active
              ? t('surface:agentChat.thinking')
              : t('surface:agentChat.reasoningProcess')}
          </>
        )}
      </summary>
      <div className="agent-reasoning-content" ref={contentRef}>
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </details>
  )
})
