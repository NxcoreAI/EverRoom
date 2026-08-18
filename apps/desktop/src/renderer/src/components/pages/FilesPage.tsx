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

type FilesView = 'files' | 'events'

interface FilePreview {
  fileId: string
  name: string
  markdown: string | null
  error: string | null
}

const PIPELINE_KEYS: { key: keyof IngestPipelines; label: string }[] = [
  { key: 'room', label: 'Room' },
  { key: 'wiki', label: 'Wiki' },
  { key: 'memory', label: '记忆' },
]

/** 展示用类型标签（策略本身在 gateway 代码注册表 + 部署期配置文件，桌面端只读展示）。 */
const DATA_TYPE_LABELS: Record<string, string> = {
  'document': '文档',
  'meeting-minutes': '会议纪要',
  'office-doc': 'Office 文档',
  'spreadsheet': '表格',
  'slides': '幻灯片',
  'html': '网页',
}

const dataTypeLabel = (key: string): string => DATA_TYPE_LABELS[key] ?? key

export function FilesPage() {
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
      setMessage(`导入完成：${entered}/${result.length} 份进入链路。`)
      await Promise.all([loadFiles(), loadEvents()])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败，请稍后重试。')
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
        error: error instanceof Error ? error.message : '无法读取解析产物。',
      })
    }
  }

  const renameFile = (file: FileDto) => {
    if (!filesApi) return
    const nextName = window.prompt('文件显示名称', file.originalName)
    if (nextName === null || !nextName.trim() || nextName.trim() === file.originalName) return
    void runFileAction(file.id, () => filesApi.rename(file.id, nextName.trim()))
  }

  const deleteFile = (file: FileDto) => {
    if (!filesApi) return
    if (!window.confirm(`要删除“${file.originalName}”吗？\n\n这会同时清理它进入的 Room 证据、wiki 链接与记忆文档。`)) return
    void runFileAction(file.id, () => filesApi.delete(file.id))
  }

  return (
    <div className="page">
      <PageHeader
        title="文件"
        description={`统一入口导入的文件与它们进入的理解链路（Room / Wiki / 记忆）。`}
        action="导入文件"
        actionDisabled={!filesApi || importing}
        onAction={() => void importFiles()}
        extraAction={
          <div className="segmented-control" aria-label="文件视图">
            <button type="button" data-active={String(view === 'files')} onClick={() => setView('files')}>文件</button>
            <button type="button" data-active={String(view === 'events')} onClick={() => { setView('events'); void loadEvents() }}>导入记录</button>
          </div>
        }
      />
      {!filesApi ? (
        <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>请在桌面版中导入文件</strong><span>网页版不会请求或读取本机文件权限。</span></div></div>
      ) : null}
      {message ? <div className="source-feedback" role="status">{message}</div> : null}

      {outcomes && outcomes.length > 0 ? (
        <div className="data-table files-outcomes">
          <div className="table-head"><span>本次导入</span><span>类型</span><span>链路</span><span>记忆</span><span /></div>
          {outcomes.map((outcome, index) => (
            <div key={`${outcome.filename}-${index}`} className="table-row files-outcome-row">
              <span className="name-cell"><strong>{outcome.filename}</strong></span>
              <span>{outcome.dataType ? dataTypeLabel(outcome.dataType) : '—'}</span>
              <span className="pipeline-badges">
                {outcome.error ? <em className="pipeline-badge pipeline-error" title={outcome.error}>失败</em> : null}
                {outcome.deduped ? <em className="pipeline-badge">已去重</em> : null}
                {outcome.pipelines
                  ? PIPELINE_KEYS.filter(({ key }) => outcome.pipelines?.[key]).map(({ key, label }) => (
                    <em key={key} className="pipeline-badge">{label}</em>
                  ))
                  : null}
              </span>
              <span title={outcome.memoryResult && 'error' in outcome.memoryResult ? outcome.memoryResult.error : undefined}>
                {describeMemory(outcome.memoryResult)}
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
          <div className="table-head"><span>名称</span><span>大小</span><span>状态</span><span>导入时间</span><span className="files-actions-column">操作</span></div>
          {loading ? <div className="source-loading">正在读取文件清单...</div> : null}
          {!loading && files.length === 0 ? <div className="source-files-empty">还没有导入文件。点击右上角“导入文件”开始。</div> : null}
          {files.map((file) => (
            <div key={file.id} className="table-row">
              <span className="name-cell"><strong title={file.contentHash}>{file.originalName}</strong></span>
              <span>{formatBytes(file.bytes)}</span>
              <span className="status-cell">
                <span className={`status-dot${file.parsed ? ' active' : ''}`} />
                {file.parsed ? '已解析' : '未进链路'}
              </span>
              <span>{formatDate(file.createdAt)}</span>
              <span className="files-actions">
                <button type="button" className="icon-button" aria-label={`预览 ${file.originalName}`} title="预览解析产物" disabled={!file.parsed || busyId === file.id} onClick={() => void openPreview(file)}>
                  <Eye aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={`重命名 ${file.originalName}`} title="重命名" disabled={busyId === file.id} onClick={() => renameFile(file)}>
                  <Pencil aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button" aria-label={`定位 ${file.originalName}`} title="在文件管理器中显示" disabled={busyId === file.id} onClick={() => void filesApi.reveal(file.id).catch(() => undefined)}>
                  <FolderOpen aria-hidden="true" strokeWidth={1.8} />
                </button>
                <button type="button" className="icon-button danger" aria-label={`删除 ${file.originalName}`} title="删除并清理链路数据" disabled={busyId === file.id} onClick={() => deleteFile(file)}>
                  <Trash2 aria-hidden="true" strokeWidth={1.8} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {view === 'events' && ingestApi ? (
        <div className="data-table files-table ingest-table">
          <div className="table-head"><span>标题</span><span>类型</span><span>链路</span><span>记忆</span><span>时间</span></div>
          {events.length === 0 ? <div className="source-files-empty">暂无导入记录。</div> : null}
          {events.map((event) => (
            <div key={event.id} className="table-row">
              <span className="name-cell"><strong>{event.title}</strong><small>{event.sourceKind} · {event.sourceId.slice(0, 8)}</small></span>
              <span>{dataTypeLabel(event.dataType)}</span>
              <span className="pipeline-badges">
                {PIPELINE_KEYS.filter(({ key }) => event.pipelines[key]).map(({ key, label }) => (
                  <em key={key} className="pipeline-badge">{label}</em>
                ))}
              </span>
              <span title={'error' in (event.memoryResult ?? {}) ? String((event.memoryResult as { error: string }).error) : undefined}>
                {describeMemory(event.memoryResult)}
              </span>
              <span>{formatDate(event.createdAt)}</span>
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
              <div><span>解析产物</span><h2 id="files-preview-title">{preview.name}</h2><small>归一化 markdown · 消费端按需截断展示</small></div>
              <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={() => setPreview(null)}><X aria-hidden="true" strokeWidth={1.8} /></button>
            </header>
            <div className="evidence-dialog-body files-preview-body">
              {preview.error ? <div className="files-preview-error">{preview.error}</div> : null}
              {!preview.error && preview.markdown === null ? <div className="files-preview-error">正在读取...</div> : null}
              {preview.markdown !== null ? <pre>{preview.markdown}</pre> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function describeMemory(memory: FileImportOutcome['memoryResult']): string {
  if (!memory) return '—'
  if ('error' in memory) return '失败'
  return memory.deduplicated ? '已登记（去重）' : `${memory.chunkCount} 块`
}
