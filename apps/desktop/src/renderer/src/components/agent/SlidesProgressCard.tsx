import {
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  Presentation,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import type { DisplayAgentToolStatus } from './agentRunActivity'
import { SlidesPageImagesReview } from './slides/SlidesPageImagesReview'
import { SlidesStylePicker } from './slides/SlidesStylePicker'
import {
  SLIDES_IN_PROGRESS_STAGES,
  SLIDES_WAITING_STAGES,
  selectSlidesTasks,
  slidesProgressFromToolCall,
  slidesTaskEntries,
  type StyleCandidate,
  type StyleCardData,
  type SlidesPagePlan,
  type SlidesProgressState,
  type SlidesStage,
  type SlidesTaskEntry,
  type SlidesTaskSelection,
} from './slides/slidesState'

export type {
  StyleCandidate,
  StyleCardData,
  SlidesPagePlan,
  SlidesProgressState,
  SlidesStage,
  SlidesTaskEntry,
  SlidesTaskSelection,
}
export {
  SLIDES_IN_PROGRESS_STAGES,
  SLIDES_WAITING_STAGES,
  selectSlidesTasks,
  slidesProgressFromToolCall,
  slidesTaskEntries,
}

/** 已知 errorCode → 人话（未知回落载荷 errorMessage，不直出技术码）。 */
const ERROR_MESSAGE_KEYS: Record<string, string> = {
  slides_office_generation_failed: 'surface:agentChat.SLIDES_ERROR_OFFICE_GENERATION',
  slides_layout_agents_unavailable: 'surface:agentChat.SLIDES_ERROR_AGENTS_UNAVAILABLE',
  slides_layout_apply_failed: 'surface:agentChat.SLIDES_ERROR_LAYOUT_APPLY',
  slides_layout_tail_failed: 'surface:agentChat.SLIDES_ERROR_LAYOUT_TAIL',
  slides_storyboard_unavailable: 'surface:agentChat.SLIDES_ERROR_STORYBOARD_UNAVAILABLE',
  slides_page_images_generation_failed: 'surface:agentChat.SLIDES_ERROR_PAGE_IMAGES',
  slides_page_images_empty: 'surface:agentChat.SLIDES_ERROR_NONE_NEEDED',
  slides_page_images_session_invalid: 'surface:agentChat.SLIDES_ERROR_SESSION_EXPIRED',
  slides_page_images_stage_conflict: 'surface:agentChat.SLIDES_ERROR_STAGE_CONFLICT',
}

interface ActionSpec {
  prompt: string
  display: string
}

export interface SlidesProgressCardProps {
  state: SlidesProgressState
  toolRunning: boolean
  /** 只代表「用户消息正在提交」，不再因 agent 在跑而锁死整卡（P1-4）。 */
  busy?: boolean
  startedAt?: string
  completedAt?: string
  runId?: string
  toolStatus?: DisplayAgentToolStatus
  onAction?: (prompt: string, displayText: string) => void
  onOpenDraft?: (documentId: string, roomId?: string) => void
  cancelledRunIds?: ReadonlySet<string>
  interruptedRunIds?: ReadonlySet<string>
  /** 已完成旧卡收成一行回执。 */
  compact?: boolean
}

/** 已用时 mm:ss，运行中每秒刷新；有完成时刻就停止计时。 */
function useElapsedLabel(startedAt: string | undefined, completedAt: string | undefined, running: boolean): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || !startedAt || completedAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, startedAt, completedAt])
  if (!startedAt) return null
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return null
  const end = completedAt ? Date.parse(completedAt) : running ? now : Number.NaN
  if (Number.isNaN(end)) return null
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function pageNumberOf(page: SlidesPagePlan, index: number): number {
  return (typeof page.pageIndex === 'number' ? page.pageIndex : index) + 1
}

