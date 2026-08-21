import { ArrowLeft, ChevronRight, Eye, FileSpreadsheet, FileText as FileTextIcon, FileType2, FolderOpen, HardDrive, Pencil, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  FileDto,
  FileImportOutcome,
  IngestEventDto,
  IngestPipelines,
} from '../../../../shared/ingest'
import { PageHeader } from './PageHeader'
import { categoryForFile, FILE_CATEGORY_DEFINITIONS } from './fileCategories'
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

export function FilesPage() {
  const { locale, t } = useLocale()
  const filesApi = window.nxcore?.files
  const ingestApi = window.nxcore?.ingest
  const [view, setView] = useState<FilesView>('files')
  const [files, setFiles] = useState<FileDto[]>([])
  const [loading, setLoading] = useState(Boolean(filesApi))
  const [events, setEvents] = useState<IngestEventDto[]>([])
  const [fileEvents, setFileEvents] = useState<IngestEventDto[]>([])
  const [outcomes, setOutcomes] = useState<FileImportOutcome[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const loadFiles = useCallback(async () => {
    if (!filesApi) return
    try {
      const result = await filesApi.list(200)
      setFiles(result.items)
    } catch {
    } finally {
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

  const loadFileEvents = useCallback(async () => {
    if (!ingestApi) return
    try {
      const firstPage = await ingestApi.listEvents({ limit: 200, offset: 0, sourceKind: 'file' })
      const pages = [firstPage.items]
      for (let offset = firstPage.items.length; offset < firstPage.total; offset += 200) {
        pages.push((await ingestApi.listEvents({ limit: 200, offset, sourceKind: 'file' })).items)
      }
      setFileEvents(pages.flat())
    } catch {
    }
  }, [ingestApi])

  useEffect(() => {
    void loadFiles()
    void loadEvents()
    void loadFileEvents()
  }, [loadEvents, loadFileEvents, loadFiles])

  const fileEventBySourceId = useMemo(() => {
    const result = new Map<string, IngestEventDto>()
    for (const event of fileEvents) {
      const current = result.get(event.sourceId)
      if (!current || event.sourceVersion >= current.sourceVersion) result.set(event.sourceId, event)
    }
    return result
  }, [fileEvents])

  const visibleFiles = useMemo(
    () => files.filter((file) => !file.originalName.toLowerCase().endsWith('.json')),
    [files],
  )

  const classifiedFiles = useMemo(() => visibleFiles.map((file) => {
    const event = fileEventBySourceId.get(file.id)
    return { file, event, category: categoryForFile(file, event) }
  }), [fileEventBySourceId, visibleFiles])

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const categoryCards = useMemo(() => FILE_CATEGORY_DEFINITIONS.map((definition) => ({
    ...definition,
    files: classifiedFiles.filter(({ file, event, category }) => {
      if (category.key !== definition.key) return false
      if (!normalizedSearch) return true
      return `${file.originalName} ${event?.title ?? ''}`.toLocaleLowerCase().includes(normalizedSearch)
    }),
  })).filter(({ files: categoryFiles }) => categoryFiles.length > 0), [classifiedFiles, normalizedSearch])

  const selectedCategory = selectedCategoryKey
    ? categoryCards.find((category) => category.key === selectedCategoryKey) ?? null
    : null
  const SelectedCategoryIcon = selectedCategory?.icon

  const importFiles = async () => {
    if (!filesApi || importing) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await filesApi.pickAndImport()
      if (result.length === 0) return
      setOutcomes(result)
      const entered = result.filter((outcome) => outcome.eventId).length
      setMessage(t('surface:files.importCompleteEnteredTotalFilesEnteredThePipeline', { entered, total: result.length }))
      await Promise.all([loadFiles(), loadEvents(), loadFileEvents()])
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

  const openPreview = async (file: FileDto) => {
    if (!filesApi) return
    setPreview({ fileId: file.id, name: file.originalName, markdown: null, error: null })
    try {
      const result = await filesApi.readMarkdown(file.id)
      setPreview({ fileId: file.id, name: file.originalName, markdown: result.markdown, error: null })
    } catch (error) {
      setPreview({
        fileId: file.id,
        name: file.originalName,
        markdown: null,
        error: error instanceof Error ? error.message : t('surface:files.unableToReadParsedOutput'),
      })
    }
  }

  const renameFile = (file: FileDto) => {
    if (!filesApi) return
    const nextName = window.prompt(t('surface:files.fileDisplayName'), file.originalName)
    if (nextName === null || !nextName.trim() || nextName.trim() === file.originalName) return
    void runFileAction(file.id, () => filesApi.rename(file.id, nextName.trim()))
  }

  const deleteFile = (file: FileDto) => {
    if (!filesApi) return
    if (!window.confirm(t('surface:files.deleteNameThisAlsoRemovesItsRoomEvidence', { name: file.originalName }))) return
    void runFileAction(file.id, () => filesApi.delete(file.id))
  }

  return (
    <div className="page">
      <PageHeader
        title="文档识别"
        description={`按识别类型整理 ${PRODUCT_NAME} 中的文件，点击类型卡片查看聚类清单。`}
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

      {outcomes && outcomes.length > 0 ? (
        <div className="data-table files-outcomes">
          <div className="table-head"><span>{t('surface:files.currentImport')}</span><span>{t('surface:files.type')}</span><span>{t('surface:files.pipeline')}</span><span>{t('surface:files.memory')}</span><span /></div>
          {outcomes.map((outcome, index) => (
            <div key={`${outcome.filename}-${index}`} className="table-row files-outcome-row">
              <span className="name-cell"><strong>{outcome.filename}</strong></span>
              <span>{outcome.dataType ? t(dataTypeLabel(outcome.dataType)) : '—'}</span>
              <span className="pipeline-badges">
                {outcome.error ? <em className="pipeline-badge pipeline-error" title={outcome.error}>{t('surface:files.failed')}</em> : null}
                {outcome.deduped ? <em className="pipeline-badge">{t('surface:files.deduplicated')}</em> : null}
                {outcome.pipelines
                  ? PIPELINE_KEYS.filter(({ key }) => outcome.pipelines?.[key]).map(({ key, label }) => (
                    <em key={key} className="pipeline-badge">{t(label)}</em>
                  ))
                  : null}
              </span>
              <span title={outcome.memoryResult && 'error' in outcome.memoryResult ? outcome.memoryResult.error : undefined}>
                {describeMemory(outcome.memoryResult, t)}
              </span>
              <span className="files-actions">
                {outcome.error ? <small className="files-error" title={outcome.error}>{outcome.error}</small> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view === 'files' && filesApi ? (
        <section className="file-recognition" aria-labelledby="file-recognition-heading">
          <div className="file-recognition-toolbar">
            {selectedCategory ? (
              <button type="button" className="file-back-button" onClick={() => setSelectedCategoryKey(null)}>
                <ArrowLeft aria-hidden="true" strokeWidth={1.8} />
                <span>{t('surface:files.files')}</span>
              </button>
            ) : (
              <h2 id="file-recognition-heading">文档识别（{categoryCards.length}）</h2>
            )}
            <div className="file-recognition-tools">
              {searchOpen ? (
                <input
                  autoFocus
                  type="search"
                  value={searchQuery}
                  placeholder="搜索文件"
                  aria-label="搜索文件"
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              ) : null}
              <button type="button" className="icon-button file-search-button" aria-label="搜索文件" title="搜索文件" onClick={() => setSearchOpen((open) => !open)}>
                <Search aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {loading ? <div className="source-loading">{t('surface:files.loadingFiles')}</div> : null}
          {!loading && !selectedCategory && categoryCards.length === 0 ? (
            <div className="file-recognition-empty">
              <span className="file-recognition-empty-icon"><FileTextIcon /></span>
              <strong>{searchQuery ? '没有匹配的文件' : '还没有可识别的文件'}</strong>
              <p>{searchQuery ? '换一个关键词试试。' : '点击右上角“导入文件”后，文件会按识别类型自动归类。'}</p>
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
                          <strong>{category.label}</strong>
                          <small>{category.files.length} 份文件</small>
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                    </span>
                    <span className="file-category-list">
                      {category.files.slice(0, 5).map(({ file }) => (
                        <span className="file-category-item" key={file.id}>
                          <FileTypeIcon file={file} />
                          <span title={file.originalName}>{file.originalName}</span>
                        </span>
                      ))}
                      {category.files.length > 5 ? <small className="file-category-more">+ {category.files.length - 5} 份</small> : null}
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
                <div><h2>{selectedCategory.label}</h2><span>{selectedCategory.files.length} 份文件</span></div>
              </div>
              <div className="data-table files-table">
                <div className="table-head"><span>{t('surface:files.name')}</span><span>{t('surface:files.size')}</span><span>{t('surface:files.status')}</span><span>{t('surface:files.imported')}</span><span className="files-actions-column">{t('surface:files.actions')}</span></div>
                {selectedCategory.files.map(({ file }) => (
                  <div key={file.id} className="table-row">
                    <span className="name-cell"><strong title={file.contentHash}>{file.originalName}</strong></span>
                    <span>{formatBytes(file.bytes)}</span>
                    <span className="status-cell"><span className={`status-dot${file.parsed ? ' active' : ''}`} />{t(file.parsed ? 'surface:files.parsed' : 'surface:files.notProcessed')}</span>
                    <span>{formatDate(file.createdAt, locale, t)}</span>
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

function FileTypeIcon({ file }: { file: FileDto }) {
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
