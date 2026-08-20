import { ChevronDown, ChevronRight, Eraser, Eye, File, FolderOpen, HardDrive, Pause, Play, RefreshCw } from 'lucide-react'

import type { DataSourceSummary, SourceFileSummary } from '../../../../../shared/sources'
import { EVIDENCE_STATUS_LABELS, FILE_STATUS_LABELS, formatBytes, formatDate, SOURCE_STATUS_LABELS } from './sourceFormatters'
import { useLocale } from '@/i18n/LocaleContext'

export function SourceTable({
  sources,
  loading,
  busyId,
  expandedSourceId,
  filesBySource,
  filesLoadingId,
  onToggleFiles,
  onSync,
  onTogglePaused,
  onClear,
  onOpenEvidence,
  onPreviewFile,
  onShowFile,
}: {
  sources: DataSourceSummary[]
  loading: boolean
  busyId: string | null
  expandedSourceId: string | null
  filesBySource: Record<string, SourceFileSummary[]>
  filesLoadingId: string | null
  onToggleFiles: (id: string) => void
  onSync: (source: DataSourceSummary) => void
  onTogglePaused: (source: DataSourceSummary) => void
  onClear: (source: DataSourceSummary) => void
  onOpenEvidence: (sourceId: string, fileId: string) => void
  onPreviewFile: (sourceId: string, fileId: string) => void
  onShowFile: (sourceId: string, fileId: string) => void
}) {
  const { locale, t } = useLocale()
  return (
    <div className="data-table source-table">
      <div className="table-head"><span>{t('surface:sourceTable.name')}</span><span>{t('surface:sourceTable.files')}</span><span>{t('surface:sourceTable.status')}</span><span>{t('surface:sourceTable.lastSynced')}</span><span>{t('surface:sourceTable.actions')}</span></div>
      {loading ? <div className="source-loading">{t('surface:sourceTable.loadingSources')}</div> : null}
      {sources.map((source) => {
        const busy = busyId === source.id || source.status === 'syncing'
        const files = filesBySource[source.id] ?? []
        const expanded = expandedSourceId === source.id
        return (
          <div key={source.id} className="source-record">
            <div className="table-row">
              <span className="name-cell">
                <button type="button" className="source-expand-button" aria-label={t(expanded ? 'surface:sourceTable.collapseFileList' : 'surface:sourceTable.viewFileList', { name: source.name })} aria-expanded={expanded} onClick={() => onToggleFiles(source.id)}>
                  {expanded ? <ChevronDown aria-hidden="true" strokeWidth={1.8} /> : <ChevronRight aria-hidden="true" strokeWidth={1.8} />}
                </button>
                <span className="item-icon"><HardDrive aria-hidden="true" strokeWidth={1.8} /></span>
                <span className="source-name-copy"><strong>{source.name}</strong><small title={source.rootPath}>{source.rootPath}</small></span>
              </span>
              <button type="button" className="source-count source-count-button" onClick={() => onToggleFiles(source.id)}>
                <strong>{source.fileCount}</strong><small>{formatBytes(source.totalBytes)} · {t('surface:sourceTable.countVersions', { count: source.versionCount })}</small>
              </button>
              <span className="status-cell" data-status={source.status} title={source.lastError ?? undefined}>
                <span className="status-dot active" />{t(SOURCE_STATUS_LABELS[source.status])}
              </span>
              <span>{formatDate(source.lastSyncedAt, locale, t)}</span>
              <span className="source-actions">
                <button type="button" className="icon-button" aria-label={t('surface:sourceTable.rescanName', { name: source.name })} title={t('surface:sourceTable.rescan')} disabled={busy || source.status === 'paused' || source.status === 'disconnected'} onClick={() => onSync(source)}>
                  <RefreshCw aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={t(source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? 'surface:sourceTable.resumeName' : 'surface:sourceTable.pauseName', { name: source.name })} title={t(source.status === 'disconnected' ? 'surface:sourceTable.reconnect' : source.status === 'paused' || source.status === 'error' ? 'surface:sourceTable.resumeSync' : 'surface:sourceTable.pauseSync')} disabled={busy} onClick={() => onTogglePaused(source)}>
                  {source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? <Play aria-hidden="true" strokeWidth={1.8} /> : <Pause aria-hidden="true" strokeWidth={1.8} />}
                </button>
                <button type="button" className="icon-button danger" aria-label={t('surface:sourceTable.clearDataName', { name: source.name })} title={t('surface:sourceTable.clearDataKeepFolder')} disabled={busyId === source.id} onClick={() => onClear(source)}>
                  <Eraser aria-hidden="true" strokeWidth={1.8} />
                </button>
              </span>
            </div>
            {expanded ? (
              <div className="source-files-panel">
                <div className="source-files-head"><span>{t('surface:sourceTable.files')}</span><span>{t('surface:sourceTable.change')}</span><span>{t('surface:sourceTable.evidence')}</span><span>{t('surface:sourceTable.modified')}</span><span>{t('surface:sourceTable.size')}</span><span /></div>
                {filesLoadingId === source.id ? <div className="source-files-empty">{t('surface:sourceTable.loadingFiles')}</div> : null}
                {filesLoadingId !== source.id && files.length === 0 ? <div className="source-files-empty">{t('surface:sourceTable.noSupportedFiles')}</div> : null}
                {files.map((file) => (
                  <div key={file.id} className="source-file-row" data-status={file.status}>
                    <span className="source-file-name">
                      <File aria-hidden="true" strokeWidth={1.8} />
                      <span><strong>{file.name}</strong><small title={file.originalPath}>{file.previousRelativePath ? `${file.previousRelativePath} → ${file.relativePath}` : file.relativePath}</small></span>
                    </span>
                    <span className="file-status" title={t('surface:sourceTable.changedAtTime', { time: formatDate(file.changedAt, locale, t) })}>{t(FILE_STATUS_LABELS[file.status])}</span>
                    <button type="button" className="evidence-status" data-status={file.parseStatus} title={file.parseStatus === 'success' ? t('surface:sourceTable.countEvidenceParagraphs', { count: file.evidenceCount }) : t(EVIDENCE_STATUS_LABELS[file.parseStatus])} onClick={() => onOpenEvidence(source.id, file.id)}>
                      {file.parseStatus === 'success' ? t('surface:sourceTable.countSegments', { count: file.evidenceCount }) : t(EVIDENCE_STATUS_LABELS[file.parseStatus])}
                    </button>
                    <span>{formatDate(file.modifiedAt, locale, t)}</span><span>{formatBytes(file.size)}</span>
                    <span className="source-file-actions">
                      {['.md', '.mdx', '.markdown'].includes(file.extension.toLowerCase()) ? <button type="button" className="icon-button" aria-label={t('surface:sourceTable.previewName', { name: file.name })} title={t('surface:sourceTable.previewMarkdown')} disabled={!file.exists} onClick={() => onPreviewFile(source.id, file.id)}><Eye aria-hidden="true" strokeWidth={1.8} /></button> : null}
                      <button type="button" className="icon-button" aria-label={t('surface:sourceTable.openSourceForName', { name: file.name })} title={t(file.exists ? 'surface:sourceTable.openSource' : 'surface:sourceTable.originalFileMissing')} disabled={!file.exists} onClick={() => onShowFile(source.id, file.id)}><FolderOpen aria-hidden="true" strokeWidth={1.8} /></button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
