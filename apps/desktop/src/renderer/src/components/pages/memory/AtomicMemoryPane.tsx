import { Link2, Pencil, Sparkles, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryAtomicItemDto, MemoryAtomicProvenanceDto, MemoryAtomicType } from '../../../../../shared/memory'
import { dispatchRoomMemoryChanged } from '@/components/context-room/roomMemoryChange'
import { RoomAssignControl } from './RoomAssignControl'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, toMemoryFailure, type MemoryFailure } from './useMemoryData'

const PAGE_SIZE = 50

/** Room chip：标题在手时可点跳转对应 Room（App 监听 nxcore:room:open）；Room 已消失则纯展示。 */
function RoomChipNav({ roomId, roomTitle, stopPropagation }: {
  roomId: string
  roomTitle: string | null
  stopPropagation?: boolean
}) {
  const { t } = useLocale()
  if (!roomTitle) {
    return (
      <span className="mem-room-chip">{t('memory:atomicMemory.roomUnavailable')}</span>
    )
  }
  return (
    <span
      className="mem-room-chip mem-room-chip-link"
      role="link"
      tabIndex={0}
      title={t('memory:atomicMemory.openRoom')}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        window.dispatchEvent(new CustomEvent('nxcore:room:open', { detail: { id: roomId, title: roomTitle } }))
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (stopPropagation) event.stopPropagation()
        window.dispatchEvent(new CustomEvent('nxcore:room:open', { detail: { id: roomId, title: roomTitle } }))
      }}
    >
      {roomTitle}
    </span>
  )
}

const TYPE_FILTERS: Array<{ value: MemoryAtomicType | 'all'; label: string }> = [
  { value: 'all', label: 'memory:atomicMemory.all' },
  { value: 'episodic', label: 'memory:atomicMemory.episodic' },
  { value: 'persona', label: 'memory:atomicMemory.persona' },
  { value: 'instruction', label: 'memory:atomicMemory.instruction' },
]

