import { Eye, FolderOpen, HardDrive, Pencil, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type {
  FileDto,
  FileImportOutcome,
  IngestEventDto,
  IngestPipelines,
} from '../../../../shared/ingest'
import { PageHeader } from './PageHeader'
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
  const [outcomes, setOutcomes] = useState<FileImportOutcome[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)

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
      setEvents((await ingestApi.listEvents({ limit: 100 })).items)
    } catch {
    }
  }, [ingestApi])

  useEffect(() => {
    void loadFiles()
    void loadEvents()
  }, [loadEvents, loadFiles])

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
      await Promise.all([loadFiles(), loadEvents()])
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
        title={t('surface:files.files')}
        description={t('surface:files.importFilesAndTrackHowTheyFlowInto')}
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
        <div className="data-table files-table">
          <div className="table-head"><span>{t('surface:files.name')}</span><span>{t('surface:files.size')}</span><span>{t('surface:files.status')}</span><span>{t('surface:files.imported')}</span><span className="files-actions-column">{t('surface:files.actions')}</span></div>
          {loading ? <div className="source-loading">{t('surface:files.loadingFiles')}</div> : null}
          {!loading && files.length === 0 ? <div className="source-files-empty">{t('surface:files.noFilesImportedYetSelectImportFilesTo')}</div> : null}
          {files.map((file) => (
            <div key={file.id} className="table-row">
              <span className="name-cell"><strong title={file.contentHash}>{file.originalName}</strong></span>
              <span>{formatBytes(file.bytes)}</span>
              <span className="status-cell">
                <span className={`status-dot${file.parsed ? ' active' : ''}`} />
                {t(file.parsed ? 'surface:files.parsed' : 'surface:files.notProcessed')}
              </span>
              <span>{formatDate(file.createdAt, locale, t)}</span>
              <span className="files-actions">
                <button type="button" className="icon-button" aria-label={t('surface:files.previewName', { name: file.originalName })} title={t('surface:files.previewParsedOutput')} disabled={!file.parsed || busyId === file.id} onClick={() => void openPreview(file)}>
                  <Eye aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={t('surface:files.renameName', { name: file.originalName })} title={t('surface:files.rename')} disabled={busyId === file.id} onClick={() => renameFile(file)}>
                  <Pencil aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={t('surface:files.revealName', { name: file.originalName })} title={t('surface:files.showInFileManager')} disabled={busyId === file.id} onClick={() => void filesApi.reveal(file.id).catch(() => undefined)}>
                  <FolderOpen aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button danger" aria-label={t('surface:files.deleteName', { name: file.originalName })} title={t('surface:files.deleteAndRemovePipelineData')} disabled={busyId === file.id} onClick={() => deleteFile(file)}>
                  <Trash2 aria-hidden="true" strokeWidth={1.8} />
                </button>
              </span>
            </div>
          ))}
        </div>
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

function describeMemory(memory: FileImportOutcome['memoryResult'], t: Translate): string {
  if (!memory) return '—'
  if ('error' in memory) return t('surface:files.failed')
  return memory.deduplicated ? t('surface:files.registeredDeduplicated') : t('surface:files.countChunks', { count: memory.chunkCount })
}
