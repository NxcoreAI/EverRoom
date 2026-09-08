import { ChevronDown, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import type { DocumentOverviewView } from '@nxcore/agent-contract'
import { useLocale } from '../../../../../i18n/LocaleContext'
import type { DocumentOverviewStatus } from './useDocumentOverview'
import './TiptapDocumentEditor.css'

/**
 * 文档速览卡：标题下方、正文上方的可折叠窄卡。收起态一条「AI 速览」
 * 入口栏（生成中/已过期/主题预览徽标）；展开态显示主题/要点/结论 +
 * 基于版本与时间 + 重新生成。纯展示组件，状态机在 useDocumentOverview。
 * 空文档不渲染（避免空编辑器上方挂噪音条）；过短文档只渲染提示条。
 */
export function DocumentOverviewCard({
  status,
  expanded,
  onToggleExpanded,
  onRegenerate,
  regenerateDisabled,
}: {
  status: DocumentOverviewStatus
  expanded: boolean
  onToggleExpanded: () => void
  onRegenerate: () => void
  regenerateDisabled: boolean
}) {
  const { locale, t } = useLocale()

  if (status.state === 'idle') return null
  if (status.state === 'ineligible' && status.reason === 'empty') return null

  if (status.state === 'ineligible') {
    return (
      <div className="context-room-document-overview" data-state="ineligible">
        <div className="context-room-document-overview-bar">
          <Sparkles size={14} aria-hidden="true" />
          <span className="context-room-document-overview-hint">
            {t('contextRoom:documentQuickView.tooShort')}
          </span>
        </div>
      </div>
    )
  }

  if (status.state === 'failed') {
    return (
      <div className="context-room-document-overview" data-state="failed">
        <div className="context-room-document-overview-bar">
          <Sparkles size={14} aria-hidden="true" />
          <span className="context-room-document-overview-hint">
            {status.kind === 'unavailable'
              ? t('contextRoom:documentQuickView.unavailable')
              : t('contextRoom:documentQuickView.failed')}
          </span>
          {status.kind === 'error' ? (
            <button
              type="button"
              className="context-room-document-overview-retry"
              onClick={onRegenerate}
              disabled={regenerateDisabled}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {t('contextRoom:documentQuickView.retry')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const view: DocumentOverviewView | null = status.state === 'generating'
    ? status.view
    : status.state === 'ready' || status.state === 'stale' ? status.view : null
  const canExpand = view?.topic != null
  const generatedAtText = view?.generatedAt
    ? new Date(view.generatedAt).toLocaleString(locale, { hour12: false })
    : ''

  return (
    <div
      className="context-room-document-overview"
      data-state={status.state}
      data-expanded={String(expanded)}
    >
      <button
        type="button"
        className="context-room-document-overview-bar"
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        onClick={canExpand ? onToggleExpanded : undefined}
      >
        {status.state === 'generating' ? (
          <LoaderCircle size={14} className="context-room-overview-spinning" aria-hidden="true" />
        ) : (
          <Sparkles size={14} aria-hidden="true" />
        )}
        <span className="context-room-document-overview-label">
          {t('contextRoom:documentQuickView.entryLabel')}
        </span>
        {status.state === 'generating' ? (
          <span className="context-room-document-overview-hint">
            {t('contextRoom:documentQuickView.generating')}
          </span>
        ) : null}
        {status.state === 'stale' ? (
          <span className="context-room-document-overview-stale-badge">
            {t('contextRoom:documentQuickView.staleBadge')}
          </span>
        ) : null}
        {status.state === 'ready' && !expanded && view?.topic ? (
          <span className="context-room-document-overview-topic-preview">{view.topic}</span>
        ) : null}
        {status.state === 'loading' ? (
          <span className="context-room-document-overview-skeleton" aria-hidden="true" />
        ) : null}
        {canExpand ? (
          <ChevronDown size={14} className="context-room-document-overview-chevron" aria-hidden="true" />
        ) : null}
      </button>
      {expanded && view?.topic ? (
        <div className="context-room-document-overview-body">
          <p className="context-room-document-overview-topic">{view.topic}</p>
          {view.points.length > 0 ? (
            <ul className="context-room-document-overview-points">
              {view.points.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ul>
          ) : null}
          {view.conclusion ? (
            <p className="context-room-document-overview-conclusion">{view.conclusion}</p>
          ) : null}
          <footer className="context-room-document-overview-footer">
            <span>
              {t('contextRoom:documentQuickView.basedOnVersion', {
                version: view.generatedAtVersion != null ? String(view.generatedAtVersion) : '?',
                time: generatedAtText,
              })}
            </span>
            <button
              type="button"
              className="context-room-document-overview-retry"
              onClick={onRegenerate}
              disabled={regenerateDisabled || status.state === 'generating'}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {t('contextRoom:documentQuickView.regenerate')}
            </button>
          </footer>
        </div>
      ) : null}
    </div>
  )
}
