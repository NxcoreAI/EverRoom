import { CalendarDays, Database, FileText, FolderOpen, Mail } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { IngestEventDto } from '../../../../../shared/ingest'
import { formatRelative, ingestKindIcon } from './sourceKinds'
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

/** 台账行（主页预览与二级全量页共用）。 */
export function IngestRow({ event }: { event: IngestEventDto }) {
  const { locale, t } = useLocale()
  const Glyph = KIND_GLYPHS[event.sourceKind]
  return (
    <div className="src-feed-row">
      {Glyph
        ? <span className="glyph"><Glyph aria-hidden="true" strokeWidth={1.8} /></span>
        : <SourceIcon kind={ingestKindIcon(event.sourceKind) as SourceIconKind} />}
      <span className="src-feed-name">
        <strong>{event.title || t('surface:connector.untitled')}</strong>
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
