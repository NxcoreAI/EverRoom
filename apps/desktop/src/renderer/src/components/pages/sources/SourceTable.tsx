import { ChevronDown, ChevronRight, Eraser, ExternalLink, Eye, File, FolderOpen, Pause, Play, RefreshCw, Unplug } from 'lucide-react'

import type { DataSourceSummary, SourceFileSummary } from '../../../../../shared/sources'
import type { ObsidianVaultBinding } from '../../../../../shared/obsidian'
import { EVIDENCE_STATUS_LABELS, FILE_STATUS_LABELS, formatBytes, formatDate, SOURCE_STATUS_LABELS } from './sourceFormatters'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from './SourceIcon'

export function SourceTable({
  sources,
  vaults,
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
  obsidianExpanded,
  onToggleObsidian,
  onRescanObsidian,
  onOpenVaultRoom,
  onDisconnectVault,
}: {
  sources: DataSourceSummary[]
  vaults: ObsidianVaultBinding[]
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
  obsidianExpanded: boolean
  onToggleObsidian: () => void
  onRescanObsidian: () => void
  onOpenVaultRoom: (vault: ObsidianVaultBinding) => void
  onDisconnectVault: (vault: ObsidianVaultBinding) => void
}) {
  const { locale, t } = useLocale()
  const obsidianBusy = busyId === 'obsidian'
  const obsidianFileCount = vaults.reduce((total, vault) => total + vault.noteCount + vault.attachmentCount, 0)
  const obsidianNoteCount = vaults.reduce((total, vault) => total + vault.noteCount, 0)
  const obsidianStatus = vaults.every((vault) => vault.status === 'connected') ? 'connected' : 'error'
  const obsidianUpdatedAt = vaults.reduce<string | null>((latest, vault) => !latest || vault.updatedAt > latest ? vault.updatedAt : latest, null)
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
                <span className="item-icon" data-source-kind={source.kind}><SourceIcon kind={source.kind} /></span>
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
      {vaults.length > 0 ? (
        <div className="source-record obsidian-source-record">
          <div className="table-row">
            <span className="name-cell">
              <button type="button" className="source-expand-button" aria-label={t(obsidianExpanded ? 'surface:sources.collapseObsidianProjects' : 'surface:sources.viewObsidianProjects')} aria-expanded={obsidianExpanded} onClick={onToggleObsidian}>
                {obsidianExpanded ? <ChevronDown aria-hidden="true" strokeWidth={1.8} /> : <ChevronRight aria-hidden="true" strokeWidth={1.8} />}
              </button>
              <span className="item-icon obsidian-source-icon"><SourceIcon kind="obsidian-vault" /></span>
              <span className="source-name-copy"><strong>Obsidian</strong><small>{t('surface:sources.obsidianWatchedProjects', { count: vaults.length })}</small></span>
            </span>
            <button type="button" className="source-count source-count-button" onClick={onToggleObsidian}>
              <strong>{obsidianFileCount}</strong><small>{t('surface:sources.obsidianNotesAndProjects', { notes: obsidianNoteCount, projects: vaults.length })}</small>
            </button>
            <span className="status-cell" data-status={obsidianStatus}><span className="status-dot active" />{t(obsidianStatus === 'connected' ? 'surface:sourceTable.synced' : 'surface:sources.partlyOffline')}</span>
            <span>{formatDate(obsidianUpdatedAt, locale, t)}</span>
            <span className="source-actions">
              <button type="button" className="icon-button" aria-label={t('surface:sources.rescanObsidian')} title={t('surface:sources.rescanObsidian')} disabled={obsidianBusy} onClick={onRescanObsidian}><RefreshCw className={obsidianBusy ? 'is-spinning' : undefined} aria-hidden="true" strokeWidth={1.8} /></button>
            </span>
          </div>
          {obsidianExpanded ? <div className="obsidian-projects-panel">
            <div className="obsidian-projects-head"><span>{t('surface:sources.obsidianProject')}</span><span>{t('surface:sourceTable.files')}</span><span>{t('surface:sourceTable.status')}</span><span>{t('surface:sources.destination')}</span><span /></div>
            {vaults.map((vault) => <div className="obsidian-project-row" key={vault.id}>
              <span className="obsidian-project-name"><SourceIcon kind="obsidian-vault" /><strong>{vault.name}</strong></span>
              <span>{vault.noteCount + vault.attachmentCount}<small>{t('surface:sources.obsidianCount', { attachments: vault.attachmentCount })}</small></span>
              <span className="status-cell" data-status={vault.status === 'connected' ? 'connected' : 'error'}><span className="status-dot active" />{t(vault.status === 'connected' ? 'surface:obsidian.connected' : 'surface:obsidian.offline')}</span>
              <span>{t(vault.mountMode === 'memory' ? 'surface:sources.obsidianMemory' : vault.mountMode === 'embedded' ? 'surface:sources.obsidianRoomPart' : 'surface:sources.obsidianProjectRoom')}</span>
              <span className="source-actions">
                {vault.mountMode !== 'memory' ? <button type="button" className="icon-button" aria-label={t('surface:sources.openRoom')} title={t('surface:sources.openRoom')} onClick={() => onOpenVaultRoom(vault)}><ExternalLink aria-hidden="true" strokeWidth={1.8} /></button> : null}
                <button type="button" className="icon-button danger" aria-label={t('surface:obsidian.disconnect')} title={t('surface:obsidian.disconnect')} disabled={busyId === vault.id} onClick={() => onDisconnectVault(vault)}><Unplug aria-hidden="true" strokeWidth={1.8} /></button>
              </span>
            </div>)}
          </div> : null}
        </div>
      ) : null}
    </div>
  )
}
