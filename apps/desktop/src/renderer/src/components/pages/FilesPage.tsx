import { ArrowLeft, ChevronRight, Eye, FileSpreadsheet, FileText as FileTextIcon, FileType2, FolderOpen, HardDrive, Pencil, Search, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import type {
  FileCatalogDto,
  FileImportOutcome,
  IngestEventDto,
  IngestPipelines,
} from '../../../../shared/ingest'
import { PageHeader } from './PageHeader'
import { categoryForFile, FILE_CATEGORY_DEFINITIONS, type FileCategoryDefinition } from './fileCategories'
import { formatBytes, formatDate } from './sources/sourceFormatters'
import { PRODUCT_NAME } from '@/components/ui/brand'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

type FilesView = 'files' | 'events'

interface FilePreview {
  fileId: string
  name: string
  markdown: string | null
  error: string | null
}

const PIPELINE_KEYS: { key: keyof IngestPipelines; label: string }[] = [
  { key: 'room', label: 'surface:files.room' },
  { key: 'wiki', label: 'surface:files.wiki' },
  { key: 'memory', label: 'surface:files.memory' },
]

/** 展示用类型标签（策略本身在 gateway 代码注册表 + 部署期配置文件，桌面端只读展示）。 */
const DATA_TYPE_LABELS: Record<string, string> = {
  'document': 'surface:files.document',
  'meeting-minutes': 'surface:files.meetingMinutes',
  'office-doc': 'surface:files.officeDocument',
  'spreadsheet': 'surface:files.spreadsheet',
  'slides': 'surface:files.slides',
  'html': 'surface:files.webPage',
}

const dataTypeLabel = (key: string): string => DATA_TYPE_LABELS[key] ?? key
const CATALOG_PAGE_SIZE = 200
const FILES_REFRESH_INTERVAL_MS = 2_000

interface ClassifiedFile {
  file: FileCatalogDto
  category: FileCategoryDefinition
}

let fileCatalogCache: { items: FileCatalogDto[]; total: number; complete: boolean } = {
  items: [],
  total: 0,
  complete: false,
}
let classifiedCatalogCache: { source: FileCatalogDto[]; items: Map<string, ClassifiedFile[]> } | null = null

function sameCatalogFile(left: FileCatalogDto | undefined, right: FileCatalogDto): boolean {
  return Boolean(left)
    && left!.updatedAt === right.updatedAt
    && left!.sharedTitle === right.sharedTitle
    && left!.displayName === right.displayName
    && left!.processingState === right.processingState
    && left!.agentCategory === right.agentCategory
    && left!.summary === right.summary
    && left!.clusterId === right.clusterId
    && left!.parsed === right.parsed
    && left!.bytes === right.bytes
    && left!.sourceLabel === right.sourceLabel
    && left!.tags.length === right.tags.length
    && left!.tags.every((tag, index) => tag === right.tags[index])
}

function groupCatalogFiles(files: FileCatalogDto[]): Map<string, ClassifiedFile[]> {
  if (classifiedCatalogCache?.source === files) return classifiedCatalogCache.items
  const groups = new Map<string, ClassifiedFile[]>()
  for (const file of files) {
    const category = categoryForFile(file)
    const group = groups.get(category.key) ?? []
    group.push({ file, category })
    groups.set(category.key, group)
  }
  classifiedCatalogCache = { source: files, items: groups }
  return groups
}

export function FilesPage() {
  const { locale, t } = useLocale()
  const filesApi = window.nxcore?.files
  const ingestApi = window.nxcore?.ingest
  const [view, setView] = useState<FilesView>('files')
  const [files, setFiles] = useState<FileCatalogDto[]>(() => fileCatalogCache.items)
  const [loading, setLoading] = useState(Boolean(filesApi) && !fileCatalogCache.complete)
  const [events, setEvents] = useState<IngestEventDto[]>([])
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const filesSnapshot = useRef<FileCatalogDto[]>(fileCatalogCache.items)
  const filesRefreshInFlight = useRef<Promise<void> | null>(null)

  const loadFiles = useCallback(async (full = false) => {
    if (!filesApi) return
    if (filesRefreshInFlight.current) return filesRefreshInFlight.current
    const refresh = (async () => {
      const firstPage = await filesApi.list(CATALOG_PAGE_SIZE, 0)
      const current = filesSnapshot.current
      const currentById = new Map(current.map((file) => [file.id, file]))
      const latestChanged = firstPage.total !== current.length
        || firstPage.items.some((file) => !sameCatalogFile(currentById.get(file.id), file))
      if (!full && fileCatalogCache.complete && !latestChanged) return

      const merged = new Map(currentById)
      for (const file of firstPage.items) merged.set(file.id, file)

      if (current.length === 0 && firstPage.items.length > 0) {
        fileCatalogCache = { items: firstPage.items, total: firstPage.total, complete: firstPage.items.length === firstPage.total }
        filesSnapshot.current = firstPage.items
        setFiles(firstPage.items)
        setLoading(false)
      }

      let nextFiles: FileCatalogDto[]
      if (full || !fileCatalogCache.complete || merged.size !== firstPage.total) {
        const offsets = Array.from(
          { length: Math.max(0, Math.ceil(firstPage.total / CATALOG_PAGE_SIZE) - 1) },
          (_, index) => (index + 1) * CATALOG_PAGE_SIZE,
        )
        const remainingPages = await Promise.all(offsets.map((offset) =>
          filesApi.list(CATALOG_PAGE_SIZE, offset)))
        const complete = new Map(firstPage.items.map((file) => [file.id, file]))
        for (const page of remainingPages) {
          for (const file of page.items) complete.set(file.id, file)
        }
        nextFiles = [...complete.values()]
      } else {
        nextFiles = [...merged.values()]
      }
      nextFiles.sort((left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
      fileCatalogCache = {
        items: nextFiles,
        total: firstPage.total,
        complete: nextFiles.length === firstPage.total,
      }
      filesSnapshot.current = nextFiles
      setFiles(nextFiles)
    })()
    filesRefreshInFlight.current = refresh
    try {
      await refresh
    } catch {
    } finally {
      if (filesRefreshInFlight.current === refresh) filesRefreshInFlight.current = null
      setLoading(false)
    }
  }, [filesApi])

  const loadEvents = useCallback(async () => {
    if (!ingestApi) return
    try {
      // 文件页只看文件源台账（全源台账在记忆页「导入记录」——那是理解引擎的观测面）
      setEvents((await ingestApi.listEvents({ limit: 100, sourceKind: 'file' })).items)
    } catch {
    }
  }, [ingestApi])

  useEffect(() => {
    void loadFiles(!fileCatalogCache.complete)
    void loadEvents()
    const tick = () => {
      if (document.hidden) return
      void loadFiles()
      void loadEvents()
    }
    const handleVisibilityChange = () => {
      if (document.hidden) return
      void loadFiles()
      void loadEvents()
    }
    const timer = window.setInterval(tick, FILES_REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadEvents, loadFiles])

  const classifiedFilesByCategory = useMemo(() => groupCatalogFiles(files), [files])

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const categoryCards = useMemo(() => FILE_CATEGORY_DEFINITIONS.map((definition) => ({
    ...definition,
    files: (classifiedFilesByCategory.get(definition.key) ?? []).filter(({ file }) => {
      if (!normalizedSearch) return true
      return `${file.originalName} ${file.sharedTitle} ${file.sourceLabel}`.toLocaleLowerCase().includes(normalizedSearch)
    }),
  })).filter(({ files: categoryFiles }) => categoryFiles.length > 0), [classifiedFilesByCategory, normalizedSearch])

  const selectedCategory = selectedCategoryKey
    ? categoryCards.find((category) => category.key === selectedCategoryKey) ?? null
    : null
  const SelectedCategoryIcon = selectedCategory?.icon

  const applyImportResults = useCallback(async (result: FileImportOutcome[]) => {
    if (result.length === 0) return
    const entered = result.filter((outcome) => outcome.fileId).length
    const firstError = result.find((outcome) => outcome.error)?.error
    setMessage(entered === 0 && firstError
      ? firstError
      : t('surface:files.importCompleteEnteredTotalFilesEnteredThePipeline', { entered, total: result.length }))
    await Promise.all([loadFiles(), loadEvents()])
  }, [loadEvents, loadFiles, t])

  const importFiles = async () => {
    if (!filesApi || importing) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await filesApi.pickAndImport()
      await applyImportResults(result)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:files.importFailedTryAgainLater'))
    } finally {
      setImporting(false)
    }
  }

  const isFileDrag = (event: DragEvent<HTMLDivElement>): boolean =>
    Array.from(event.dataTransfer.types).includes('Files')

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    if (!filesApi || importing) return
    dragDepth.current += 1
    setDragActive(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    if (!filesApi || importing) return
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDragActive(false)
    if (!filesApi || importing) return
    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await filesApi.importDropped(droppedFiles)
      if (result.length === 0) {
        setMessage(t('surface:files.noSupportedFilesFound'))
        return
      }
      await applyImportResults(result)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:files.importFailedTryAgainLater'))
    } finally {
      setImporting(false)
    }
  }

  const runFileAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setMessage(null)
    try {
      await action()
      await loadFiles()
    } catch {
    } finally {
      setBusyId(null)
    }
  }

  const openPreview = async (file: FileCatalogDto) => {
    if (!filesApi) return
    setPreview({ fileId: file.id, name: file.sharedTitle, markdown: null, error: null })
    try {
      const result = await filesApi.readMarkdown(file.id)
      setPreview({ fileId: file.id, name: file.sharedTitle, markdown: result.markdown, error: null })
    } catch (error) {
      setPreview({
        fileId: file.id,
        name: file.sharedTitle,
        markdown: null,
        error: error instanceof Error ? error.message : t('surface:files.unableToReadParsedOutput'),
      })
    }
  }

  const renameFile = (file: FileCatalogDto) => {
    if (!filesApi) return
    const nextName = window.prompt(t('surface:files.fileDisplayName'), file.sharedTitle)
    if (nextName === null || !nextName.trim() || nextName.trim() === file.sharedTitle) return
    void runFileAction(file.id, () => file.clusterId
      ? filesApi.pinClusterTitle(file.clusterId, nextName.trim())
      : filesApi.rename(file.id, nextName.trim()))
  }

  const deleteFile = (file: FileCatalogDto) => {
    if (!filesApi) return
    if (!window.confirm(t('surface:files.deleteNameThisAlsoRemovesItsRoomEvidence', { name: file.originalName }))) return
    void runFileAction(file.id, () => filesApi.delete(file.id))
  }

  return (
    <div
      className="page files-page-drop-target"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      {dragActive ? (
        <div className="files-drop-overlay" role="status">
          <Upload aria-hidden="true" strokeWidth={1.8} />
          <strong>{t('surface:files.dropToImportFilesAndFolders')}</strong>
        </div>
      ) : null}
      <PageHeader
        title={t('surface:files.documentRecognition')}
        description={t('surface:files.documentRecognitionDescription', { product: PRODUCT_NAME })}
        action={t('surface:files.importFiles')}
        actionDisabled={!filesApi || importing}
        onAction={() => void importFiles()}
        extraAction={
          <div className="segmented-control" aria-label={t('surface:files.fileView')}>
            <button type="button" data-active={String(view === 'files')} onClick={() => setView('files')}>{t('surface:files.files')}</button>
            <button type="button" data-active={String(view === 'events')} onClick={() => { setView('events'); void loadEvents() }}>{t('surface:files.importHistory')}</button>
          </div>
        }
      />
      {!filesApi ? (
        <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>{t('surface:files.importFilesInTheDesktopApp')}</strong><span>{t('surface:files.theWebVersionNeverRequestsOrReadsLocal')}</span></div></div>
      ) : null}
      {message ? <div className="source-feedback" role="status">{message}</div> : null}

      {view === 'files' && filesApi ? (
        <section className="file-recognition" aria-labelledby="file-recognition-heading">
          <div className="file-recognition-toolbar">
            {selectedCategory ? (
              <button type="button" className="file-back-button" onClick={() => setSelectedCategoryKey(null)}>
                <ArrowLeft aria-hidden="true" strokeWidth={1.8} />
                <span>{t('surface:files.files')}</span>
              </button>
            ) : (
              <h2 id="file-recognition-heading">{t('surface:files.documentRecognitionCount', { count: categoryCards.length })}</h2>
            )}
            <div className="file-recognition-tools">
              {searchOpen ? (
                <input
                  autoFocus
                  type="search"
                  value={searchQuery}
                  placeholder={t('surface:files.searchFiles')}
                  aria-label={t('surface:files.searchFiles')}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              ) : null}
              <button type="button" className="icon-button file-search-button" aria-label={t('surface:files.searchFiles')} title={t('surface:files.searchFiles')} onClick={() => setSearchOpen((open) => !open)}>
                <Search aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {loading ? <div className="source-loading">{t('surface:files.loadingFiles')}</div> : null}
          {!loading && !selectedCategory && categoryCards.length === 0 ? (
            <div className="file-recognition-empty">
              <span className="file-recognition-empty-icon"><FileTextIcon /></span>
              <strong>{t(searchQuery ? 'surface:files.noMatchingFiles' : 'surface:files.noRecognizableFiles')}</strong>
              <p>{t(searchQuery ? 'surface:files.tryAnotherKeyword' : 'surface:files.importFilesToClassifyAutomatically')}</p>
            </div>
          ) : null}

          {!loading && !selectedCategory ? (
            <div className="file-category-grid">
              {categoryCards.map((category) => {
                const CategoryIcon = category.icon
                return (
                  <button
                    key={category.key}
                    type="button"
                    className={`file-category-card file-category-${category.tone}`}
                    onClick={() => setSelectedCategoryKey(category.key)}
                  >
                    <span className="file-category-card-head">
                      <span className="file-category-title-wrap">
                        <span className="file-category-icon"><CategoryIcon aria-hidden="true" strokeWidth={1.8} /></span>
                        <span>
                          <strong>{t(category.label)}</strong>
                          <small>{t('surface:files.countFiles', { count: category.files.length })}</small>
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                    </span>
                    <span className="file-category-list">
                      {category.files.slice(0, 5).map(({ file }) => (
                        <span className="file-category-item" key={file.id}>
                          <FileTypeIcon file={file} />
                          <span title={`${file.sharedTitle} · ${file.originalName}`}>{file.sharedTitle}</span>
                        </span>
                      ))}
                      {category.files.length > 5 ? <small className="file-category-more">{t('surface:files.countMoreFiles', { count: category.files.length - 5 })}</small> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {!loading && selectedCategory ? (
            <div className="file-category-detail">
              <div className="file-category-detail-title">
                <span className={`file-category-icon file-category-${selectedCategory.tone}`}>{SelectedCategoryIcon ? <SelectedCategoryIcon aria-hidden="true" strokeWidth={1.8} /> : null}</span>
                <div><h2>{t(selectedCategory.label)}</h2><span>{t('surface:files.countFiles', { count: selectedCategory.files.length })}</span></div>
              </div>
              <div className="data-table files-table">
                <div className="table-head"><span>{t('surface:files.name')}</span><span>{t('surface:files.size')}</span><span>{t('surface:files.status')}</span><span>{t('surface:files.imported')}</span><span className="files-actions-column">{t('surface:files.actions')}</span></div>
                {selectedCategory.files.map(({ file }) => (
                  <div key={file.id} className="table-row">
                    <span className="name-cell"><strong title={file.contentHash}>{file.sharedTitle}</strong><small>{file.originalName} · {file.sourceLabel}</small></span>
                    <span>{formatBytes(file.bytes)}</span>
                    <span className="status-cell"><span className={`status-dot${file.processingState === 'ready' ? ' active' : ''}`} />{file.processingState === 'ready' ? t('surface:files.parsed') : file.processingState === 'failed' ? t('surface:files.failed') : file.processingState === 'missing' ? '原件不可用' : '处理中'}</span>
                    <span>{formatDate(file.updatedAt, locale, t)}</span>
                    <span className="files-actions">
                      <button type="button" className="icon-button" aria-label={t('surface:files.previewName', { name: file.originalName })} title={t('surface:files.previewParsedOutput')} disabled={!file.parsed || busyId === file.id} onClick={() => void openPreview(file)}><Eye aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button" aria-label={t('surface:files.renameName', { name: file.originalName })} title={t('surface:files.rename')} disabled={busyId === file.id} onClick={() => renameFile(file)}><Pencil aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button" aria-label={t('surface:files.revealName', { name: file.originalName })} title={t('surface:files.showInFileManager')} disabled={busyId === file.id} onClick={() => void filesApi.reveal(file.id).catch(() => undefined)}><FolderOpen aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button danger" aria-label={t('surface:files.deleteName', { name: file.originalName })} title={t('surface:files.deleteAndRemovePipelineData')} disabled={busyId === file.id} onClick={() => deleteFile(file)}><Trash2 aria-hidden="true" strokeWidth={1.8} /></button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {view === 'events' && ingestApi ? (
        <div className="data-table files-table ingest-table">
          <div className="table-head"><span>{t('surface:files.title')}</span><span>{t('surface:files.type')}</span><span>{t('surface:files.pipeline')}</span><span>{t('surface:files.memory')}</span><span>{t('surface:files.time')}</span></div>
          {events.length === 0 ? <div className="source-files-empty">{t('surface:files.noImportHistoryYet')}</div> : null}
          {events.map((event) => (
            <div key={event.id} className="table-row">
              <span className="name-cell"><strong>{event.title}</strong><small>{event.sourceKind} · {event.sourceId.slice(0, 8)}</small></span>
              <span>{t(dataTypeLabel(event.dataType))}</span>
              <span className="pipeline-badges">
                {PIPELINE_KEYS.filter(({ key }) => event.pipelines[key]).map(({ key, label }) => (
                  <em key={key} className="pipeline-badge">{t(label)}</em>
                ))}
              </span>
              <span title={'error' in (event.memoryResult ?? {}) ? String((event.memoryResult as { error: string }).error) : undefined}>
                {describeMemory(event.memoryResult, t)}
              </span>
              <span>{formatDate(event.createdAt, locale, t)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {preview ? (
        <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setPreview(null)
        }}>
          <section className="evidence-dialog files-preview" role="dialog" aria-modal="true" aria-labelledby="files-preview-title">
            <header className="evidence-dialog-head">
              <div><span>{t('surface:files.parsedOutput')}</span><h2 id="files-preview-title">{preview.name}</h2><small>{t('surface:files.normalizedMarkdownTruncatedByConsumersAsNeeded')}</small></div>
              <button type="button" className="icon-button" title={t('surface:files.close')} aria-label={t('surface:files.close')} onClick={() => setPreview(null)}><X aria-hidden="true" strokeWidth={1.8} /></button>
            </header>
            <div className="evidence-dialog-body files-preview-body">
              {preview.error ? <div className="files-preview-error">{preview.error}</div> : null}
              {!preview.error && preview.markdown === null ? <div className="files-preview-error">{t('surface:files.loading')}</div> : null}
              {preview.markdown !== null ? <pre>{preview.markdown}</pre> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function FileTypeIcon({ file }: { file: FileCatalogDto }) {
  const extension = file.originalName.split('.').pop()?.toLowerCase()
  const Icon = extension === 'xlsx' || extension === 'xls' || extension === 'csv'
    ? FileSpreadsheet
    : extension === 'pdf'
      ? FileType2
      : FileTextIcon
  return <Icon className="file-type-icon" aria-hidden="true" strokeWidth={1.8} />
}

function describeMemory(memory: FileImportOutcome['memoryResult'], t: Translate): string {
  if (!memory) return '—'
  if ('error' in memory) return t('surface:files.failed')
  return memory.deduplicated ? t('surface:files.registeredDeduplicated') : t('surface:files.countChunks', { count: memory.chunkCount })
}
