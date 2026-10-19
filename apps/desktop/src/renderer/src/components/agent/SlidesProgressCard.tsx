import { Check, ChevronDown, ChevronRight, FileText, LoaderCircle, Presentation, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import type { DisplayAgentToolCall } from './agentRunActivity'

/** 单页方案（网关透传的 plan.pages 条目：文案要点/数据/配图/方向）。 */
export interface SlidesPagePlan {
  title?: string
  points?: string[]
  data?: string
  materialHints?: string
  notes?: string
  materials?: Array<{ url: string; desc?: string }>
  /** 配图确认/过目卡：该页的生图提示词与已生成图（everroom-material:// 寻址）。 */
  imagePrompt?: string
  url?: string
  /** 过目打回：置灰展示，落页时该页退化图形版式。 */
  rejected?: boolean
  /** 后台生成失败：可手动重生成，否则该页退化。 */
  failed?: boolean
}

/** 风格纵览候选（everroom-material:// 寻址；label 是该候选的风格方向短名）。 */
export interface StyleCandidate {
  url: string
  label?: string
  generation: number
}

/** 风格卡数据（色块/字号/线框 SVG/演示页/效果文案——全部效果语言）。 */
export interface StyleCardData {
  swatches: Array<{ hex: string; label: string }>
  typography: Array<{ label: string; value: string }>
  wireframes: Array<{ role: string; label: string; svg: string }>
  demoImageUrl: string | null
  effectLines: string[]
}

/** slides_draft 进度载荷（网关 onUpdate details，全量快照，取最新一条即可）。 */
export interface SlidesProgressState {
  stage: 'draft_ready' | 'plan_ready' | 'page_images' | 'page_images_confirm' | 'page_images_review' | 'page_applied' | 'style_images_ready' | 'style_card_ready'
  title?: string
  totalPages?: number
  pages?: SlidesPagePlan[]
  doneCount?: number
  documentId?: string
  narrative?: string
  warnings?: string[]
  styleSessionId?: string
  styleCandidates?: StyleCandidate[]
  styleCard?: StyleCardData
  /** 配图过目卡的重生成轮次：变化即重开折叠卡，新图才能被看到。 */
  generation?: number
  /** 会话最后落库时刻：轮询响应据此判新旧，防旧响应覆盖新广播。 */
  updatedAt?: number
}

const PROGRESS_STAGES = new Set(['draft_ready', 'plan_ready', 'page_images', 'page_applied'])
const STYLE_STAGES = new Set(['style_images_ready', 'style_card_ready'])
const PAGE_IMAGE_STAGES = new Set(['page_images_confirm', 'page_images_review'])
/** 从 slides_draft 工具调用的 partialResult 还原进度载荷；不是进行中的 PPT 任务返回 null。 */
export function slidesProgressFromToolCall(tool: DisplayAgentToolCall | undefined): SlidesProgressState | null {
  if (!tool || tool.name !== 'slides_draft') return null
  const details = tool.partialResult
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const payload = (details as { details?: unknown }).details
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (typeof record.stage !== 'string') return null
  const isStyleStage = STYLE_STAGES.has(record.stage)
  const isPageImageStage = PAGE_IMAGE_STAGES.has(record.stage)
  if (!isStyleStage && !isPageImageStage && !PROGRESS_STAGES.has(record.stage)) return null
  if (isStyleStage && typeof record.styleSessionId !== 'string') return null
  if (isPageImageStage && typeof record.documentId !== 'string') return null
  if (!isStyleStage && !Array.isArray(record.pages)) return null
  // 网关载荷的候选字段叫 candidates，前端接口叫 styleCandidates——在此对齐。
  // 风格卡字段网关平铺在顶层（swatches/typography/...），前端嵌在 styleCard 下——同样对齐。
  if (isStyleStage) {
    const mapped = { ...record } as Record<string, unknown>
    if (Array.isArray(record.candidates) && !record.styleCandidates) {
      mapped.styleCandidates = record.candidates
    }
    if (record.stage === 'style_card_ready' && !record.styleCard) {
      mapped.styleCard = {
        swatches: record.swatches ?? [],
        typography: record.typography ?? [],
        wireframes: record.wireframes ?? [],
        demoImageUrl: record.demoImageUrl ?? null,
        effectLines: record.effectLines ?? [],
      }
    }
    return mapped as unknown as SlidesProgressState
  }
  return record as unknown as SlidesProgressState
}

export function SlidesProgressCard({
  state,
  toolRunning,
  busy,
  onOpenDraft,
  onGenerate,
}: {
  state: SlidesProgressState
  toolRunning: boolean
  busy?: boolean
  onOpenDraft?: (documentId: string) => void
  onGenerate?: (message: string) => void
}) {
  const { t } = useLocale()
  const isDraft = state.stage === 'draft_ready' && typeof state.documentId === 'string'
  const isStyleImages = state.stage === 'style_images_ready'
  const isStyleCard = state.stage === 'style_card_ready'
  const isPageImagesConfirm = state.stage === 'page_images_confirm' && typeof state.documentId === 'string'
  const isPageImagesReview = state.stage === 'page_images_review' && typeof state.documentId === 'string'
  const awaitingUser = isDraft || isStyleImages || isStyleCard || isPageImagesConfirm || isPageImagesReview
  // 换了新任务时清掉上一份 deck 的展开状态（渲染期重置，存上一份在 useState）
  const [prevDeckTitle, setPrevDeckTitle] = useState(state.title)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // 点「生成/使用/确认」即收起：卡片折成短卡；新的等待目标到来才重新展开（渲染期重置）
  const [confirmed, setConfirmed] = useState(!awaitingUser)
  const [bodyOpen, setBodyOpen] = useState(awaitingUser)
  const [prevAwaitingKey, setPrevAwaitingKey] = useState(
    awaitingUser ? `${state.stage}:${state.styleSessionId ?? state.documentId ?? ''}` : null,
  )
  if (prevDeckTitle !== state.title) {
    setPrevDeckTitle(state.title)
    setExpanded(new Set())
  }
  const pages = state.pages ?? []
  const total = state.totalPages ?? pages.length
  const doneCount = state.doneCount ?? 0
  const runningIndex = toolRunning ? doneCount : -1

  // 等待目标变了（草稿确认 → 挑图 → 风格卡 → 配图确认 → 配图过目，等待阶段是连续的）
  // 就重新开卡：上一阶段点按钮触发的「已确认、折叠」锁必须解开，否则下一
  // 阶段的候选/风格卡永远不显示（真机实锤：挑图卡只剩标题、点不开）。
  // 配图过目卡重生成后 stage 不变：generation 轮次拼进 key，新图到来才重开。
  const awaitingKey = awaitingUser
    ? `${state.stage}:${state.styleSessionId ?? state.documentId ?? ''}${state.stage === 'page_images_review' ? `:${String(state.generation ?? 1)}` : ''}`
    : null
  if (prevAwaitingKey !== awaitingKey) {
    setPrevAwaitingKey(awaitingKey)
    if (awaitingKey) {
      setConfirmed(false)
      setBodyOpen(true)
    }
  }

  const composeGenerateMessage = (): string => {
    return t('surface:agentChat.slidesGenerateMessage', {
      documentId: state.documentId ?? '',
      title: state.title ?? '',
    })
  }

  const statusOf = (index: number): 'done' | 'running' | 'pending' => {
    if (index < doneCount) return 'done'
    if (index === runningIndex) return 'running'
    return 'pending'
  }
  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const headerBody = (
    <span className="agent-slides-progress-title">
      <strong>{state.title}</strong>
      <small>
        {isDraft
          ? t('surface:agentChat.slidesDraftPageCount', { total })
          : isStyleImages
            ? t('surface:agentChat.slidesStylePickTitle')
            : isStyleCard
              ? t('surface:agentChat.slidesStyleCardTitle')
              : isPageImagesConfirm
                ? t('surface:agentChat.slidesPageImagesConfirmTitle')
                : isPageImagesReview
                  ? doneCount < total
                    ? t('surface:agentChat.slidesImagesProgress', { done: doneCount, total })
                    : t('surface:agentChat.slidesPageImagesReviewTitle')
                  : state.stage === 'page_images'
                    ? t('surface:agentChat.slidesImagesProgress', { done: doneCount, total })
                    : t('surface:agentChat.slidesDeckProgress', { done: doneCount, total })}
        {isStyleImages ? <i aria-hidden="true" style={{ marginLeft: 4, fontSize: 9, color: '#4a90d9', fontStyle: 'normal' }}>·v3</i> : null}
      </small>
    </span>
  )

  return (
    <section className="agent-slides-progress" aria-label={state.title ?? undefined}>
      {confirmed ? (
        <button
          type="button"
          className="agent-slides-progress-header"
          aria-expanded={bodyOpen}
          onClick={() => setBodyOpen((prev) => !prev)}
        >
          <span className="agent-slides-progress-icon"><Presentation aria-hidden="true" /></span>
          {headerBody}
          {bodyOpen
            ? <ChevronDown className="agent-slides-progress-chevron" aria-hidden="true" />
            : <ChevronRight className="agent-slides-progress-chevron" aria-hidden="true" />}
        </button>
      ) : (
        <header className="agent-slides-progress-header">
          <span className="agent-slides-progress-icon"><Presentation aria-hidden="true" /></span>
          {headerBody}
        </header>
      )}

      {bodyOpen && state.narrative ? <p className="agent-slides-narrative">{state.narrative}</p> : null}

      {bodyOpen && isStyleImages && !confirmed && state.styleCandidates?.length ? (
        <div className="agent-slides-style-candidates">
          {state.styleCandidates.map((candidate, index) => (
            <button
              key={`${candidate.url}-${String(index)}`}
              type="button"
              className="agent-slides-style-candidate"
              aria-label={t('surface:agentChat.slidesStyleUse', { index: index + 1 })}
              disabled={busy}
              onClick={() => {
                setConfirmed(true)
                setBodyOpen(false)
                onGenerate?.(t('surface:agentChat.slidesStylePickMessage', {
                  index: index + 1,
                  sessionId: state.styleSessionId ?? '',
                }))
              }}
            >
              <img src={candidate.url} alt="" loading="lazy" />
              {candidate.label ? <span className="agent-slides-style-candidate-label">{candidate.label}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {bodyOpen && isStyleCard && !confirmed && state.styleCard ? (
        <div className="agent-slides-style-card">
          {state.styleCard.swatches.length ? (
            <div className="agent-slides-style-swatches">
              {state.styleCard.swatches.map((swatch) => (
                <span key={swatch.label} className="agent-slides-style-swatch">
                  <i style={{ background: swatch.hex }} />
                  <b>{swatch.label}</b>
                  <small>{swatch.hex.toUpperCase()}</small>
                </span>
              ))}
            </div>
          ) : null}
          {state.styleCard.typography.length ? (
            <dl className="agent-slides-style-typography">
              {state.styleCard.typography.map((row) => (
                <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
              ))}
            </dl>
          ) : null}
          {state.styleCard.wireframes.length ? (
            <div className="agent-slides-style-wireframes">
              {state.styleCard.wireframes.map((frame) => (
                <figure key={frame.role} className="agent-slides-style-wireframe">
                  <div dangerouslySetInnerHTML={{ __html: frame.svg }} />
                  <figcaption>{frame.label}</figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          {state.styleCard.demoImageUrl ? (
            <img className="agent-slides-style-demo" src={state.styleCard.demoImageUrl} alt="" loading="lazy" />
          ) : null}
          {state.styleCard.effectLines.length ? (
            <ul className="agent-slides-style-lines">
              {state.styleCard.effectLines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          <button
            type="button"
            className="agent-slides-style-confirm"
            disabled={busy}
            onClick={() => {
              setConfirmed(true)
              setBodyOpen(false)
              onGenerate?.(t('surface:agentChat.slidesStyleConfirmMessage', {
                sessionId: state.styleSessionId ?? '',
              }))
            }}
          >
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Presentation aria-hidden="true" />}
            {t('surface:agentChat.slidesStyleConfirm')}
          </button>
        </div>
      ) : null}

      {bodyOpen && isPageImagesConfirm && !confirmed ? (
        <div className="agent-slides-confirm">
          <button
            type="button"
            className="agent-slides-generate"
            disabled={busy}
            onClick={() => {
              setConfirmed(true)
              setBodyOpen(false)
              onGenerate?.(t('surface:agentChat.slidesPageImagesGenerateMessage', {
                documentId: state.documentId ?? '',
                title: state.title ?? '',
              }))
            }}
          >
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Presentation aria-hidden="true" />}
            {t('surface:agentChat.slidesPageImagesGenerate')}
          </button>
          <button
            type="button"
            className="agent-slides-open-draft"
            disabled={busy}
            onClick={() => {
              setConfirmed(true)
              setBodyOpen(false)
              onGenerate?.(t('surface:agentChat.slidesPageImagesSkipMessage', { documentId: state.documentId ?? '' }))
            }}
          >
            {t('surface:agentChat.slidesPageImagesSkip')}
          </button>
        </div>
      ) : null}

      {bodyOpen && isPageImagesReview && !confirmed ? (
        <>
          <div className="agent-slides-page-review-list">
            {pages.map((page, index) => {
              if (!page.url) {
                // 后台生成中/失败的页：标题行占位，失败的页可手动重生成。
                return (
                  <div key={index} className={`agent-slides-page-review is-pending${page.failed ? ' is-failed' : ''}`}>
                    <div className="agent-slides-page-review-title">
                      <span className="agent-slides-page-index">{index + 1}</span>
                      <span className="agent-slides-page-title" title={page.title ?? undefined}>{page.title}</span>
                      <small>{page.failed
                        ? t('surface:agentChat.slidesPageImagesFailed')
                        : t('surface:agentChat.slidesPageImagesPending')}</small>
                    </div>
                    {page.failed ? (
                      <button
                        type="button"
                        className="agent-slides-page-regenerate"
                        disabled={busy}
                        onClick={() => {
                          setConfirmed(true)
                          setBodyOpen(false)
                          onGenerate?.(t('surface:agentChat.slidesPageImagesRegenerateMessage', {
                            index: index + 1,
                            documentId: state.documentId ?? '',
                          }))
                        }}
                      >
                        <RefreshCw aria-hidden="true" />
                        {t('surface:agentChat.slidesPageImagesRegenerate')}
                      </button>
                    ) : null}
                  </div>
                )
              }
              return (
              <div key={index} className={`agent-slides-page-review${page.rejected ? ' is-rejected' : ''}`}>
                <img src={page.url} alt={page.imagePrompt ?? ''} title={page.imagePrompt ?? undefined} loading="lazy" />
                <div className="agent-slides-page-review-actions">
                  <button
                    type="button"
                    className="agent-slides-page-regenerate"
                    disabled={busy}
                    onClick={() => {
                      setConfirmed(true)
                      setBodyOpen(false)
                      onGenerate?.(t('surface:agentChat.slidesPageImagesRegenerateMessage', {
                        index: index + 1,
                        documentId: state.documentId ?? '',
                      }))
                    }}
                  >
                    <RefreshCw aria-hidden="true" />
                    {t('surface:agentChat.slidesPageImagesRegenerate')}
                  </button>
                  {page.rejected ? (
                    <button
                      type="button"
                      className="agent-slides-page-restore"
                      disabled={busy}
                      onClick={() => {
                        onGenerate?.(t('surface:agentChat.slidesPageImagesRestoreMessage', {
                          index: index + 1,
                          documentId: state.documentId ?? '',
                        }))
                      }}
                    >
                      {t('surface:agentChat.slidesPageImagesRestore')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="agent-slides-page-reject"
                      disabled={busy}
                      onClick={() => {
                        onGenerate?.(t('surface:agentChat.slidesPageImagesRejectMessage', {
                          index: index + 1,
                          documentId: state.documentId ?? '',
                        }))
                      }}
                    >
                      {t('surface:agentChat.slidesPageImagesReject')}
                    </button>
                  )}
                </div>
              </div>
              )
            })}
          </div>
          <div className="agent-slides-confirm">
            <button
              type="button"
              className="agent-slides-style-confirm"
              disabled={busy}
              onClick={() => {
                setConfirmed(true)
                setBodyOpen(false)
                onGenerate?.(t('surface:agentChat.slidesPageImagesAcceptMessage', { documentId: state.documentId ?? '' }))
              }}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Presentation aria-hidden="true" />}
              {t('surface:agentChat.slidesPageImagesAccept')}
            </button>
          </div>
        </>
      ) : null}

      {bodyOpen && pages.length > 0 && !isPageImagesReview ? (
        <ol className="agent-slides-progress-pages">
          {pages.map((page, index) => {
            const status = statusOf(index)
            const hasDetail = Boolean(page.points?.length || page.data || page.materialHints || page.notes || page.materials?.length || page.imagePrompt)
            const open = hasDetail && expanded.has(index)
            return (
              <li key={index} className={`agent-slides-page${status === 'running' ? ' is-running' : ''}${open ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="agent-slides-page-head"
                  aria-expanded={open}
                  aria-label={page.title ?? undefined}
                  onClick={() => hasDetail && toggleExpanded(index)}
                >
                  <span className="agent-slides-page-index">{index + 1}</span>
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
                    {page.imagePrompt ? <div className="agent-slides-page-notes">{page.imagePrompt}</div> : null}
                    {page.materials?.length ? (
                      <div className="agent-slides-page-media">
                        {page.materials.map((material, materialIndex) => (
                          <img
                            key={materialIndex}
                            src={material.url}
                            alt={material.desc ?? ''}
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
      ) : null}

      {state.warnings?.length ? (
        <div className="agent-slides-stopped">{state.warnings.join('；')}</div>
      ) : null}

      {isDraft && !confirmed ? (
        <div className="agent-slides-confirm">
          <button
            type="button"
            className="agent-slides-open-draft"
            disabled={busy}
            onClick={() => onOpenDraft?.(state.documentId as string)}
          >
            <FileText aria-hidden="true" />
            {t('surface:agentChat.slidesOpenDraft')}
          </button>
          <button
            type="button"
            className="agent-slides-generate"
            disabled={busy}
            onClick={() => {
              setConfirmed(true)
              setBodyOpen(false)
              onGenerate?.(composeGenerateMessage())
            }}
          >
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Presentation aria-hidden="true" />}
            {t('surface:agentChat.slidesGenerate')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
