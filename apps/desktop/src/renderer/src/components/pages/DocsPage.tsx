import { ChevronRight, FileText, FolderKanban, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { useRoomDocumentsState } from '@/components/context-room/RoomDocumentsProvider'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { PageHeader } from './PageHeader'

function formatDocumentTime(iso: string, locale: AppLocale, t: Translate): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const diffMs = Date.now() - time
  const diffMinutes = Math.floor(diffMs / 60_000)
  if (diffMinutes < 1) return t('surface:docs.justNow')
  if (diffMinutes < 60) return t('surface:docs.countMinutesAgo', { count: diffMinutes })
  if (diffMinutes < 60 * 24) return t('surface:docs.countHoursAgo', { count: Math.floor(diffMinutes / 60) })
  if (diffMinutes < 60 * 24 * 2) return t('surface:docs.yesterday')
  return new Date(time).toLocaleString(locale, {
    year: diffMs > 365 * 24 * 3600_000 ? 'numeric' : undefined,
    month: 'numeric',
    day: 'numeric',
  })
}

interface DocumentRow {
  documentId: string
  roomId: string
  roomTitle: string
  title: string
  updatedAt: string
}

export function DocsPage({
  onNavigate,
  onOpenDocument,
}: {
  onNavigate: (page: PageId) => void
  onOpenDocument: (target: { roomId: string; documentId: string }) => void
}) {
  const { locale, t } = useLocale()
  const { state } = useContextRoomState()
  const { documentsByRoom, documentsLoading } = useRoomDocumentsState()
  const [search, setSearch] = useState('')
  const [roomFilter, setRoomFilter] = useState<string>('all')

  const roomTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const room of state.rooms) map.set(room.id, room.title)
    return map
  }, [state.rooms])

  const rows = useMemo<DocumentRow[]>(() => {
    const collected: DocumentRow[] = []
    for (const [roomId, documents] of Object.entries(documentsByRoom)) {
      const roomTitle = roomTitleById.get(roomId) ?? t('surface:docs.unknownRoom')
      for (const document of documents) {
        collected.push({
          documentId: document.id,
          roomId,
          roomTitle,
          title: document.title || t('surface:docs.untitledDocument'),
          updatedAt: document.updatedAt,
        })
      }
    }
    return collected.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [documentsByRoom, roomTitleById, t])

  // 筛选选项只列出真实存在文档的 Room,避免演示 Room 干扰。
  const roomOptions = useMemo(() => {
    const byRoom = new Map<string, { roomId: string; roomTitle: string; count: number }>()
    for (const row of rows) {
      const entry = byRoom.get(row.roomId) ?? { roomId: row.roomId, roomTitle: row.roomTitle, count: 0 }
      entry.count += 1
      byRoom.set(row.roomId, entry)
    }
    return [...byRoom.values()].sort((left, right) => right.count - left.count)
  }, [rows])

  const keyword = search.trim().toLowerCase()
  const visibleRows = useMemo(() => rows.filter((row) => (
    (roomFilter === 'all' || row.roomId === roomFilter)
    && (!keyword || row.title.toLowerCase().includes(keyword))
  )), [keyword, roomFilter, rows])

  const groupedRows = useMemo(() => {
    if (roomFilter !== 'all') return visibleRows.length ? [{ roomTitle: roomTitleById.get(roomFilter) ?? t('surface:docs.unknownRoom'), rows: visibleRows }] : []
    const groups: { roomTitle: string; rows: DocumentRow[] }[] = []
    for (const row of visibleRows) {
      const group = groups.find((item) => item.roomTitle === row.roomTitle)
      if (group) group.rows.push(row)
      else groups.push({ roomTitle: row.roomTitle, rows: [row] })
    }
    return groups
  }, [roomFilter, roomTitleById, t, visibleRows])

  return (
    <div className="page doc-page">
      <PageHeader
        title={t('surface:docs.documents')}
        action={t('surface:docs.newDocument')}
        onAction={() => onNavigate('rooms')}
      />
      <div className="doc-toolbar">
        <label className="doc-search">
          <Search aria-hidden="true" strokeWidth={1.8} />
          <input
            type="search"
            value={search}
            placeholder={t('surface:docs.searchDocumentTitles')}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="doc-filter" role="group" aria-label={t('surface:docs.filterByRoom')}>
          <button
            type="button"
            data-active={String(roomFilter === 'all')}
            onClick={() => setRoomFilter('all')}
          >
            {t('surface:docs.all')} <small>{rows.length}</small>
          </button>
          {roomOptions.map((option) => (
            <button
              key={option.roomId}
              type="button"
              data-active={String(roomFilter === option.roomId)}
              onClick={() => setRoomFilter(option.roomId)}
            >
              {option.roomTitle} <small>{option.count}</small>
            </button>
          ))}
        </div>
      </div>

      {documentsLoading ? (
        <div className="doc-list" aria-busy="true" aria-label={t('surface:docs.loadingDocuments')}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="doc-row doc-row-skeleton" aria-hidden="true">
              <span className="item-icon"><FileText strokeWidth={1.8} /></span>
              <span className="doc-skeleton-copy">
                <i className="doc-skeleton-line" style={{ width: `${46 + (index % 3) * 12}%` }} />
                <i className="doc-skeleton-line short" />
              </span>
            </div>
          ))}
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="doc-empty">
          <FolderKanban aria-hidden="true" strokeWidth={1.6} />
          <strong>{t(keyword || roomFilter !== 'all' ? 'surface:docs.noMatchingDocuments' : 'surface:docs.noDocuments')}</strong>
          <small>{t(keyword || roomFilter !== 'all'
            ? 'surface:docs.tryAnotherSearch'
            : 'surface:docs.contextRoomEmptyHint')}</small>
          <button type="button" className="primary-button" onClick={() => onNavigate('rooms')}>
            {t('surface:docs.goToContextRoom')}
          </button>
        </div>
      ) : (
        groupedRows.map((group) => (
          <section key={group.roomTitle} className="doc-group">
            <header>
              <FolderKanban aria-hidden="true" strokeWidth={1.6} />
              <strong>{group.roomTitle}</strong>
              <small>{t('surface:docs.countDocuments', { count: group.rows.length })}</small>
            </header>
            <div className="doc-list">
              {group.rows.map((row) => (
                <button
                  key={row.documentId}
                  type="button"
                  className="doc-row"
                  onClick={() => onOpenDocument({ roomId: row.roomId, documentId: row.documentId })}
                >
                  <span className="item-icon"><FileText aria-hidden="true" strokeWidth={1.8} /></span>
                  <span><strong>{row.title}</strong><small>{row.roomTitle}</small></span>
                  <time>{formatDocumentTime(row.updatedAt, locale, t)}</time>
                  <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
