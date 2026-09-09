import { CalendarDays, ChevronLeft, ChevronRight, Database, FileText, FolderOpen, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { IngestEventDto } from '../../../../../shared/ingest'
import { formatRelative, ingestKindIcon, providerIconKind, providerLabel } from './sourceKinds'
import { SourceIcon, type SourceIconKind } from './SourceIcon'
import { useLocale } from '@/i18n/LocaleContext'

/** sourceKind → 通用图标（品牌无法确定,按类型给 glyph）。 */
const KIND_GLYPHS: Record<string, typeof FolderOpen> = {
  file: FolderOpen,
  mail: Mail,
  'calendar-event': CalendarDays,
  'cloud-doc': FileText,
  'connector-record': Database,
}

/** 台账行：品牌 logo + 标题 + 来源副行 + 过滤状态 + 时间。 */
export function IngestRow({ event }: { event: IngestEventDto }) {
  const { locale, t } = useLocale()
  const Glyph = KIND_GLYPHS[event.sourceKind]
  const logo = event.provider
    ? <SourceIcon kind={providerIconKind(event.provider)} />
    : Glyph
      ? <span className="glyph"><Glyph aria-hidden="true" strokeWidth={1.8} /></span>
      : <SourceIcon kind={ingestKindIcon(event.sourceKind) as SourceIconKind} />
  const label = event.sourceLabel ?? (event.provider ? providerLabel(event.provider) : null)
  return (
    <div className="src-feed-row">
      <span className="src-feed-logo">{logo}</span>
      <span className="src-feed-name">
        <strong>{event.title || t('surface:connector.untitled')}</strong>
        {label ? <small>{label}</small> : null}
      </span>
      <span className="src-feed-kind" data-status={event.filterStatus ?? undefined}>
        {t(`surface:ingest.filter.${event.filterStatus ?? 'pending'}`)}
      </span>
      <span className="src-feed-time">{formatRelative(event.updatedAt || event.createdAt, locale)}</span>
    </div>
  )
}

/** 「最近进入」：统一导入台账。主页取最近 limit(默认5) 条,更多进二级页。 */
export function IngestFeed({ refreshKey, limit = 5, onViewAll }: { refreshKey: number; limit?: number; onViewAll?: () => void }) {
  const { t } = useLocale()
  const [events, setEvents] = useState<IngestEventDto[] | null>(null)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    const ingest = window.nxcore?.ingest
    if (!ingest) return
    let active = true
    const load = () => {
      void ingest.listEvents({ limit }).then((page) => {
        if (!active) return
        setEvents(page.items)
        setTotal(page.total)
      }).catch(() => undefined)
    }
    load()
    const timer = window.setInterval(() => { if (!document.hidden) load() }, 20_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [limit, refreshKey])

  if (!window.nxcore?.ingest) return null

  return (
    <div className="src-feed">
      {events === null ? <div className="src-feed-empty">{t('surface:sourceTable.loadingFiles')}</div> : null}
      {events !== null && events.length === 0 ? <div className="src-feed-empty">{t('surface:sources.ingestFeedEmpty')}</div> : null}
      {events?.map((event) => <IngestRow key={event.id} event={event} />)}
      {events !== null && onViewAll && total > events.length ? (
        <button type="button" className="src-feed-more" onClick={onViewAll}>
          {t('surface:sources.viewAllCounted', { count: total })}
        </button>
      ) : null}
    </div>
  )
}

const PAGE_SIZE = 50

/** 台账全量页：分页浏览（50/页）。 */
export function IngestLedger({ refreshKey }: { refreshKey: number }) {
  const { t } = useLocale()
  const [page, setPage] = useState(0)
  const [pageInfo, setPageInfo] = useState<{ items: IngestEventDto[]; total: number } | null>(null)

  useEffect(() => {
    const ingest = window.nxcore?.ingest
    if (!ingest) return
    let active = true
    const load = () => {
      void ingest.listEvents({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((result) => {
        if (active) setPageInfo(result)
      }).catch(() => undefined)
    }
    load()
    // 只轮询第一页：台账是浏览视图,翻页中的自动刷新会顶掉当前阅读位置。
    const timer = page === 0 ? window.setInterval(() => { if (!document.hidden) load() }, 20_000) : null
    return () => { active = false; if (timer) window.clearInterval(timer) }
  }, [page, refreshKey])

  if (!window.nxcore?.ingest) return null

  const total = pageInfo?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const rangeStart = pageInfo && pageInfo.items.length > 0 ? current * PAGE_SIZE + 1 : 0
  const rangeEnd = pageInfo ? current * PAGE_SIZE + pageInfo.items.length : 0

  return (
    <div className="src-feed">
      {pageInfo === null ? <div className="src-feed-empty">{t('surface:sourceTable.loadingFiles')}</div> : null}
      {pageInfo !== null && pageInfo.items.length === 0 ? <div className="src-feed-empty">{t('surface:sources.ingestFeedEmpty')}</div> : null}
      {pageInfo?.items.map((event) => <IngestRow key={event.id} event={event} />)}
      {pageInfo !== null && total > 0 ? (
        <div className="src-feed-pager">
          <button type="button" className="src-feed-page-btn" disabled={current === 0} aria-label={t('surface:sources.pagePrev')} onClick={() => setPage(current - 1)}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.8} />
          </button>
          <span className="src-feed-page-info">
            {total > PAGE_SIZE
              ? t('surface:sources.pageRange', { from: rangeStart, to: rangeEnd, total })
              : t('surface:sources.viewAllCounted', { count: total })}
          </span>
          <button type="button" className="src-feed-page-btn" disabled={current >= pages - 1} aria-label={t('surface:sources.pageNext')} onClick={() => setPage(current + 1)}>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
