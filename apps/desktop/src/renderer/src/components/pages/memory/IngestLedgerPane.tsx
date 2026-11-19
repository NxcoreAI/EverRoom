import { ChevronLeft, ChevronRight, Eye, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'

import type { IngestEventDto, IngestFilterVerdictDto } from '../../../../../shared/ingest'
import { formatDate, memoryFailureText, scrollPaneToTop } from './useMemoryData'

const PAGE_SIZE = 50

/**
 * 统一理解引擎台账（unified-ingest-plan §9）：全部来源（文件/邮件/日程/录音/
 * 云端文档）的进入记录 + 过滤闸状态。误杀闭环的观测面——点击条目看详情
 * （判定理由 + 全文），被拦的可恢复（恢复落 reinstated_at，成为洞察 job
 * 的误杀样本）。分页翻全量台账，来源下拉收窄（gateway 单页上限 200，
 * 这里每页 50 条走翻页）。
 */
export function IngestLedgerPane({ refreshTick }: { refreshTick?: number } = {}) {
  const { locale, t } = useLocale()
  const [rows, setRows] = useState<IngestEventDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [sourceKind, setSourceKind] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reinstatingId, setReinstatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<IngestEventDto | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [detail, setDetail] = useState<IngestEventDto | null>(null)

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true)
    try {
      const result = await window.nxcore!.ingest.listEvents({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(sourceKind ? { sourceKind } : {}),
      })
      setRows(result.items)
      setTotal(result.total)
      setFailure(null)
      return true
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setLoading(false)
    }
  }, [page, sourceKind])

  useEffect(() => { void load() }, [load])

  // 手动刷新（本页按钮 + 顶部全局刷新）：完成 Toast；已有数据时失败原本静默。
  const doRefresh = useCallback(async (): Promise<void> => {
    const ok = await load()
    showToast(ok
      ? { title: t('memory:memory.refreshed') }
      : { title: t('memory:memory.refreshFailed'), variant: 'error' })
  }, [load, t])

  useEffect(() => {
    if (refreshTick) void doRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  // 换筛选条件回第一页；翻页/换筛选后滚动容器回顶（表格在 .mem-content 里滚动）
  const changeSource = (kind: string) => {
    setSourceKind(kind)
    setPage(0)
  }
  const gotoPage = (next: number) => {
    setPage(next)
    scrollPaneToTop()
  }

  // 误杀恢复：行内刷新（不整页重载）；详情弹窗开着时同步翻状态
  const reinstate = useCallback(async (eventId: string) => {
    if (reinstatingId) return
    setReinstatingId(eventId)
    setMessage(null)
    try {
      const updated = await window.nxcore!.ingest.reinstateEvent(eventId)
      setRows((prev) => prev.map((event) => (event.id === updated.id ? { ...event, ...updated } : event)))
      setDetail((current) => (current && current.id === updated.id ? { ...current, ...updated } : current))
      setMessage(t('memory:ledger.reinstateDone', { title: updated.title }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('memory:ledger.reinstateFailed'))
    } finally {
      setReinstatingId(null)
    }
  }, [reinstatingId, t])

  // 手动删除（issue: 无法手动删除数据源导入的数据——邮件类）：
  // 台账事件级级联——记忆文档 + knowledge 归属 + 台账软删。
  const requestDelete = (event: IngestEventDto) => {
    if (deletingId) return
    setConfirmDelete(event)
  }

  const confirmDeleteEvent = useCallback(async () => {
    const target = confirmDelete
    if (!target || deletingId) return
    setDeletingId(target.id)
    setMessage(null)
    try {
      await window.nxcore!.ingest.deleteEvent(target.id)
      setRows((prev) => prev.filter((event) => event.id !== target.id))
      setTotal((prev) => Math.max(0, prev - 1))
      setDetail((current) => (current && current.id === target.id ? null : current))
      setConfirmDelete(null)
      setMessage(t('memory:ledger.deleteDone', { title: target.title }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('memory:ledger.deleteFailed'))
    } finally {
      setDeletingId(null)
    }
  }, [confirmDelete, deletingId, t])

  if (failure && rows.length === 0 && !loading) {
    return <div className="mem-pane-error">{failure}</div>
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const pageEnd = Math.min((page + 1) * PAGE_SIZE, total)

  return (
    <div className="mem-ledger">
      <div className="mem-toolbar">
        <span className="mem-count">{t('memory:ledger.countEvents', { count: total })}</span>
        <span className="mem-toolbar-actions">
          <select
            className="mem-ledger-filter"
            value={sourceKind}
            onChange={(event) => changeSource(event.target.value)}
            aria-label={t('memory:ledger.filterSource')}
          >
            <option value="">{t('memory:ledger.sourceAll')}</option>
            <option value="mail">{t('memory:ledger.sourceMail')}</option>
            <option value="file">{t('memory:ledger.sourceFile')}</option>
            <option value="cloud-doc">{t('memory:ledger.sourceCloudDoc')}</option>
            <option value="calendar-event">{t('memory:ledger.sourceCalendar')}</option>
            <option value="reality-event">{t('memory:ledger.sourceReality')}</option>
            <option value="everroom-doc">{t('memory:ledger.sourceEverroomDoc')}</option>
            <option value="connector-record">{t('memory:ledger.sourceConnectorRecord')}</option>
          </select>
          <button type="button" onClick={() => void doRefresh()} disabled={loading}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={loading ? 'mem-spin' : undefined} />{t('memory:ledger.refresh')}
          </button>
        </span>
      </div>
      <p className="mem-rules-hint">{t('memory:ledger.hint')}</p>
      {message ? <p className="mem-inline-error" role="status">{message}</p> : null}
      {loading && rows.length === 0 ? <p className="mem-loading">{t('memory:ledger.loading')}</p> : null}
      {!loading && rows.length === 0 ? <p className="mem-loading">{t('memory:ledger.empty')}</p> : null}
      {rows.length > 0 ? (
        <div className="data-table mem-ledger-table">
          <div className="table-head">
            <span>{t('memory:ledger.title')}</span>
            <span>{t('memory:ledger.type')}</span>
            <span>{t('memory:ledger.pipeline')}</span>
            <span>{t('memory:ledger.filter')}</span>
            <span aria-hidden="true" />
            <span>{t('memory:ledger.time')}</span>
          </div>
          {rows.map((event) => (
            <div
              key={event.id}
              className="table-row mem-ledger-row"
              role="button"
              tabIndex={0}
              aria-label={t('memory:ledger.viewDetailName', { name: event.title })}
              onClick={() => setDetail(event)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') setDetail(event)
              }}
            >
              <span className="name-cell">
                <strong>{event.title}</strong>
                <small>{event.sourceKind} · {event.sourceId.slice(0, 8)}</small>
              </span>
              <span>{event.dataType}</span>
              <span className="pipeline-badges">
                {(['room', 'wiki', 'memory'] as const)
                  .filter((key) => event.pipelines[key])
                  .map((key) => <em key={key} className="pipeline-badge">{t(`memory:ledger.pipeline.${key}`)}</em>)}
              </span>
              <FilterStatusCell
                status={event.filterStatus}
                verdict={event.filterVerdict}
                busy={reinstatingId === event.id}
                onReinstate={() => void reinstate(event.id)}
              />
              <span
                className="filter-status-cell"
                onClick={(clickEvent) => clickEvent.stopPropagation()}
                onKeyDown={(clickEvent) => clickEvent.stopPropagation()}
                role="presentation"
              >
                <button
                  type="button"
                  className="icon-button mem-ledger-delete"
                  aria-label={t('memory:ledger.delete')}
                  title={t('memory:ledger.deleteHint')}
                  disabled={deletingId === event.id}
                  onClick={() => requestDelete(event)}
                >
                  <Trash2 aria-hidden="true" strokeWidth={1.8} className={deletingId === event.id ? 'mem-spin' : undefined} />
                </button>
              </span>
              <span>{formatDate(event.createdAt, locale)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="mem-ledger-pager">
          <button type="button" disabled={page === 0 || loading} onClick={() => gotoPage(page - 1)}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.8} />{t('memory:ledger.prevPage')}
          </button>
          <span>{t('memory:ledger.pageRange', { start: pageStart, end: pageEnd, total })}</span>
          <button type="button" disabled={page >= pageCount - 1 || loading} onClick={() => gotoPage(page + 1)}>
            {t('memory:ledger.nextPage')}<ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
      ) : null}
      {detail ? (
        <LedgerDetailDialog
          event={detail}
          onClose={() => setDetail(null)}
          onReinstate={() => void reinstate(detail.id)}
          reinstating={reinstatingId === detail.id}
          onRequestDelete={() => requestDelete(detail)}
        />
      ) : null}
      {confirmDelete ? (
        <div
          className="evidence-dialog-backdrop"
          role="presentation"
          onMouseDown={(mouseEvent) => {
            if (mouseEvent.currentTarget === mouseEvent.target) setConfirmDelete(null)
          }}
        >
          <section className="evidence-dialog mem-ledger-detail" role="dialog" aria-modal="true" aria-labelledby="ledger-delete-title">
            <header className="evidence-dialog-head">
              <div>
                <span className="mem-ledger-detail-kind">{t('memory:ledger.delete')}</span>
                <h2 id="ledger-delete-title">{confirmDelete.title}</h2>
              </div>
              <div className="mem-ledger-detail-actions">
                <button type="button" className="icon-button" title={t('memory:ledger.close')} aria-label={t('memory:ledger.close')} onClick={() => setConfirmDelete(null)}>
                  <X aria-hidden="true" strokeWidth={1.8} />
                </button>
              </div>
            </header>
            <div className="evidence-dialog-body mem-ledger-detail-body">
              <p className="mem-doc-delete-warning">{t('memory:ledger.deleteConfirmHint')}</p>
            </div>
            <footer className="mem-doc-delete-foot">
              <button type="button" disabled={deletingId !== null} onClick={() => setConfirmDelete(null)}>{t('memory:document.cancel')}</button>
              <button type="button" className="mem-danger" disabled={deletingId !== null} onClick={() => void confirmDeleteEvent()}>
                {deletingId !== null ? t('memory:document.deleting') : t('memory:ledger.deleteConfirm')}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}

/** 过滤闸状态：正常放行不打扰；被拦的给徽标 + 理由悬浮 + 恢复按钮（action=false 时只出徽标，弹窗头部持有主按钮）。 */
function FilterStatusCell({ status, verdict, busy, onReinstate, action = true }: {
  status: IngestEventDto['filterStatus']
  verdict: IngestFilterVerdictDto | null
  busy: boolean
  onReinstate: () => void
  action?: boolean
}) {
  const { t } = useLocale()
  if (status === 'filtered' && verdict?.category === 'paused') {
    // 暂停闸暂存（记忆页顶部「继续/暂停」拦下的条目）：琥珀徽标 + 可恢复
    return (
      <span
        className="filter-status-cell"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <span className="filter-badge paused" title={t('memory:ledger.filterPausedHint')}>
          {t('memory:ledger.filterPaused')}
        </span>
        {action ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t('memory:ledger.reinstate')}
            title={t('memory:ledger.reinstateHint')}
            disabled={busy}
            onClick={onReinstate}
          >
            <RotateCcw aria-hidden="true" strokeWidth={1.8} className={busy ? 'mem-spin' : undefined} />
          </button>
        ) : null}
      </span>
    )
  }
  if (status === 'filtered') {
    const hint = verdict?.reason
      ? `${verdict.reason}（${verdict.category} · ${Math.round(verdict.confidence * 100)}%）`
      : undefined
    return (
      <span
        className="filter-status-cell"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <span className="filter-badge filtered" title={hint}>{t('memory:ledger.filterBlocked')}</span>
        {action ? (
          <button
            type="button"
            className="icon-button"
            aria-label={t('memory:ledger.reinstate')}
            title={t('memory:ledger.reinstateHint')}
            disabled={busy}
            onClick={onReinstate}
          >
            <RotateCcw aria-hidden="true" strokeWidth={1.8} className={busy ? 'mem-spin' : undefined} />
          </button>
        ) : null}
      </span>
    )
  }
  if (status === 'pending') {
    return <span className="filter-badge pending" title={t('memory:ledger.filterPendingHint')}>{t('memory:ledger.filterPending')}</span>
  }
  if (status === 'bypassed') {
    return <span className="filter-badge bypassed" title={verdict?.reason}>{t('memory:ledger.filterBypassed')}</span>
  }
  return <span className="filter-badge plain">—</span>
}

/** 条目详情：判定快照 + 归一化产物全文；被拦的附恢复按钮。 */
function LedgerDetailDialog({ event, onClose, onReinstate, reinstating, onRequestDelete }: {
  event: IngestEventDto
  onClose: () => void
  onReinstate: () => void
  reinstating: boolean
  onRequestDelete: () => void
}) {
  const { locale, t } = useLocale()
  const [content, setContent] = useState<{ markdown: string; parsedAt: string } | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(true)

  useEffect(() => {
    let active = true
    setLoadingContent(true)
    setContentError(null)
    window.nxcore!.ingest.getEventContent(event.id)
      .then((result) => { if (active) setContent(result) })
      .catch(() => { if (active) setContentError('unavailable') })
      .finally(() => { if (active) setLoadingContent(false) })
    return () => { active = false }
  }, [event.id])

  const verdict: IngestFilterVerdictDto | null = event.filterVerdict
  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(mouseEvent) => {
      if (mouseEvent.currentTarget === mouseEvent.target) onClose()
    }}>
      <section className="evidence-dialog mem-ledger-detail" role="dialog" aria-modal="true" aria-labelledby="ledger-detail-title">
        <header className="evidence-dialog-head">
          <div>
            <span className="mem-ledger-detail-kind">
              {event.sourceKind} · {event.dataType}
              {event.createdAt ? ` · ${formatDate(event.createdAt, locale)}` : ''}
            </span>
            <h2 id="ledger-detail-title">{event.title}</h2>
          </div>
          <div className="mem-ledger-detail-actions">
            {event.filterStatus === 'filtered' ? (
              <button type="button" className="mem-ledger-reinstate" disabled={reinstating} onClick={onReinstate}>
                <RotateCcw aria-hidden="true" strokeWidth={1.7} className={reinstating ? 'mem-spin' : undefined} />
                {t('memory:ledger.reinstate')}
              </button>
            ) : null}
            <button
              type="button"
              className="mem-ledger-reinstate mem-danger"
              onClick={onRequestDelete}
              title={t('memory:ledger.deleteHint')}
            >
              <Trash2 aria-hidden="true" strokeWidth={1.7} />
              {t('memory:ledger.delete')}
            </button>
            <button type="button" className="icon-button" title={t('memory:ledger.close')} aria-label={t('memory:ledger.close')} onClick={onClose}>
              <X aria-hidden="true" strokeWidth={1.8} />
            </button>
          </div>
        </header>
        <div className="evidence-dialog-body mem-ledger-detail-body">
          {verdict ? (
            <div className="mem-ledger-verdict">
              <h3>{t('memory:ledger.verdictTitle')}</h3>
              <p>
                <FilterStatusCell
                  status={event.filterStatus}
                  verdict={verdict}
                  busy={reinstating}
                  onReinstate={onReinstate}
                  action={false}
                />
                <span className="mem-ledger-verdict-reason">
                  {verdict.category === 'paused' ? t('memory:ledger.filterPausedHint') : verdict.reason}
                </span>
                {verdict.category !== 'paused' ? (
                  <small>{verdict.category} · {Math.round(verdict.confidence * 100)}%</small>
                ) : null}
              </p>
            </div>
          ) : null}
          <h3><Eye aria-hidden="true" strokeWidth={1.7} /> {t('memory:ledger.contentTitle')}</h3>
          {loadingContent ? <p className="mem-loading">{t('memory:ledger.loadingContent')}</p> : null}
          {contentError ? <p className="mem-inline-error">{t('memory:ledger.contentUnavailable')}</p> : null}
          {content ? <pre className="mem-ledger-content">{content.markdown}</pre> : null}
        </div>
      </section>
    </div>
  )
}
