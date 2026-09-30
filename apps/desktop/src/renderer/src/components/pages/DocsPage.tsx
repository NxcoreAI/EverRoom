import { ChevronRight, FileSpreadsheet, FileText, FolderKanban, Presentation, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { useRoomDocumentsState } from '@/components/context-room/RoomDocumentsProvider'
import { FilterSelect } from '@/components/context-room/ported/components/shared'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import { officePreviewKindForFileName, type OfficePreviewKind, type OfficePreviewTab } from '../../../../shared/sources'
import { showToast } from '@/state/toast'
import { useRoomAgentFiles } from './useRoomAgentFiles'
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

/** 文稿类型：云文档 + Office 产物四类（officePreviewKindForFileName 白名单）。 */
type ManuscriptType = 'document' | OfficePreviewKind

const TYPE_ICON: Record<ManuscriptType, LucideIcon> = {
  document: FileText,
  docx: FileText,
  slides: Presentation,
  spreadsheet: FileSpreadsheet,
  pdf: FileText,
}

interface ManuscriptRow {
  key: string
  roomId: string
  roomTitle: string
  title: string
  updatedAt: string
  type: ManuscriptType
  documentId?: string
  office?: { fileId: string; originalName: string; editable: boolean }
}

export function DocsPage({
  onNavigate,
  onOpenDocument,
  onOpenOfficePreview,
}: {
  onNavigate: (page: PageId) => void
  onOpenDocument: (target: { roomId: string; documentId: string }) => void
  onOpenOfficePreview: (tab: OfficePreviewTab) => void
}) {
  const { locale, t } = useLocale()
  const { state } = useContextRoomState()
  const { documentsByRoom, documentsLoading } = useRoomDocumentsState()
  const roomIds = useMemo(() => state.rooms.map((room) => room.id), [state.rooms])
  const { filesByRoom, loading: agentFilesLoading } = useRoomAgentFiles(roomIds)
  const [search, setSearch] = useState('')
  const [roomFilter, setRoomFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<ManuscriptType | 'all'>('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const roomTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const room of state.rooms) map.set(room.id, room.title)
    return map
  }, [state.rooms])

  const rows = useMemo<ManuscriptRow[]>(() => {
    const collected: ManuscriptRow[] = []
    for (const [roomId, documents] of Object.entries(documentsByRoom)) {
      const roomTitle = roomTitleById.get(roomId) ?? t('surface:docs.unknownRoom')
      for (const document of documents) {
        collected.push({
          key: `doc:${document.id}`,
          documentId: document.id,
          roomId,
          roomTitle,
          title: document.title || t('surface:docs.untitledDocument'),
          updatedAt: document.updatedAt,
          type: 'document',
        })
      }
    }
    for (const [roomId, files] of Object.entries(filesByRoom)) {
      const roomTitle = roomTitleById.get(roomId) ?? t('surface:docs.unknownRoom')
      for (const file of files) {
        const kind = officePreviewKindForFileName(file.originalName)
        // 非 Office 产物（异常扩展名）不进文稿列表，仍归 Room 产物库。
        if (!kind) continue
        collected.push({
          key: `file:${file.id}`,
          roomId,
          roomTitle,
          title: file.originalName,
          updatedAt: file.uploadedAt,
          type: kind,
          office: {
            fileId: file.id,
            originalName: file.originalName,
            editable: /\.(docx|pptx|xlsx)$/.test(file.originalName.toLowerCase()),
          },
        })
      }
    }
    return collected.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [documentsByRoom, filesByRoom, roomTitleById, t])

  // 筛选选项只列出真实存在文稿的 Room，避免演示 Room 干扰。
  const roomOptions = useMemo(() => {
    const byRoom = new Map<string, { roomId: string; roomTitle: string; count: number }>()
    for (const row of rows) {
      const entry = byRoom.get(row.roomId) ?? { roomId: row.roomId, roomTitle: row.roomTitle, count: 0 }
      entry.count += 1
      byRoom.set(row.roomId, entry)
    }
    return [...byRoom.values()].sort((left, right) => right.count - left.count)
  }, [rows])

  const roomSelectOptions = useMemo(() => [
    { id: 'all', label: t('surface:docs.filterAllRooms') },
    ...roomOptions.map((option) => ({ id: option.roomId, label: option.roomTitle })),
  ], [roomOptions, t])

  const typeSelectOptions = useMemo(() => [
    { id: 'all' as const, label: t('surface:docs.filterAllTypes') },
    { id: 'document' as const, label: t('surface:docs.type.document') },
    { id: 'docx' as const, label: t('surface:docs.type.docx') },
    { id: 'slides' as const, label: t('surface:docs.type.slides') },
    { id: 'spreadsheet' as const, label: t('surface:docs.type.spreadsheet') },
    { id: 'pdf' as const, label: t('surface:docs.type.pdf') },
  ], [t])

  const keyword = search.trim().toLowerCase()
  const visibleRows = useMemo(() => rows.filter((row) => (
    (roomFilter === 'all' || row.roomId === roomFilter)
    && (typeFilter === 'all' || row.type === typeFilter)
    && (!keyword || row.title.toLowerCase().includes(keyword))
  )), [keyword, roomFilter, rows, typeFilter])

  const groupedRows = useMemo(() => {
    if (roomFilter !== 'all') return visibleRows.length ? [{ roomTitle: roomTitleById.get(roomFilter) ?? t('surface:docs.unknownRoom'), rows: visibleRows }] : []
    const groups: { roomTitle: string; rows: ManuscriptRow[] }[] = []
    for (const row of visibleRows) {
      const group = groups.find((item) => item.roomTitle === row.roomTitle)
      if (group) group.rows.push(row)
      else groups.push({ roomTitle: row.roomTitle, rows: [row] })
    }
    return groups
  }, [roomFilter, roomTitleById, t, visibleRows])

  // Office 产物：与 Room 内嵌编辑预览同参数（OOXML 可编辑并携带 roomId 回填版本链），
  // 打开为顶栏预览标签（复用 FilesPage 的通道）。
  const openOfficeFile = (row: ManuscriptRow) => {
    const files = window.nxcore?.files
    const office = row.office
    if (!files || !office || busyKey) return
    setBusyKey(row.key)
    void files.openOriginal(
      office.fileId,
      office.originalName,
      undefined,
      office.editable ? { editable: true, roomId: row.roomId } : undefined,
    )
      .then((result) => {
        if (result.openedWith === 'office') {
          onOpenOfficePreview({ id: result.instanceId, title: office.originalName, kind: row.type as OfficePreviewKind })
        }
      })
      .catch((error) => {
        showToast({
          title: t('surface:docs.unableToOpenFile'),
          message: error instanceof Error ? error.message : undefined,
          variant: 'error',
        })
      })
      .finally(() => setBusyKey(null))
  }

  const filtered = keyword || roomFilter !== 'all' || typeFilter !== 'all'

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
        <div className="doc-toolbar-filters">
          <FilterSelect
            value={roomFilter}
            options={roomSelectOptions}
            onChange={setRoomFilter}
            ariaLabel={t('surface:docs.filterByRoom')}
          />
          <FilterSelect
            value={typeFilter}
            options={typeSelectOptions}
            onChange={setTypeFilter}
            ariaLabel={t('surface:docs.filterByType')}
          />
        </div>
      </div>

      {documentsLoading || agentFilesLoading ? (
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
          <strong>{t(filtered ? 'surface:docs.noMatchingDocuments' : 'surface:docs.noDocuments')}</strong>
          <small>{t(filtered
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
              {group.rows.map((row) => {
                const Icon = TYPE_ICON[row.type]
                return (
                  <button
                    key={row.key}
                    type="button"
                    className="doc-row"
                    onClick={() => (row.office
                      ? openOfficeFile(row)
                      : onOpenDocument({ roomId: row.roomId, documentId: row.documentId! }))}
                  >
                    <span className="item-icon"><Icon aria-hidden="true" strokeWidth={1.8} /></span>
                    <span>
                      <strong>{row.title}</strong>
                      <small>{row.roomTitle} · {t(`surface:docs.type.${row.type}`)}</small>
                    </span>
                    <time>{formatDocumentTime(row.updatedAt, locale, t)}</time>
                    <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                  </button>
                )
              })}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
