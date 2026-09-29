import { Check, ChevronDown, LoaderCircle, Presentation, RotateCw } from 'lucide-react'
import { useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { AgentApprovalDecision } from '../../../../shared/sources'

import type { DisplayAgentToolCall } from './agentRunActivity'

/** 单页方案（网关透传的 plan.pages 条目：文案要点/数据/配图/方向）。 */
export interface SlidesPagePlan {
  title?: string
  points?: string[]
  data?: string
  notes?: string
  materials?: Array<{ url: string; desc?: string }>
}

/** slides_draft 进度载荷（网关 onUpdate details，全量快照，取最新一条即可）。 */
export interface SlidesProgressState {
  stage: 'plan_ready' | 'page_applied' | 'page_gate' | 'page_resolved'
  title?: string
  totalPages?: number
  pages?: SlidesPagePlan[]
  doneCount?: number
  revisingIndex?: number | null
  awaitingIndex?: number | null
  finishedEarly?: boolean
  approvalId?: string
  narrative?: string
  warnings?: string[]
}

const PROGRESS_STAGES = new Set(['plan_ready', 'page_applied', 'page_gate', 'page_resolved'])

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

type SlidesPageStatus = 'done' | 'revising' | 'awaiting' | 'pending'

export function SlidesProgressCard({
  state,
  toolRunning,
  resolvingApprovalIds,
  onResolve,
}: {
  state: SlidesProgressState
  toolRunning: boolean
  resolvingApprovalIds: ReadonlySet<string>
  onResolve: (approvalId: string, decision: AgentApprovalDecision, feedback?: string) => void
}) {
  const { t } = useLocale()
  const [feedback, setFeedback] = useState('')
  // 换了新任务时清掉上一份 deck 的展开状态（渲染期重置，存上一份在 useState）
  const [prevDeckTitle, setPrevDeckTitle] = useState(state.title)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  if (prevDeckTitle !== state.title) {
    setPrevDeckTitle(state.title)
    setExpanded(new Set())
  }
  const pages = state.pages ?? []
  const total = state.totalPages ?? pages.length
  const gateOpen = toolRunning
    && state.stage === 'page_gate'
    && typeof state.approvalId === 'string'
    && state.awaitingIndex !== null
  const approvalId = gateOpen ? state.approvalId as string : null
  const busy = approvalId !== null && resolvingApprovalIds.has(approvalId)
  const reviseReady = Boolean(feedback.trim())

  const statusOf = (index: number): SlidesPageStatus => {
    if (state.revisingIndex === index) return 'revising'
    if (gateOpen && state.awaitingIndex === index) return 'awaiting'
    if (index < (state.doneCount ?? 0)) return 'done'
    return 'pending'
  }
  const statusText = (status: SlidesPageStatus): string => status === 'done'
    ? t('surface:agentChat.slidesPageDone')
    : status === 'revising'
      ? t('surface:agentChat.slidesPageRevising')
      : status === 'awaiting'
        ? t('surface:agentChat.slidesPageAwaiting')
        : ''
  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <section className="agent-slides-progress" aria-label={state.title ?? undefined}>
      <header className="agent-slides-progress-header">
        <span className="agent-slides-progress-icon"><Presentation aria-hidden="true" /></span>
        <span className="agent-slides-progress-title">
          <strong>{state.title}</strong>
          <small>{t('surface:agentChat.slidesDeckProgress', { done: state.doneCount ?? 0, total })}</small>
        </span>
      </header>

      {state.narrative ? <p className="agent-slides-narrative">{state.narrative}</p> : null}

      {pages.length > 0 ? (
        <ol className="agent-slides-progress-pages">
          {pages.map((page, index) => {
            const status = statusOf(index)
            const hasDetail = Boolean(page.points?.length || page.data || page.notes || page.materials?.length)
            const open = hasDetail
              && (expanded.has(index)
                || (gateOpen && state.awaitingIndex === index)
                || state.revisingIndex === index)
            return (
              <li
                key={index}
                className={`agent-slides-page${status === 'awaiting' ? ' is-awaiting' : ''}${open ? ' is-open' : ''}`}
              >
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
                      {status === 'done' ? <Check aria-hidden="true" /> : status === 'revising' ? <RotateCw aria-hidden="true" /> : null}
                      {statusText(status)}
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

      {state.finishedEarly ? (
        <div className="agent-slides-stopped">{t('surface:agentChat.slidesFinishedEarly')}</div>
      ) : null}

      {approvalId !== null ? (
        <div className="agent-slides-review">
          <input
            type="text"
            value={feedback}
            disabled={busy}
            placeholder={t('surface:agentChat.slidesRevisePlaceholder')}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && reviseReady && !busy && approvalId) {
                onResolve(approvalId, 'revise', feedback.trim())
              }
            }}
          />
          <footer>
            <button
              type="button"
              className="agent-slides-stop"
              disabled={busy}
              onClick={() => approvalId && onResolve(approvalId, 'finish')}
            >
              {t('surface:agentChat.slidesFinish')}
            </button>
            <button
              type="button"
              className="agent-slides-revise"
              disabled={busy || !reviseReady}
              onClick={() => approvalId && onResolve(approvalId, 'revise', feedback.trim())}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
              {t('surface:agentChat.slidesRevise')}
            </button>
            <button
              type="button"
              className="agent-slides-continue"
              disabled={busy}
              onClick={() => approvalId && onResolve(approvalId, 'continue')}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              {t('surface:agentChat.slidesContinue')}
            </button>
          </footer>
        </div>
      ) : null}
    </section>
  )
}
