import { ChevronDown, ChevronRight, File, FolderOpen, HardDrive, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'

import type { DataSourceSummary, SourceFileSummary } from '../../../../../shared/sources'
import { EVIDENCE_STATUS_LABELS, FILE_STATUS_LABELS, formatBytes, formatDate, SOURCE_STATUS_LABELS } from './sourceFormatters'

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
  onDelete,
  onOpenEvidence,
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
  onDelete: (source: DataSourceSummary) => void
  onOpenEvidence: (sourceId: string, fileId: string) => void
  onShowFile: (sourceId: string, fileId: string) => void
}) {
  return (
    <div className="data-table source-table">
      <div className="table-head"><span>名称</span><span>文件</span><span>状态</span><span>最近同步</span><span>操作</span></div>
      {loading ? <div className="source-loading">正在读取本地数据源...</div> : null}
      {sources.map((source) => {
        const busy = busyId === source.id || source.status === 'syncing'
        const files = filesBySource[source.id] ?? []
        const expanded = expandedSourceId === source.id
        return (
          <div key={source.id} className="source-record">
            <div className="table-row">
              <span className="name-cell">
                <button type="button" className="source-expand-button" aria-label={`${expanded ? '收起' : '查看'} ${source.name} 的文件清单`} aria-expanded={expanded} onClick={() => onToggleFiles(source.id)}>
                  {expanded ? <ChevronDown aria-hidden="true" strokeWidth={1.8} /> : <ChevronRight aria-hidden="true" strokeWidth={1.8} />}
                </button>
                <span className="item-icon"><HardDrive aria-hidden="true" strokeWidth={1.8} /></span>
                <span className="source-name-copy"><strong>{source.name}</strong><small title={source.rootPath}>{source.rootPath}</small></span>
              </span>
              <button type="button" className="source-count source-count-button" onClick={() => onToggleFiles(source.id)}>
                <strong>{source.fileCount}</strong><small>{formatBytes(source.totalBytes)} · {source.versionCount} 个版本</small>
              </button>
              <span className="status-cell" data-status={source.status} title={source.lastError ?? undefined}>
                <span className="status-dot active" />{SOURCE_STATUS_LABELS[source.status]}
              </span>
              <span>{formatDate(source.lastSyncedAt)}</span>
              <span className="source-actions">
                <button type="button" className="icon-button" aria-label={`重新扫描 ${source.name}`} title="重新扫描" disabled={busy || source.status === 'paused' || source.status === 'disconnected'} onClick={() => onSync(source)}>
                  <RefreshCw aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? `恢复 ${source.name}` : `暂停 ${source.name}`} title={source.status === 'disconnected' ? '重新连接' : source.status === 'paused' || source.status === 'error' ? '恢复同步' : '暂停同步'} disabled={busy} onClick={() => onTogglePaused(source)}>
                  {source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? <Play aria-hidden="true" strokeWidth={1.8} /> : <Pause aria-hidden="true" strokeWidth={1.8} />}
                </button>
                <button type="button" className="icon-button danger" aria-label={`删除 ${source.name}`} title="删除并清理本地副本" disabled={busy} onClick={() => onDelete(source)}>
                  <Trash2 aria-hidden="true" strokeWidth={1.8} />
                </button>
              </span>
            </div>
            {expanded ? (
              <div className="source-files-panel">
                <div className="source-files-head"><span>文件</span><span>变化</span><span>证据</span><span>修改时间</span><span>大小</span><span /></div>
                {filesLoadingId === source.id ? <div className="source-files-empty">正在读取文件清单...</div> : null}
                {filesLoadingId !== source.id && files.length === 0 ? <div className="source-files-empty">该文件夹中没有受支持的文件。</div> : null}
                {files.map((file) => (
                  <div key={file.id} className="source-file-row" data-status={file.status}>
                    <span className="source-file-name">
                      <File aria-hidden="true" strokeWidth={1.8} />
                      <span><strong>{file.name}</strong><small title={file.originalPath}>{file.previousRelativePath ? `${file.previousRelativePath} → ${file.relativePath}` : file.relativePath}</small></span>
                    </span>
                    <span className="file-status" title={`变化时间：${formatDate(file.changedAt)}`}>{FILE_STATUS_LABELS[file.status]}</span>
                    <button type="button" className="evidence-status" data-status={file.parseStatus} title={file.parseStatus === 'success' ? `${file.evidenceCount} 个证据段落` : EVIDENCE_STATUS_LABELS[file.parseStatus]} onClick={() => onOpenEvidence(source.id, file.id)}>
                      {file.parseStatus === 'success' ? `${file.evidenceCount} 段` : EVIDENCE_STATUS_LABELS[file.parseStatus]}
                    </button>
                    <span>{formatDate(file.modifiedAt)}</span><span>{formatBytes(file.size)}</span>
                    <button type="button" className="icon-button" aria-label={`打开 ${file.name} 的来源`} title={file.exists ? '打开来源' : '原始文件已不存在'} disabled={!file.exists} onClick={() => onShowFile(source.id, file.id)}>
                      <FolderOpen aria-hidden="true" strokeWidth={1.8} />
                    </button>
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
