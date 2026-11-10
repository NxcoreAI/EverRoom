import { ChevronLeft, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLocale } from '@/i18n/LocaleContext'

import type { StyleCandidate } from './slidesState'

/**
 * 风格挑选大浮层：全屏看大图 + ←/→ 翻页 + Esc 关闭，底部「用这套 / 都换一批 / 关闭」。
 * 风格是最重要的视觉决定，不再用 148×83 的缩略图让人赌。
 */
export function SlidesStylePicker({
  candidates,
  index,
  onIndexChange,
  onUse,
  onRegenerate,
  onClose,
  busy,
  pending,
  title,
}: {
  candidates: StyleCandidate[]
  index: number
  onIndexChange: (index: number) => void
  onUse: (index: number) => void
  onRegenerate: () => void
  onClose: () => void
  busy: boolean
  pending: boolean
  title: string
}) {
  const { t } = useLocale()
  const [localIndex, setLocalIndex] = useState(index)
  const current = candidates[Math.min(localIndex, Math.max(0, candidates.length - 1))]
  const disabledAll = busy || pending
  const move = (delta: number) => {
    if (candidates.length === 0) return
    const next = (localIndex + delta + candidates.length) % candidates.length
    setLocalIndex(next)
    onIndexChange(next)
  }
  // 键盘：←/→ 换张，Esc 关闭（只在浮层挂载时监听）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  if (!current) return null
  const label = current.label ?? t('surface:agentChat.SLIDES_STYLE_OPTION', { index: localIndex + 1 })
  const overlay = (
    <div className="agent-slides-style-overlay" role="dialog" aria-modal="true" aria-label={t('surface:agentChat.SLIDES_STYLE_PICK_TITLE')}>
      <button
        type="button"
        className="agent-slides-style-overlay-backdrop"
        aria-label={t('surface:agentChat.SLIDES_STYLE_CLOSE')}
        onClick={onClose}
      />
      <div className="agent-slides-style-overlay-panel">
        <header className="agent-slides-style-overlay-head">
          <span>
            <Sparkles aria-hidden="true" />
            <strong>{t('surface:agentChat.SLIDES_STYLE_PICK_TITLE')}</strong>
            <small>{title}</small>
          </span>
          <button
            type="button"
            className="agent-slides-style-overlay-close"
            aria-label={t('surface:agentChat.SLIDES_STYLE_CLOSE')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="agent-slides-style-overlay-stage">
          <button
            type="button"
            className="agent-slides-style-overlay-arrow"
            aria-label={t('surface:agentChat.SLIDES_STYLE_PREV')}
            onClick={() => move(-1)}
            disabled={candidates.length < 2}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <figure className="agent-slides-style-overlay-figure">
            <img src={current.url} alt={label} />
            <figcaption>
              {label}
              <small>{t('surface:agentChat.SLIDES_STYLE_INDEX', { index: localIndex + 1, total: candidates.length })}</small>
            </figcaption>
          </figure>
          <button
            type="button"
            className="agent-slides-style-overlay-arrow"
            aria-label={t('surface:agentChat.SLIDES_STYLE_NEXT')}
            onClick={() => move(1)}
            disabled={candidates.length < 2}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <footer className="agent-slides-style-overlay-actions">
          <button
            type="button"
            className="agent-slides-action is-primary"
            aria-label={t('surface:agentChat.SLIDES_STYLE_USE_LABEL', { index: localIndex + 1, label })}
            disabled={disabledAll}
            onClick={() => onUse(localIndex)}
          >
            {pending ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {t('surface:agentChat.SLIDES_STYLE_USE')}
          </button>
          <button
            type="button"
            className="agent-slides-action is-secondary"
            disabled={disabledAll}
            onClick={onRegenerate}
          >
            {t('surface:agentChat.SLIDES_STYLE_REGENERATE')}
          </button>
          <button type="button" className="agent-slides-action is-ghost" disabled={disabledAll} onClick={onClose}>
            {t('surface:agentChat.SLIDES_STYLE_CLOSE')}
          </button>
        </footer>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
