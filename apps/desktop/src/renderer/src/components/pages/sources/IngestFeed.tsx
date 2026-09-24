import { CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Database, FileSpreadsheet, FileText, Folder, Globe, ListTodo, Mail, Presentation, Camera, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { IngestEventDto } from '../../../../../shared/ingest'
import { formatRelative, providerIconKind, providerLabel } from './sourceKinds'
import { SourceIcon, type SourceGlyphTone } from './SourceIcon'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * dataType → 线条 glyph + 语义色调（对齐 gateway DATA_TYPES 注册表）。
 * 本地文件不再一律画文件夹：幻灯片/表格/文档各归各位,台账不再满屏重复图标。
 */
const DATA_TYPE_GLYPHS: Record<string, { icon: LucideIcon; tone: SourceGlyphTone }> = {
  document: { icon: FileText, tone: 'doc' },
  'office-doc': { icon: FileText, tone: 'doc' },
  'connector-document': { icon: FileText, tone: 'doc' },
  'meeting-minutes': { icon: ClipboardList, tone: 'doc' },
  spreadsheet: { icon: FileSpreadsheet, tone: 'sheet' },
  slides: { icon: Presentation, tone: 'slides' },
  html: { icon: Globe, tone: 'web' },
  mail: { icon: Mail, tone: 'mail' },
  email: { icon: Mail, tone: 'mail' },
  'connector-email': { icon: Mail, tone: 'mail' },
  calendar: { icon: CalendarDays, tone: 'cal' },
  'connector-calendar': { icon: CalendarDays, tone: 'cal' },
  'connector-todo': { icon: ListTodo, tone: 'todo' },
  'connector-record': { icon: Database, tone: 'data' },
  'perception-event': { icon: Camera, tone: 'sense' },
}

/** 台账 sourceKind 兜底（dataType 不在注册表时）。 */
const KIND_GLYPHS: Record<string, { icon: LucideIcon; tone: SourceGlyphTone }> = {
  file: { icon: Folder, tone: 'folder' },
  mail: { icon: Mail, tone: 'mail' },
  'calendar-event': { icon: CalendarDays, tone: 'cal' },
  'cloud-doc': { icon: FileText, tone: 'doc' },
  'connector-record': { icon: Database, tone: 'data' },
}

/** 台账行：品牌 logo + 标题 + 来源副行 + 过滤状态 + 时间。 */
export function IngestRow({ event }: { event: IngestEventDto }) {
  const { locale, t } = useLocale()
  // 图标优先级：provider 品牌 logo → dataType glyph → sourceKind 兜底 → 文档。
  // providerIconKind 对未知 provider 回落 web-page（Globe）——那不是品牌标,按 glyph 走。
  const brandKind = event.provider ? providerIconKind(event.provider) : null
  const branded = brandKind !== null && brandKind !== 'web-page'
  const glyph = branded ? null
    : DATA_TYPE_GLYPHS[event.dataType] ?? KIND_GLYPHS[event.sourceKind] ?? { icon: FileText, tone: 'doc' as const }
  const logoTone = branded ? undefined : glyph?.tone
  const logo = branded
    ? <SourceIcon kind={brandKind!} />
    : glyph
      ? <span className="glyph"><glyph.icon aria-hidden="true" strokeWidth={1.8} /></span>
      : null
  const label = event.sourceLabel ?? (event.provider ? providerLabel(event.provider) : null)
  return (
    <div className="src-feed-row">
      <span className="src-feed-logo" data-tone={logoTone}>{logo}</span>
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