const TYPE_LABELS: Record<string, string> = {
  episodic: 'memory:atomicMemory.episodic',
  persona: 'memory:atomicMemory.persona',
  instruction: 'memory:atomicMemory.instruction',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/** 溯源区：kind=conversation → 会话原话；document → 文档名 + 标题路径 + 行区间。 */
function ProvenanceSection({ memoryId, onOpenDocument, onOpenConversation }: {
  memoryId: string
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [provenance, setProvenance] = useState<MemoryAtomicProvenanceDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setProvenance(await window.nxcore!.memory.atomicProvenance(memoryId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.unableToLoadProvenance'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="mem-provenance-toggle" onClick={() => { setOpen(true); void load() }}>
        <Link2 aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.provenance')}
      </button>
    )
  }

  const isDocument = provenance?.kind === 'document'
  return (
    <div className="mem-provenance" data-open={open}>
      <header>
        <span className="mem-source-badge" data-kind={provenance?.kind ?? ''}>
          {t(isDocument ? 'memory:atomicMemory.documentSource' : 'memory:atomicMemory.sessionSource')}
        </span>
        <button type="button" className="mem-provenance-close" onClick={() => setOpen(false)}>
          <X aria-hidden="true" strokeWidth={1.7} size={14} />
        </button>
      </header>
      {loading ? <p className="mem-loading">{t('memory:atomicMemory.loadingProvenance')}</p> : null}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {provenance ? (
        <>
          {isDocument && provenance.document ? (
            <p className="mem-provenance-source">
              {t('memory:atomicMemory.documentTitleVVersion', { title: provenance.document.title, version: provenance.document.version ?? '—' })}
              {onOpenDocument ? (
                <button type="button" onClick={() => onOpenDocument(provenance.document!.documentId)}>{t('memory:atomicMemory.viewDocument')}</button>
              ) : null}
            </p>
          ) : null}
          {!isDocument && provenance.session?.sessionId ? (
            <p className="mem-provenance-source">
              {t('memory:atomicMemory.sessionId', { id: provenance.session.sessionId })}
              {onOpenConversation ? (
                <button
                  type="button"
                  onClick={() => onOpenConversation(provenance.anchors[0]?.sessionId ?? provenance.session!.sessionId!)}
                >
                  {t('memory:atomicMemory.viewSession')}
                </button>
              ) : null}
            </p>
          ) : null}
          <ul className="mem-provenance-anchors">
            {provenance.anchors.map((anchor) => (
              <li key={anchor.messageId}>
                <header>
                  <span data-role={anchor.role}>{anchor.role === 'assistant' ? 'AI' : anchor.role === 'user' ? t('memory:atomicMemory.user') : anchor.role}</span>
                  {anchor.headingPath ? <em>{t('memory:atomicMemory.pathLinesStartEnd', { path: anchor.headingPath, start: anchor.lineStart ?? '—', end: anchor.lineEnd ?? '—' })}</em> : null}
                </header>
                <p>{anchor.content}</p>
              </li>
            ))}
            {provenance.anchors.length === 0 ? (
              <li className="mem-doc-hint">{t('memory:atomicMemory.anchorMessagesWereRemovedTheMemoryRemainsBut')}</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </div>
  )
}

function AtomicDetail({ item, onSaved, onDeleted, onOpenDocument, onOpenConversation }: {
  item: MemoryAtomicItemDto
  onSaved: () => void
  onDeleted: () => void
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
}) {
  const { locale, t } = useLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.content)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.updateAtomic(item.id, content, item.background ?? undefined)
      setEditing(false)
      if (item.roomId) dispatchRoomMemoryChanged()
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteAtomic([item.id])
      if (item.roomId) dispatchRoomMemoryChanged()
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.deleteFailed'))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mem-atomic-detail">
      <div className="mem-atomic-detail-meta">
        <span className="mem-type-badge" data-type={item.type}>{t(typeLabel(item.type))}</span>
        {item.roomId ? <RoomChipNav roomId={item.roomId} roomTitle={item.roomTitle} /> : null}
        {item.background ? <span className="mem-source">{t('memory:atomicMemory.sourceScenarioScene', { scene: item.background })}</span> : null}
        <span className="mem-time">{t('memory:atomicMemory.createdCreatedUpdatedUpdated', { created: formatDate(item.createdAt, locale), updated: formatDate(item.updatedAt, locale) })}</span>
        <span className="mem-atomic-detail-actions">
          {editing ? null : (
            <button type="button" onClick={() => { setDraft(item.content); setEditing(true) }}>
              <Pencil aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.edit')}
            </button>
          )}
          {confirming ? (
            <>
              <button type="button" className="mem-danger" disabled={busy} onClick={remove}>{t('memory:atomicMemory.confirmDelete')}</button>
              <button type="button" onClick={() => setConfirming(false)}>{t('memory:atomicMemory.cancel')}</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={editing}>
              <Trash2 aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.delete')}
            </button>
          )}
        </span>
      </div>
      <RoomAssignControl
        memoryId={item.id}
        roomId={item.roomId}
        roomTitle={item.roomTitle}
        snapshot={item}
        onChanged={onSaved}
      />
      {editing ? (
        <div className="mem-atomic-editor">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} maxLength={8192} />
          <div className="mem-atomic-editor-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>{t('memory:atomicMemory.save')}</button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>{t('memory:atomicMemory.cancel')}</button>
          </div>
        </div>
      ) : (
        <p className="mem-atomic-content">{item.content}</p>
      )}
      <ProvenanceSection
        memoryId={item.id}
        onOpenDocument={onOpenDocument}
        onOpenConversation={onOpenConversation}
      />
      {error ? <p className="mem-inline-error">{error}</p> : null}
    </div>
  )
}

type TimeRangeId = 'all' | '7d' | '30d'
type TimelineBucketId = 'today' | 'yesterday' | 'week' | 'month' | 'earlier'

const TIME_RANGES: Array<{ value: TimeRangeId; label: string }> = [
  { value: 'all', label: 'memory:timeline.all' },
  { value: '7d', label: 'memory:timeline.last7days' },
  { value: '30d', label: 'memory:timeline.last30days' },
]

const TIMELINE_BUCKETS: Array<{ id: TimelineBucketId; label: string }> = [
  { id: 'today', label: 'memory:timeline.today' },
  { id: 'yesterday', label: 'memory:timeline.yesterday' },
  { id: 'week', label: 'memory:timeline.thisWeek' },
  { id: 'month', label: 'memory:timeline.thisMonth' },
  { id: 'earlier', label: 'memory:timeline.earlier' },
]

function timeBucket(updatedAt: string): TimelineBucketId {
  const date = new Date(updatedAt)
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffDays = Math.floor((dayStart.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays <= 7) return 'week'
  if (diffDays <= 30) return 'month'
  return 'earlier'
}

export function AtomicMemoryPane({ focusItemId, onOpenDocument, onOpenConversation }: {
  focusItemId?: string | null
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
} = {}) {
  const { locale, t } = useLocale()
  const [type, setType] = useState<MemoryAtomicType | 'all'>('all')
  const [timeRange, setTimeRange] = useState<TimeRangeId>('all')
  // 时间轴形态：累计加载（加载更多），不做分页——分桶展示与分页天然冲突。
  const [items, setItems] = useState<MemoryAtomicItemDto[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failure, setFailure] = useState<MemoryFailure | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [featuredDismissed, setFeaturedDismissed] = useState(false)
  const focusAppliedRef = useRef(false)

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (replace) setLoading(true)
    else setLoadingMore(true)
    try {
      const page = await window.nxcore!.memory.listAtomic({
        ...(type === 'all' ? {} : { type }),
        limit: PAGE_SIZE,
        offset,
      })
      setFailure(null)
      setTotal(page.total)
      setItems((current) => {
        if (replace) return page.items
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !seen.has(item.id))]
      })
    } catch (error) {
      setFailure(toMemoryFailure(error))
      if (replace) setItems([])
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [type])

  useEffect(() => {
    focusAppliedRef.current = false
    void load(0, true)
  }, [load])

  useEffect(() => {
    if (reloadTick > 0) void load(0, true)
  }, [load, reloadTick])

  useEffect(() => {
    if (!focusItemId || focusAppliedRef.current || items.length === 0) return
    if (!items.some((item) => item.id === focusItemId)) return
    focusAppliedRef.current = true
    setExpandedId(focusItemId)
    window.setTimeout(() => document.querySelector(`[data-memory-id="${CSS.escape(focusItemId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0)
  }, [focusItemId, items])

  const reload = () => setReloadTick((tick) => tick + 1)

  const filtered = useMemo(() => {
    if (timeRange === 'all') return items
    const days = timeRange === '7d' ? 7 : 30
    const threshold = Date.now() - days * 86400000
    return items.filter((item) => Date.parse(item.updatedAt) >= threshold)
  }, [items, timeRange])

  // 精选：已加载条目里评分最高的一条（并列取更新时间新的）；本会话内可关闭。
  const featured = useMemo(() => {
    const pool = filtered.length > 0 ? filtered : items
    if (pool.length === 0) return null
    return [...pool].sort((left, right) => {
      const delta = (right.score ?? 0) - (left.score ?? 0)
      return delta !== 0 ? delta : right.updatedAt.localeCompare(left.updatedAt)
    })[0]
  }, [filtered, items])

  const grouped = useMemo(() => {
    const groups: Array<{ id: TimelineBucketId; label: string; items: MemoryAtomicItemDto[] }> = []
    for (const bucket of TIMELINE_BUCKETS) {
      const bucketItems = filtered.filter((item) => timeBucket(item.updatedAt) === bucket.id)
      if (bucketItems.length > 0) {
        groups.push({ id: bucket.id, label: t(bucket.label), items: bucketItems })
      }
    }
    return groups
  }, [filtered, t])

  if (failure && items.length === 0) {
    return <div className="mem-pane-error">{memoryFailureText(failure, t)}</div>
  }

  return (
    <div className="mem-atomic">
      {featured && !featuredDismissed ? (
        <div className="mem-featured-card">
          <span className="mem-featured-icon" aria-hidden="true"><Sparkles strokeWidth={1.7} /></span>
          <div className="mem-featured-body">
            <div className="mem-featured-tags">
              <span className="mem-type-badge" data-type={featured.type}>{t(typeLabel(featured.type))}</span>
              <span className="mem-featured-flag"><Sparkles aria-hidden="true" />{t('memory:timeline.featured')}</span>
              <time>{formatDate(featured.updatedAt, locale)}</time>
            </div>
            <p className="mem-featured-content">{featured.content}</p>
          </div>
          <button
            type="button"
            className="mem-featured-dismiss"
            aria-label={t('memory:timeline.dismissFeatured')}
            title={t('memory:timeline.dismissFeatured')}
            onClick={() => setFeaturedDismissed(true)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="mem-toolbar">
        <div className="mem-type-filters" role="tablist" aria-label={t('memory:atomicMemory.memoryType')}>
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              data-active={type === filter.value}
              onClick={() => { setType(filter.value); setExpandedId(null) }}
            >
              {t(filter.label)}
            </button>
          ))}
        </div>
        <div className="mem-type-filters" role="group" aria-label={t('memory:timeline.timeRange')}>
          {TIME_RANGES.map((range) => (
            <button
              key={range.value}
              type="button"
              data-active={timeRange === range.value}
              onClick={() => setTimeRange(range.value)}
            >
              {t(range.label)}
            </button>
          ))}
        </div>
        <span className="mem-count">{t('memory:atomicMemory.countItems', { count: total })}</span>
      </div>
      {loading && items.length === 0 ? (
        <p className="mem-loading">{t('memory:memory.loading')}</p>
      ) : filtered.length === 0 ? (
        <MemoryEmptyView
          title={t('memory:atomicMemory.noAtomicMemoriesYet')}
          hint={t(type === 'all' ? 'memory:atomicMemory.afterSeveralConversationsWithTheAiAssistantMemorycore' : 'memory:atomicMemory.noMemoriesOfThisType')}
        />
      ) : (
        <div className="mem-timeline">
          {grouped.map((group) => (
            <section className="mem-tl-group" key={group.id}>
              <header className="mem-tl-head">
                <span className="mem-tl-dot" aria-hidden="true" />
                <h3>{group.label}</h3>
                <span className="mem-tl-count">{group.items.length}</span>
              </header>
              <ul className="mem-tl-list">
                {group.items.map((item) => (
                  <li key={item.id} className="mem-atomic-item mem-tl-item" data-memory-id={item.id}>
                    <time className="mem-tl-time">{formatDate(item.updatedAt, locale)}</time>
                    <button
                      type="button"
                      className="mem-atomic-summary"
                      data-expanded={expandedId === item.id}
                      onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    >
                      <span className="mem-type-badge" data-type={item.type}>{t(typeLabel(item.type))}</span>
                      {item.roomId ? <RoomChipNav roomId={item.roomId} roomTitle={item.roomTitle} stopPropagation /> : null}
                      <span className="mem-atomic-text">{item.content}</span>
                    </button>
                    {expandedId === item.id ? (
                      <AtomicDetail
                        item={item}
                        onSaved={reload}
                        onDeleted={() => { setExpandedId(null); reload() }}
                        onOpenDocument={onOpenDocument}
                        onOpenConversation={onOpenConversation}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {items.length < total ? (
            <button
              type="button"
              className="mem-load-more"
              disabled={loadingMore}
              onClick={() => void load(items.length, false)}
            >
              {loadingMore ? '…' : t('memory:timeline.loadMore')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
