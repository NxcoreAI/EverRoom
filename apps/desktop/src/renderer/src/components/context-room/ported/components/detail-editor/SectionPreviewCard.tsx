import { LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import type { SectionPreviewStatus } from './useSectionPreviews'

/**
 * 章节刻度线的 hover AI 预览卡（纯展示，状态机在 useSectionPreviews）：
 * 章节标题 header + 按 status 渲染预览正文/生成中/失败重试/AI 未配置/
 * 过短/锁定提示。浅蓝基因与文档速览卡一致。
 */
export function SectionPreviewCard({ headingText, status, onRetry }: {
  headingText: string
  status: SectionPreviewStatus
  onRetry: () => void
}) {
  const { locale, t } = useLocale()

  return (
    <div className="context-room-tiptap-scale-popover" data-state={status.state}>
      <header>
        <Sparkles size={12} aria-hidden="true" />
        <strong title={headingText}>{headingText}</strong>
        <em className="context-room-tiptap-scale-popover-ai-badge">
          {t('contextRoom:documentSectionPreview.aiLabel')}
        </em>
      </header>
      <div className="context-room-tiptap-scale-popover-body">
        {status.state === 'loading' ? (
          <p className="context-room-tiptap-scale-popover-hint" role="status">
            <LoaderCircle size={12} className="context-room-overview-spinning" aria-hidden="true" />
            {t('contextRoom:documentSectionPreview.loading')}
          </p>
        ) : null}
        {status.state === 'ready' ? (
          <>
            <p className="context-room-tiptap-scale-popover-text">{status.preview}</p>
            <footer>
              <span>
                {t('contextRoom:documentSectionPreview.generatedAt', {
                  time: new Date(status.generatedAt).toLocaleString(locale, { hour12: false }),
                })}
              </span>
            </footer>
          </>
        ) : null}
        {status.state === 'failed' ? (
          <p className="context-room-tiptap-scale-popover-hint" data-error="true">
            {t('contextRoom:documentSectionPreview.failed')}
            <button
              type="button"
              className="context-room-tiptap-scale-popover-retry"
              onClick={onRetry}
            >
              <RotateCcw size={11} aria-hidden="true" />
              {t('contextRoom:documentSectionPreview.retry')}
            </button>
          </p>
        ) : null}
        {status.state === 'unavailable' ? (
          <p className="context-room-tiptap-scale-popover-hint">
            {t('contextRoom:documentSectionPreview.unavailable')}
          </p>
        ) : null}
        {status.state === 'too-short' || status.state === 'idle' ? (
          <p className="context-room-tiptap-scale-popover-hint">
            {t('contextRoom:documentSectionPreview.tooShort')}
          </p>
        ) : null}
        {status.state === 'locked' ? (
          <p className="context-room-tiptap-scale-popover-hint">
            {t('contextRoom:documentSectionPreview.locked')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
