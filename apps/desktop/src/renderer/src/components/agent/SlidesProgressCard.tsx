import { Check, ChevronDown, ChevronRight, FileText, LoaderCircle, Presentation } from 'lucide-react'
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
}

/** slides_draft 进度载荷（网关 onUpdate details，全量快照，取最新一条即可）。 */
export interface SlidesProgressState {
  stage: 'draft_ready' | 'plan_ready' | 'page_applied'
  title?: string
  totalPages?: number
  pages?: SlidesPagePlan[]
  doneCount?: number
  documentId?: string
  narrative?: string
  warnings?: string[]
}

const PROGRESS_STAGES = new Set(['draft_ready', 'plan_ready', 'page_applied'])

/** 从 slides_draft 工具调用的 partialResult 还原进度载荷；不是进行中的 PPT 任务返回 null。 */
export function slidesProgressFromToolCall(tool: DisplayAgentToolCall | undefined): SlidesProgressState | null {
  if (!tool || tool.name !== 'slides_draft') return null
  const details = tool.partialResult
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const payload = (details as { details?: unknown }).details
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (typeof record.stage !== 'string' || !PROGRESS_STAGES.has(record.stage)) return null
  if (!Array.isArray(record.pages)) return null
  return record as unknown as SlidesProgressState
}

/** 草稿确认表单选项（值进确认消息，标签走 i18n）。 */
interface GenerateFormState {
  audience: number
  duration: number
  style: string | null
  focus: number
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
  const [form, setForm] = useState<GenerateFormState>({ audience: 0, duration: 1, style: null, focus: 2 })
  // 换了新任务时清掉上一份 deck 的展开状态（渲染期重置，存上一份在 useState）
  const [prevDeckTitle, setPrevDeckTitle] = useState(state.title)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // 点「生成」即确认：卡片折成短卡；新一轮 draft_ready 到来才重新出现确认表单（渲染期重置）
  const [confirmed, setConfirmed] = useState(!isDraft)
  const [bodyOpen, setBodyOpen] = useState(isDraft)
  const [prevAwaitingConfirm, setPrevAwaitingConfirm] = useState(isDraft)
  if (prevDeckTitle !== state.title) {
    setPrevDeckTitle(state.title)
    setExpanded(new Set())
  }
  if (prevAwaitingConfirm !== isDraft) {
    setPrevAwaitingConfirm(isDraft)
    if (isDraft) {
      setConfirmed(false)
      setBodyOpen(true)
    }
  }
  const pages = state.pages ?? []
  const total = state.totalPages ?? pages.length
  const doneCount = state.doneCount ?? 0
  const runningIndex = toolRunning ? doneCount : -1

  const audiences = [
    t('surface:agentChat.slidesAudienceLeader'),
    t('surface:agentChat.slidesAudienceClient'),
    t('surface:agentChat.slidesAudienceTeam'),
  ]
  const durations = [
    t('surface:agentChat.slidesDurationShort'),
    t('surface:agentChat.slidesDurationMedium'),
    t('surface:agentChat.slidesDurationLong'),
  ]
  const focusOptions = [
    t('surface:agentChat.slidesFocusPoints'),
    t('surface:agentChat.slidesFocusData'),
    t('surface:agentChat.slidesFocusBalanced'),
  ]
  const styleOptions: Array<{ key: string | null; label: string }> = [
    { key: null, label: t('surface:agentChat.slidesStyleAuto') },
    { key: 'japanese-style', label: t('surface:agentChat.slidesStyleJapanese') },
    { key: 'japanese-lifestyle', label: t('surface:agentChat.slidesStyleLifestyle') },
    { key: 'futuristic-tech-editorial', label: t('surface:agentChat.slidesStyleTech') },
    { key: 'minimalist-luxury-branding', label: t('surface:agentChat.slidesStyleLuxury') },
    { key: 'modern-illustration-editorial', label: t('surface:agentChat.slidesStyleIllustration') },
    { key: 'soft-3d-clay', label: t('surface:agentChat.slidesStyleClay') },
    { key: 'japanese-hand-drawn-editorial', label: t('surface:agentChat.slidesStyleHandDrawn') },
  ]

  const composeGenerateMessage = (): string => {
    const params = {
      documentId: state.documentId ?? '',
      title: state.title ?? '',
      audience: audiences[form.audience],
      duration: durations[form.duration],
      style: form.style ?? '',
      focus: focusOptions[form.focus],
    }
    return form.style
      ? t('surface:agentChat.slidesGenerateMessageStyled', params)
      : t('surface:agentChat.slidesGenerateMessage', params)
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
          : t('surface:agentChat.slidesDeckProgress', { done: doneCount, total })}
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

      {bodyOpen && pages.length > 0 ? (
        <ol className="agent-slides-progress-pages">
          {pages.map((page, index) => {
            const status = statusOf(index)
            const hasDetail = Boolean(page.points?.length || page.data || page.materialHints || page.notes || page.materials?.length)
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
          <div className="agent-slides-form">
            <label>
              <span>{t('surface:agentChat.slidesFormAudience')}</span>
              <select
                value={form.audience}
                disabled={busy}
                onChange={(event) => setForm((prev) => ({ ...prev, audience: Number(event.target.value) }))}
              >
                {audiences.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>{t('surface:agentChat.slidesFormDuration')}</span>
              <select
                value={form.duration}
                disabled={busy}
                onChange={(event) => setForm((prev) => ({ ...prev, duration: Number(event.target.value) }))}
              >
                {durations.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>{t('surface:agentChat.slidesFormStyle')}</span>
              <select
                value={form.style ?? ''}
                disabled={busy}
                onChange={(event) => setForm((prev) => ({ ...prev, style: event.target.value || null }))}
              >
                {styleOptions.map((option) => (
                  <option key={option.key ?? ''} value={option.key ?? ''}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('surface:agentChat.slidesFormFocus')}</span>
              <select
                value={form.focus}
                disabled={busy}
                onChange={(event) => setForm((prev) => ({ ...prev, focus: Number(event.target.value) }))}
              >
                {focusOptions.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
            </label>
          </div>
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