/** 点击外部文件打开：卡片内直接开可编辑成品，不经 Agent 回合。 */
function useDeckOpener(
  state: SlidesProgressState,
  title: string,
  onError: (message: string) => void,
) {
  const { t } = useLocale()
  return () => {
    const files = typeof window === 'undefined' ? undefined : window.nxcore?.files
    if (!files || !state.fileEntryId) {
      onError(t('surface:agentChat.SLIDES_OPEN_FAILED'))
      return
    }
    void files.openOriginal(
      state.fileEntryId,
      state.fileName ?? title,
      undefined,
      { editable: true, roomId: state.roomId },
    ).catch(() => onError(t('surface:agentChat.SLIDES_OPEN_FAILED')))
  }
}

export function SlidesProgressCard({
  state,
  toolRunning,
  busy = false,
  startedAt,
  completedAt,
  runId,
  toolStatus,
  onAction,
  onOpenDraft,
  cancelledRunIds,
  interruptedRunIds,
  compact = false,
}: SlidesProgressCardProps) {
  const { t } = useLocale()
  const [dismissed, setDismissed] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [stylePickerOpen, setStylePickerOpen] = useState(
    state.stage === 'style_images_ready' && (state.styleCandidates?.length ?? 0) > 0,
  )
  const [styleIndex, setStyleIndex] = useState(0)
  const [expandedPages, setExpandedPages] = useState<ReadonlySet<number>>(new Set())

  const pages = state.pages ?? []
  const total = state.totalPages ?? pages.length
  const doneCount = state.doneCount ?? 0
  const title = state.title || t('surface:agentChat.SLIDES_DEFAULT_TITLE')
  const running = toolRunning
  const interrupted = Boolean(runId && interruptedRunIds?.has(runId))
  const stopped = !interrupted && (toolStatus === 'stopped' || Boolean(runId && cancelledRunIds?.has(runId)))
  const isInProgress = SLIDES_IN_PROGRESS_STAGES.has(state.stage)
  const completed = state.stage === 'page_applied' && state.completed !== false && !running
  const partial = state.stage === 'page_applied' && state.completed === false
  const failedPages = state.failedPages ?? []
  const warnings = state.warnings ?? []
  const elapsed = useElapsedLabel(startedAt, completedAt, running)
  // 阶段翻转/新一批图到来：清掉局部状态、重新展开、按新阶段决定是否弹大图。
  const stageKey = `${state.stage}:${state.generation ?? ''}:${state.documentId ?? state.styleSessionId ?? ''}`
  const [prevStageKey, setPrevStageKey] = useState(stageKey)
  if (prevStageKey !== stageKey) {
    setPrevStageKey(stageKey)
    setPendingAction(null)
    setOpenError(null)
    // 新阶段需要用户做决定时重新出现（关掉的卡不该错过下一个决策点）。
    if (SLIDES_WAITING_STAGES.has(state.stage)) setDismissed(false)
    setExpandedPages(new Set())
    setStylePickerOpen(state.stage === 'style_images_ready' && (state.styleCandidates?.length ?? 0) > 0)
  }

  const runAction = (actionId: string, build: () => ActionSpec) => {
    if (busy || pendingAction) return
    const spec = build()
    setPendingAction(actionId)
    setOpenError(null)
    onAction?.(spec.prompt, spec.display)
    // 用户已经做出明确选择：这张卡立刻收起，不在对话区里常驻。
    setDismissed(true)
  }
  const openDeck = useDeckOpener(state, title, setOpenError)
  const openDraft = () => {
    if (!state.documentId) return
    onOpenDraft?.(state.documentId, state.roomId)
  }

  const phaseText = (() => {
    if (interrupted) return t('surface:agentChat.SLIDES_INTERRUPTED')
    if (stopped) return t('surface:agentChat.SLIDES_STOPPED')
    switch (state.stage) {
      case 'drafting': return t('surface:agentChat.SLIDES_PHASE_DRAFTING')
      case 'style_generating': return t('surface:agentChat.SLIDES_PHASE_STYLE_GENERATING', { count: 3 })
      case 'style_extracting': return t('surface:agentChat.SLIDES_PHASE_STYLE_EXTRACTING')
      case 'planning': return t('surface:agentChat.SLIDES_PHASE_PLANNING')
      case 'failed': return t('surface:agentChat.SLIDES_FAILED_PHASE')
      case 'draft_ready': return t('surface:agentChat.SLIDES_DRAFT_READY')
      case 'style_images_ready': return t('surface:agentChat.SLIDES_STYLE_PICK_PHASE')
      case 'style_card_ready': return t('surface:agentChat.SLIDES_STYLE_CARD_PHASE')
      case 'page_images_confirm': return t('surface:agentChat.SLIDES_IMAGES_CONFIRM_PHASE')
      case 'page_images_review':
        return doneCount < total
          ? t('surface:agentChat.SLIDES_IMAGES_PROGRESS', { done: doneCount, total })
          : t('surface:agentChat.SLIDES_IMAGES_REVIEW_PHASE')
      case 'page_images': return t('surface:agentChat.SLIDES_IMAGES_PROGRESS', { done: doneCount, total })
      case 'page_applied':
        if (running) return t('surface:agentChat.SLIDES_DECK_PROGRESS', { done: doneCount, total })
        if (state.completed === false) return t('surface:agentChat.SLIDES_PARTIAL_PHASE')
        return t('surface:agentChat.SLIDES_DONE_PHASE')
      default: return t('surface:agentChat.SLIDES_PHASE_WORKING')
    }
  })()

  if (compact) {
    const compactFailed = state.stage === 'failed'
    const compactStopped = !compactFailed && (stopped || interrupted)
    const failedText = compactFailed
      ? (state.errorCode && ERROR_MESSAGE_KEYS[state.errorCode]
        ? t(ERROR_MESSAGE_KEYS[state.errorCode]!)
        : (state.errorMessage || t('surface:agentChat.SLIDES_ERROR_UNKNOWN')))
      : ''
    const tone = compactFailed ? 'failed' : compactStopped ? 'stopped' : 'done'
    return (
      <div className="agent-slides-receipt" role="status" data-tone={tone}>
        {compactFailed ? <TriangleAlert aria-hidden="true" /> : compactStopped ? <Square aria-hidden="true" /> : <Check aria-hidden="true" />}
        <span title={compactFailed ? failedText : undefined}>
          {compactFailed
            ? `${title} · ${failedText}`
            : compactStopped
              ? `${title} · ${interrupted ? t('surface:agentChat.SLIDES_INTERRUPTED') : t('surface:agentChat.SLIDES_STOPPED')}`
              : t('surface:agentChat.SLIDES_RECEIPT_DONE', { title })}
        </span>
        {compactFailed && state.retryable ? (
          <button
            type="button"
            className="agent-slides-receipt-open"
            onClick={() => runAction('retry', () => ({
              prompt: t('surface:agentChat.SLIDES_RETRY_PROMPT', { reason: failedText }),
              display: t('surface:agentChat.SLIDES_RETRY_DISPLAY'),
            }))}
          >
            {t('surface:agentChat.SLIDES_RETRY')}
          </button>
        ) : null}
        {state.fileEntryId ? (
          <button
            type="button"
            className="agent-slides-receipt-open"
            aria-label={t('surface:agentChat.SLIDES_RECEIPT_OPEN_LABEL', { title })}
            onClick={openDeck}
          >
            {t('surface:agentChat.SLIDES_RECEIPT_OPEN')}
          </button>
        ) : null}
      </div>
    )
  }
  if (dismissed) return null

  const determinate = !isInProgress && total > 0 && (
    state.stage === 'page_images' || state.stage === 'page_applied' || state.stage === 'page_images_review'
  )
  const showProgressLine = isInProgress || running || (state.stage === 'page_images_review' && doneCount < total)
  const showPagesList = pages.length > 0
    && state.stage !== 'style_images_ready' && state.stage !== 'style_card_ready'
    && state.stage !== 'page_images_review' && state.stage !== 'page_images_confirm'
  // 落页按完成顺序发生（第 2 页可能先落）：有页号集合就按集合打勾，
  // 只留「前 doneCount 页已完成」作旧载荷的兼容回落。
  const appliedPageSet = Array.isArray(state.appliedPages) && state.appliedPages.length > 0
    ? new Set(state.appliedPages)
    : null
  const runningIndex = running && !appliedPageSet ? doneCount : -1
  const statusOf = (index: number): 'done' | 'running' | 'pending' => {
    if (appliedPageSet) return appliedPageSet.has(index) ? 'done' : 'pending'
    if (index < doneCount) return 'done'
    if (index === runningIndex) return 'running'
    return 'pending'
  }
  const togglePage = (index: number) => {
    setExpandedPages((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const statusIcon = state.stage === 'failed'
    ? <TriangleAlert aria-hidden="true" />
    : state.stage === 'page_applied' && completed
      ? <Check aria-hidden="true" />
      : <Presentation aria-hidden="true" />

  const errorsBanner = (stopped || interrupted) ? (
    <div className="agent-slides-state-banner" role="status">
      <strong>{interrupted ? t('surface:agentChat.SLIDES_INTERRUPTED') : t('surface:agentChat.SLIDES_STOPPED')}</strong>
      <span>
        {interrupted
          ? t('surface:agentChat.SLIDES_INTERRUPTED_HINT', { done: doneCount, total })
          : t('surface:agentChat.SLIDES_STOPPED_HINT', { done: doneCount, total })}
      </span>
    </div>
  ) : null

  const failedPagesBlock = failedPages.length ? (
    <div className="agent-slides-failed-pages" role="status">
      <strong>{t('surface:agentChat.SLIDES_FAILED_PAGES_TITLE')}</strong>
      <ul>
        {failedPages.map((pageIndex, index) => (
          <li key={`${pageIndex}-${index}`}>{t('surface:agentChat.SLIDES_FAILED_PAGE_ITEM', { page: pageIndex + 1 })}</li>
        ))}
      </ul>
    </div>
  ) : null

  const warningsBlock = warnings.length ? (
    <details className="agent-slides-warnings">
      <summary>{t('surface:agentChat.SLIDES_WARNINGS_SUMMARY', { count: warnings.length })}</summary>
      <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>
  ) : null

  const pagesBlock = showPagesList ? (
    isInProgress || (running && !completed && !partial)
      ? (
        <details className="agent-slides-pages-toggle">
          <summary>{t('surface:agentChat.SLIDES_PAGE_LIST', { total })}</summary>
          {renderPages()}
        </details>
      )
      : renderPages()
  ) : null

  function renderPages(): ReactNode {
    return (
      <ol className="agent-slides-progress-pages">
        {pages.map((page, index) => {
          const status = statusOf(index)
          const hasDetail = Boolean(page.points?.length || page.data || page.materialHints || page.notes || page.materials?.length)
          const open = hasDetail && expandedPages.has(index)
          return (
            <li key={index} className={`agent-slides-page${status === 'running' ? ' is-running' : ''}${open ? ' is-open' : ''}`}>
              <button
                type="button"
                className="agent-slides-page-head"
                aria-expanded={open}
                aria-label={t('surface:agentChat.SLIDES_PAGE_HEAD_LABEL', { page: pageNumberOf(page, index), title: page.title ?? '' })}
                onClick={() => hasDetail && togglePage(index)}
              >
                <span className="agent-slides-page-index">{pageNumberOf(page, index)}</span>
                <span className="agent-slides-page-title" title={page.title ?? undefined}>{page.title}</span>
                {status !== 'pending' ? (
                  <span className={`agent-slides-page-status is-${status}`}>
                    {status === 'done' ? <Check aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
                  </span>
                ) : null}
                {hasDetail ? <ChevronDown className="agent-slides-page-chevron" aria-hidden="true" /> : null}
              </button>
              {open ? (
                <div className="agent-slides-page-detail">
                  {page.points?.length ? (
                    <ul className="agent-slides-page-points">
                      {page.points.map((point, pointIndex) => <li key={pointIndex}>{point}</li>)}
                    </ul>
                  ) : null}
                  {page.data ? <div className="agent-slides-page-data">{page.data}</div> : null}
                  {page.materialHints ? <div className="agent-slides-page-notes">{page.materialHints}</div> : null}
                  {page.notes ? <div className="agent-slides-page-notes">{page.notes}</div> : null}
                  {page.materials?.length ? (
                    <div className="agent-slides-page-media">
                      {page.materials.map((material, materialIndex) => (
                        <img
                          key={materialIndex}
                          src={material.url}
                          alt={page.title ?? ''}
                          title={material.desc ?? undefined}
                          loading="lazy"
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
    )
  }

  let body: ReactNode = null
  if (state.stage === 'draft_ready') {
    body = (
      <>
        <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_DRAFT_HINT')}</p>
        {pagesBlock}
        <div className="agent-slides-actions">
          <button
            type="button"
            className="agent-slides-action is-secondary"
            aria-label={t('surface:agentChat.SLIDES_OPEN_DRAFT_LABEL', { title })}
            disabled={busy || !state.documentId}
            onClick={openDraft}
          >
            <FileText aria-hidden="true" />
            {t('surface:agentChat.SLIDES_OPEN_DRAFT')}
          </button>
          <button
            type="button"
            className="agent-slides-action is-primary"
            aria-label={t('surface:agentChat.SLIDES_CONFIRM_CONTENT_LABEL', { title })}
            disabled={busy || pendingAction === 'confirm-content' || !state.documentId}
            onClick={() => runAction('confirm-content', () => ({
              prompt: t('surface:agentChat.SLIDES_CONFIRM_CONTENT_PROMPT', {
                documentId: state.documentId ?? '',
                title,
              }),
              display: t('surface:agentChat.SLIDES_CONFIRM_CONTENT_DISPLAY'),
            }))}
          >
            {pendingAction === 'confirm-content' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {t('surface:agentChat.SLIDES_CONFIRM_CONTENT')}
          </button>
        </div>
      </>
    )
  } else if (state.stage === 'style_images_ready') {
    const candidates = state.styleCandidates ?? []
    body = (
      <>
        <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_STYLE_PICK_HINT')}</p>
        <div className="agent-slides-style-strip">
          {candidates.map((candidate, index) => (
            <button
              key={`${candidate.url}-${String(index)}`}
              type="button"
              className={`agent-slides-style-thumb${index === styleIndex ? ' is-active' : ''}`}
              aria-label={t('surface:agentChat.SLIDES_STYLE_VIEW_BIG', {
                index: index + 1,
                label: candidate.label ?? t('surface:agentChat.SLIDES_STYLE_OPTION', { index: index + 1 }),
              })}
              onClick={() => { setStyleIndex(index); setStylePickerOpen(true) }}
            >
              <img src={candidate.url} alt={candidate.label ?? ''} loading="lazy" />
              <span>{candidate.label ?? t('surface:agentChat.SLIDES_STYLE_OPTION', { index: index + 1 })}</span>
            </button>
          ))}
        </div>
        <div className="agent-slides-actions">
          <button
            type="button"
            className="agent-slides-action is-primary"
            disabled={busy || candidates.length === 0}
            onClick={() => { setStyleIndex(0); setStylePickerOpen(true) }}
          >
            {t('surface:agentChat.SLIDES_STYLE_VIEW_BIG_ACTION')}
          </button>
          <button
            type="button"
            className="agent-slides-action is-secondary"
            disabled={busy || pendingAction === 'style-regenerate'}
            onClick={() => runAction('style-regenerate', () => ({
              prompt: state.documentId
                ? t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT', { documentId: state.documentId })
                : t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT_NO_DOC'),
              display: t('surface:agentChat.SLIDES_STYLE_REGENERATE_DISPLAY'),
            }))}
          >
            {t('surface:agentChat.SLIDES_STYLE_REGENERATE')}
          </button>
        </div>
      </>
    )
  } else if (state.stage === 'style_card_ready' && state.styleCard) {
    const card = state.styleCard
    body = (
      <>
        <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_STYLE_CARD_HINT')}</p>
        {card.demoImageUrl ? (
          <img className="agent-slides-style-demo" src={card.demoImageUrl} alt={t('surface:agentChat.SLIDES_STYLE_DEMO_ALT', { title })} loading="lazy" />
        ) : null}
        {card.effectLines.length ? (
          <div className="agent-slides-style-meaning">
            <strong>{t('surface:agentChat.SLIDES_STYLE_MEANING')}</strong>
            <ul>{card.effectLines.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
        <details className="agent-slides-style-details-toggle">
            <summary>{t('surface:agentChat.SLIDES_STYLE_DETAILS')}</summary>
            {card.swatches.length ? (
              <div className="agent-slides-style-swatches">
                {card.swatches.map((swatch) => (
                  <span key={swatch.label} className="agent-slides-style-swatch">
                    <i style={{ background: swatch.hex }} />
                    <b>{swatch.label}</b>
                    <small>{swatch.hex.toUpperCase()}</small>
                  </span>
                ))}
              </div>
            ) : null}
            {card.typography.length ? (
              <dl className="agent-slides-style-typography">
                {card.typography.map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
                ))}
              </dl>
            ) : null}
            {card.details?.length ? (
              <dl className="agent-slides-style-typography agent-slides-style-details">
                {card.details.map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
                ))}
              </dl>
            ) : null}
            {card.wireframes.length ? (
              <div className="agent-slides-style-wireframes">
                {card.wireframes.map((frame) => (
                  <figure key={frame.role} className="agent-slides-style-wireframe">
                    <div dangerouslySetInnerHTML={{ __html: frame.svg }} />
                    <figcaption>{frame.label}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
        </details>
        <div className="agent-slides-actions">
          <button
            type="button"
            className="agent-slides-action is-primary"
            aria-label={t('surface:agentChat.SLIDES_STYLE_CONFIRM_LABEL', { title })}
            disabled={busy || pendingAction === 'style-confirm' || !state.styleSessionId}
            onClick={() => runAction('style-confirm', () => ({
              prompt: t('surface:agentChat.SLIDES_STYLE_CONFIRM_PROMPT', {
                sessionId: state.styleSessionId ?? '',
              }),
              display: t('surface:agentChat.SLIDES_STYLE_CONFIRM_DISPLAY'),
            }))}
          >
            {pendingAction === 'style-confirm' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {t('surface:agentChat.SLIDES_STYLE_CONFIRM')}
          </button>
          <button
            type="button"
            className="agent-slides-action is-ghost"
            disabled={busy || pendingAction === 'style-regenerate'}
            onClick={() => {
              setStyleIndex(0)
              setStylePickerOpen(false)
              runAction('style-regenerate', () => ({
                prompt: state.documentId
                  ? t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT', { documentId: state.documentId })
                  : t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT_NO_DOC'),
                display: t('surface:agentChat.SLIDES_STYLE_REGENERATE_DISPLAY'),
              }))
            }}
          >
            {t('surface:agentChat.SLIDES_STYLE_REGENERATE')}
          </button>
        </div>
      </>
    )
  } else if (state.stage === 'page_images_confirm') {
    body = (
      <>
        <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_IMAGES_CONFIRM_HINT')}</p>
        <div className="agent-slides-actions">
          <button
            type="button"
            className="agent-slides-action is-primary"
            aria-label={t('surface:agentChat.SLIDES_IMAGES_GENERATE_LABEL', { title })}
            disabled={busy || pendingAction === 'images-generate' || !state.documentId}
            onClick={() => runAction('images-generate', () => ({
              prompt: t('surface:agentChat.SLIDES_IMAGES_GENERATE_PROMPT', {
                documentId: state.documentId ?? '',
                title,
              }),
              display: t('surface:agentChat.SLIDES_IMAGES_GENERATE_DISPLAY'),
            }))}
          >
            {pendingAction === 'images-generate' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {t('surface:agentChat.SLIDES_IMAGES_GENERATE')}
          </button>
          <button
            type="button"
            className="agent-slides-action is-secondary"
            disabled={busy || pendingAction === 'images-skip'}
            onClick={() => runAction('images-skip', () => ({
              prompt: t('surface:agentChat.SLIDES_IMAGES_SKIP_PROMPT', { documentId: state.documentId ?? '' }),
              display: t('surface:agentChat.SLIDES_IMAGES_SKIP_DISPLAY'),
            }))}
          >
            {t('surface:agentChat.SLIDES_IMAGES_SKIP')}
          </button>
        </div>
      </>
    )
  } else if (state.stage === 'page_images_review') {
    body = (
      <SlidesPageImagesReview
        documentId={state.documentId}
        generation={state.generation}
        pages={pages}
        doneCount={doneCount}
        totalPages={total}
        busy={busy}
        pending={pendingAction !== null}
        onSubmit={(prompt, displayText) => runAction('images-submit', () => ({ prompt, display: displayText }))}
      />
    )
  } else if (state.stage === 'page_applied') {
    if (completed) {
      body = (
        <>
          <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_DONE_HINT')}</p>
          {state.draftArchived ? (
            <p className="agent-slides-card-note">{t('surface:agentChat.SLIDES_DRAFT_ARCHIVED')}</p>
          ) : null}
          <div className="agent-slides-actions">
            {state.fileEntryId ? (
              <button
                type="button"
                className="agent-slides-action is-primary"
                aria-label={t('surface:agentChat.SLIDES_OPEN_PPT_LABEL', { title })}
                disabled={busy}
                onClick={openDeck}
              >
                <Presentation aria-hidden="true" />
                {t('surface:agentChat.SLIDES_OPEN_PPT')}
              </button>
            ) : null}
            <button
              type="button"
              className="agent-slides-action is-secondary"
              aria-label={t('surface:agentChat.SLIDES_CONTINUE_EDIT_LABEL', { title })}
              disabled={busy || pendingAction === 'continue-edit'}
              onClick={() => runAction('continue-edit', () => ({
                prompt: t('surface:agentChat.SLIDES_CONTINUE_EDIT_PROMPT', {
                  title,
                  fileEntryId: state.fileEntryId ?? '',
                }),
                display: t('surface:agentChat.SLIDES_CONTINUE_EDIT_DISPLAY', { title }),
              }))}
            >
              {t('surface:agentChat.SLIDES_CONTINUE_EDIT')}
            </button>
          </div>
          {openError ? <p className="agent-slides-error-note" role="alert">{openError}</p> : null}
          {failedPagesBlock}
          {warningsBlock}
        </>
      )
    } else if (partial) {
      body = (
        <>
          <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_PARTIAL_HINT', { done: doneCount, total })}</p>
          {pagesBlock}
          {failedPagesBlock}
          {warningsBlock}
          <div className="agent-slides-actions">
            {state.documentId ? (
              <button
                type="button"
                className="agent-slides-action is-primary"
                disabled={busy || pendingAction === 'continue-remaining'}
                onClick={() => runAction('continue-remaining', () => ({
                  prompt: t('surface:agentChat.SLIDES_CONTINUE_REMAINING_PROMPT', {
                    documentId: state.documentId ?? '',
                    pages: failedPages.map((pageIndex) => pageIndex + 1).join('、'),
                  }),
                  display: t('surface:agentChat.SLIDES_CONTINUE_REMAINING_DISPLAY'),
                }))}
              >
                {t('surface:agentChat.SLIDES_CONTINUE_REMAINING')}
              </button>
            ) : null}
            {state.fileEntryId ? (
              <button type="button" className="agent-slides-action is-secondary" disabled={busy} onClick={openDeck}>
                {t('surface:agentChat.SLIDES_OPEN_EXISTING')}
              </button>
            ) : null}
          </div>
          {openError ? <p className="agent-slides-error-note" role="alert">{openError}</p> : null}
        </>
      )
    } else {
      body = (
        <>
          {pagesBlock}
          {warningsBlock}
        </>
      )
    }
  } else if (state.stage === 'failed') {
    const errorText = state.errorCode && ERROR_MESSAGE_KEYS[state.errorCode]
      ? t(ERROR_MESSAGE_KEYS[state.errorCode]!)
      : (state.errorMessage || t('surface:agentChat.SLIDES_ERROR_UNKNOWN'))
    body = (
      <>
        <div className="agent-slides-failure" role="alert">
          <strong>{errorText}</strong>
          {doneCount > 0 ? (
            <small>{t('surface:agentChat.SLIDES_FAILED_KEPT_PROGRESS', { done: doneCount, total })}</small>
          ) : null}
        </div>
        {failedPagesBlock}
        {warningsBlock}
        <div className="agent-slides-actions">
          {state.retryable ? (
            <button
              type="button"
              className="agent-slides-action is-primary"
              disabled={busy || pendingAction === 'retry'}
              onClick={() => runAction('retry', () => ({
                prompt: t('surface:agentChat.SLIDES_RETRY_PROMPT', { reason: errorText }),
                display: t('surface:agentChat.SLIDES_RETRY_DISPLAY'),
              }))}
            >
              {pendingAction === 'retry' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
              {t('surface:agentChat.SLIDES_RETRY')}
            </button>
          ) : null}
          {state.fileEntryId ? (
            <button
              type="button"
              className={state.retryable ? 'agent-slides-action is-secondary' : 'agent-slides-action is-primary'}
              disabled={busy}
              onClick={openDeck}
            >
              {t('surface:agentChat.SLIDES_OPEN_EXISTING')}
            </button>
          ) : null}
        </div>
        {!state.retryable ? <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_RETRY_HINT')}</p> : null}
        {openError ? <p className="agent-slides-error-note" role="alert">{openError}</p> : null}
      </>
    )
  } else {
    // drafting / style_generating / style_extracting / planning / page_images / plan_ready
    body = (
      <>
        <p className="agent-slides-card-hint">{t('surface:agentChat.SLIDES_IN_PROGRESS_HINT')}</p>
        {pagesBlock}
        {warningsBlock}
      </>
    )
  }

  return (
    <section
      className={`agent-slides-card${completed ? ' is-done' : ''}${state.stage === 'failed' ? ' is-failed' : ''}${stopped ? ' is-stopped' : ''}${interrupted ? ' is-interrupted' : ''}`}
      aria-label={title}
    >
      <header className="agent-slides-card-head">
        <span className="agent-slides-card-icon" aria-hidden="true">{statusIcon}</span>
        <span className="agent-slides-card-titles">
          <strong className="agent-slides-card-title">{title}</strong>
          <span className="agent-slides-card-phase" aria-live="polite">{phaseText}</span>
        </span>
        {elapsed ? (
          <span className="agent-slides-card-time">
            {running
              ? t('surface:agentChat.SLIDES_ELAPSED', { time: elapsed })
              : t('surface:agentChat.SLIDES_ELAPSED_DONE', { time: elapsed })}
          </span>
        ) : null}
        <button
          type="button"
          className="agent-slides-card-close"
          aria-label={t('surface:agentChat.SLIDES_CLOSE_CARD')}
          onClick={() => setDismissed(true)}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      {showProgressLine ? (
        determinate ? (
          <div
            className="agent-slides-progress-line"
            role="progressbar"
            aria-label={phaseText}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={doneCount}
          >
            <i style={{ width: `${total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0}%` }} />
          </div>
        ) : (
          <div className="agent-slides-progress-line is-indeterminate" role="progressbar" aria-label={phaseText} />
        )
      ) : null}
      {errorsBanner}
      {state.narrative ? <p className="agent-slides-narrative">{state.narrative}</p> : null}
      <div className="agent-slides-card-body">{body}</div>
      {stylePickerOpen && state.styleCandidates?.length ? (
        <SlidesStylePicker
          candidates={state.styleCandidates as StyleCandidate[]}
          index={styleIndex}
          title={title}
          busy={busy}
          pending={pendingAction !== null}
          onIndexChange={setStyleIndex}
          onUse={(index) => {
            runAction('style-use', () => ({
              prompt: t('surface:agentChat.SLIDES_STYLE_PICK_PROMPT', {
                index: index + 1,
                sessionId: state.styleSessionId ?? '',
              }),
              display: t('surface:agentChat.SLIDES_STYLE_PICK_DISPLAY', { index: index + 1 }),
            }))
            setStylePickerOpen(false)
          }}
          onRegenerate={() => {
            setStylePickerOpen(false)
            runAction('style-regenerate', () => ({
              prompt: state.documentId
                ? t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT', { documentId: state.documentId })
                : t('surface:agentChat.SLIDES_STYLE_REGENERATE_PROMPT_NO_DOC'),
              display: t('surface:agentChat.SLIDES_STYLE_REGENERATE_DISPLAY'),
            }))
          }}
          onClose={() => setStylePickerOpen(false)}
        />
      ) : null}
    </section>
  )
}
