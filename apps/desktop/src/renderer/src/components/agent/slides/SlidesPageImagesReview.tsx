import { ImageOff, LoaderCircle, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import type { SlidesPagePlan } from './slidesState'

type Decision = 'keep' | 'drop' | 'replace'

function pageNumberOf(page: SlidesPagePlan, index: number): number {
  return (typeof page.pageIndex === 'number' ? page.pageIndex : index) + 1
}

/** 把下标数组拼成工具调用参数（空数组省略）。 */
function batchParam(name: string, pageNumbers: number[]): string {
  return pageNumbers.length ? `, ${name}=[${pageNumbers.join(',')}]` : ''
}

/**
 * 配图过目：九宫格 + 批量勾选（保留 / 不用 / 换一张），底部一次提交。
 * 一次点击 = 一次决定，不把每张图的像素调整排成 N 次 agent 回合。
 */
export function SlidesPageImagesReview({
  documentId,
  generation,
  pages,
  doneCount,
  totalPages,
  busy,
  pending,
  onSubmit,
}: {
  documentId?: string
  generation?: number
  pages: SlidesPagePlan[]
  doneCount: number
  totalPages: number
  busy: boolean
  pending: boolean
  /** hiddenPrompt 的技术参数由本组件拼好，文本走 i18n；displayText 只给人看。 */
  onSubmit: (prompt: string, displayText: string) => void
}) {
  const { t } = useLocale()
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  const [confirmAllDrop, setConfirmAllDrop] = useState(false)

  // 重生成一批新图 / 换文档时清空本地勾选：旧决定不再适用于新图（渲染期重置，避免被动 effect 竞态）。
  const decisionKey = `${documentId ?? ''}:${String(generation ?? '')}`
  const [prevDecisionKey, setPrevDecisionKey] = useState(decisionKey)
  if (prevDecisionKey !== decisionKey) {
    setPrevDecisionKey(decisionKey)
    setDecisions({})
    setConfirmAllDrop(false)
  }

  const generatedPages = pages
    .map((page, index) => ({ page, index, number: pageNumberOf(page, index) }))
    .filter((entry) => Boolean(entry.page.url))
  const failedPages = pages
    .map((page, index) => ({ page, index, number: pageNumberOf(page, index) }))
    .filter((entry) => !entry.page.url && entry.page.failed)
  const decisionOf = (page: SlidesPagePlan, index: number): Decision => {
    if (decisions[index]) return decisions[index]!
    if (page.rejected) return 'drop'
    if (!page.url && page.failed) return 'replace'
    return 'keep'
  }
  const changedPages = pages
    .map((page, index) => ({ page, index, number: pageNumberOf(page, index) }))
    .filter((entry) => {
      const decision = decisionOf(entry.page, entry.index)
      const baseline: Decision = entry.page.rejected ? 'drop' : (!entry.page.url && entry.page.failed) ? 'replace' : 'keep'
      return decision !== baseline
    })
  const pendingChanges = generatedPages.length > 0 || failedPages.length > 0 ? changedPages.length : 0
  const disabledAll = busy || pending

  const applyChanges = () => {
    if (pendingChanges === 0) return
    const rejects: number[] = []
    const regenerates: number[] = []
    const restores: number[] = []
    for (const entry of changedPages) {
      const decision = decisionOf(entry.page, entry.index)
      if (decision === 'drop') rejects.push(entry.number)
      else if (decision === 'replace') regenerates.push(entry.number)
      else if (entry.page.rejected) restores.push(entry.number)
    }
    onSubmit(
      t('surface:agentChat.SLIDES_IMAGES_APPLY_PROMPT', {
        documentId: documentId ?? '',
        rejects: batchParam('rejectPageImages', rejects),
        regenerates: batchParam('regeneratePageImages', regenerates),
        restores: batchParam('restorePageImages', restores),
      }),
      t('surface:agentChat.SLIDES_IMAGES_APPLY_DISPLAY', { count: pendingChanges }),
    )
  }
  const accept = () => {
    onSubmit(
      t('surface:agentChat.SLIDES_IMAGES_ACCEPT_PROMPT', { documentId: documentId ?? '' }),
      t('surface:agentChat.SLIDES_IMAGES_ACCEPT_DISPLAY'),
    )
  }
  const dropAll = () => {
    onSubmit(
      t('surface:agentChat.SLIDES_IMAGES_SKIP_PROMPT', { documentId: documentId ?? '' }),
      t('surface:agentChat.SLIDES_IMAGES_ALL_DROP_DISPLAY'),
    )
    setConfirmAllDrop(false)
  }

  return (
    <div className="agent-slides-images">
      <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_IMAGES_REVIEW_HINT')}</p>
      <div className="agent-slides-images-grid">
        {pages.map((page, index) => {
          const number = pageNumberOf(page, index)
          const title = page.title ?? t('surface:agentChat.SLIDES_PAGE_UNTITLED')
          if (!page.url) {
            return (
              <figure key={index} className={`agent-slides-image-cell is-pending${page.failed ? ' is-failed' : ''}`}>
                <div className="agent-slides-image-placeholder">
                  {page.failed ? <ImageOff aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
                </div>
                <figcaption>
                  <span className="agent-slides-image-title">
                    {t('surface:agentChat.SLIDES_IMAGES_PAGE_LABEL', { page: number, title })}
                  </span>
                  <small>{page.failed
                    ? t('surface:agentChat.SLIDES_IMAGES_FAILED')
                    : t('surface:agentChat.SLIDES_IMAGES_PENDING')}</small>
                  {page.failed ? (
                    <span className="agent-slides-image-decisions" role="group" aria-label={t('surface:agentChat.SLIDES_IMAGES_ADJUST_LABEL', { page: number, title })}>
                      <button
                        type="button"
                        className={`agent-slides-chip${decisionOf(page, index) === 'replace' ? ' is-on' : ''}`}
                        disabled={disabledAll}
                        onClick={() => setDecisions((prev) => ({ ...prev, [index]: 'replace' }))}
                      >
                        <RotateCcw aria-hidden="true" />
                        {t('surface:agentChat.SLIDES_IMAGES_REPLACE')}
                      </button>
                      <button
                        type="button"
                        className={`agent-slides-chip${decisionOf(page, index) === 'drop' ? ' is-on' : ''}`}
                        disabled={disabledAll}
                        onClick={() => setDecisions((prev) => ({ ...prev, [index]: 'drop' }))}
                      >
                        {t('surface:agentChat.SLIDES_IMAGES_DROP')}
                      </button>
                    </span>
                  ) : null}
                </figcaption>
              </figure>
            )
          }
          const decision = decisionOf(page, index)
          return (
            <figure key={index} className={`agent-slides-image-cell${decision === 'drop' ? ' is-dropped' : ''}`}>
              <img src={page.url} alt={t('surface:agentChat.SLIDES_IMAGES_PAGE_LABEL', { page: number, title })} loading="lazy" />
              <figcaption>
                <span className="agent-slides-image-title">
                  {t('surface:agentChat.SLIDES_IMAGES_PAGE_LABEL', { page: number, title })}
                </span>
                <span
                  className="agent-slides-image-decisions"
                  role="group"
                  aria-label={t('surface:agentChat.SLIDES_IMAGES_ADJUST_LABEL', { page: number, title })}
                >
                  <button
                    type="button"
                    className={`agent-slides-chip${decision === 'keep' ? ' is-on' : ''}`}
                    aria-label={t('surface:agentChat.SLIDES_IMAGES_KEEP_LABEL', { page: number, title })}
                    disabled={disabledAll}
                    onClick={() => setDecisions((prev) => ({ ...prev, [index]: 'keep' }))}
                  >
                    {t('surface:agentChat.SLIDES_IMAGES_KEEP')}
                  </button>
                  <button
                    type="button"
                    className={`agent-slides-chip${decision === 'drop' ? ' is-on' : ''}`}
                    aria-label={t('surface:agentChat.SLIDES_IMAGES_DROP_LABEL', { page: number, title })}
                    disabled={disabledAll}
                    onClick={() => setDecisions((prev) => ({ ...prev, [index]: 'drop' }))}
                  >
                    {t('surface:agentChat.SLIDES_IMAGES_DROP')}
                  </button>
                  <button
                    type="button"
                    className={`agent-slides-chip${decision === 'replace' ? ' is-on' : ''}`}
                    aria-label={t('surface:agentChat.SLIDES_IMAGES_REPLACE_LABEL', { page: number, title })}
                    disabled={disabledAll}
                    onClick={() => setDecisions((prev) => ({ ...prev, [index]: 'replace' }))}
                  >
                    {t('surface:agentChat.SLIDES_IMAGES_REPLACE')}
                  </button>
                </span>
              </figcaption>
            </figure>
          )
        })}
      </div>
      <p className="agent-slides-images-progress" role="status">
        {t('surface:agentChat.SLIDES_IMAGES_PROGRESS', { done: doneCount, total: totalPages })}
      </p>
      <div className="agent-slides-actions">
        <button
          type="button"
          className="agent-slides-action is-primary"
          disabled={disabledAll}
          onClick={accept}
        >
          {pending ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
          {t('surface:agentChat.SLIDES_IMAGES_ACCEPT')}
        </button>
        {pendingChanges > 0 ? (
          <button
            type="button"
            className="agent-slides-action is-secondary"
            disabled={disabledAll}
            onClick={applyChanges}
          >
            {t('surface:agentChat.SLIDES_IMAGES_APPLY', { count: pendingChanges })}
          </button>
        ) : null}
      </div>
      <div className="agent-slides-danger-zone">
        {confirmAllDrop ? (
          <div className="agent-slides-danger-confirm" role="alertdialog" aria-label={t('surface:agentChat.SLIDES_IMAGES_ALL_DROP')}>
            <p>
              <ShieldAlert aria-hidden="true" />
              <span>{t('surface:agentChat.SLIDES_IMAGES_ALL_DROP_HINT')}</span>
            </p>
            <div className="agent-slides-actions">
              <button type="button" className="agent-slides-action is-danger" disabled={disabledAll} onClick={dropAll}>
                {t('surface:agentChat.SLIDES_IMAGES_ALL_DROP_CONFIRM')}
              </button>
              <button type="button" className="agent-slides-action is-ghost" onClick={() => setConfirmAllDrop(false)}>
                {t('surface:agentChat.SLIDES_IMAGES_CANCEL')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="agent-slides-danger-link" disabled={disabledAll} onClick={() => setConfirmAllDrop(true)}>
            <X aria-hidden="true" />
            {t('surface:agentChat.SLIDES_IMAGES_ALL_DROP')}
          </button>
        )}
      </div>
    </div>
  )
}
