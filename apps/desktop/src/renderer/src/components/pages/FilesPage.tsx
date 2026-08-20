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
      setEvents((await ingestApi.listEvents({ limit: 100 })).items)
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
      setMessage(`导入完成：${entered}/${result.length} 份进入链路。`)
      await Promise.all([loadFiles(), loadEvents(), loadFileEvents()])
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
        title="文档识别"
        description={`按识别类型整理 ${PRODUCT_NAME} 中的文件，点击类型卡片查看聚类清单。`}
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
        <section className="file-recognition" aria-labelledby="file-recognition-heading">
          <div className="file-recognition-toolbar">
            {selectedCategory ? (
              <button type="button" className="file-back-button" onClick={() => setSelectedCategoryKey(null)}>
                <ArrowLeft aria-hidden="true" strokeWidth={1.8} />
                <span>文档识别</span>
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

          {loading ? <div className="source-loading">正在读取文件清单...</div> : null}
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
                <div className="table-head"><span>名称</span><span>大小</span><span>状态</span><span>导入时间</span><span className="files-actions-column">操作</span></div>
                {selectedCategory.files.map(({ file }) => (
                  <div key={file.id} className="table-row">
                    <span className="name-cell"><strong title={file.contentHash}>{file.originalName}</strong></span>
                    <span>{formatBytes(file.bytes)}</span>
                    <span className="status-cell"><span className={`status-dot${file.parsed ? ' active' : ''}`} />{file.parsed ? '已解析' : '未进链路'}</span>
                    <span>{formatDate(file.createdAt)}</span>
                    <span className="files-actions">
                      <button type="button" className="icon-button" aria-label={`预览 ${file.originalName}`} title="预览解析产物" disabled={!file.parsed || busyId === file.id} onClick={() => void openPreview(file)}><Eye aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button" aria-label={`重命名 ${file.originalName}`} title="重命名" disabled={busyId === file.id} onClick={() => renameFile(file)}><Pencil aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button" aria-label={`定位 ${file.originalName}`} title="在文件管理器中显示" disabled={busyId === file.id} onClick={() => void filesApi.reveal(file.id).catch(() => undefined)}><FolderOpen aria-hidden="true" strokeWidth={1.8} /></button>
                      <button type="button" className="icon-button danger" aria-label={`删除 ${file.originalName}`} title="删除并清理链路数据" disabled={busyId === file.id} onClick={() => deleteFile(file)}><Trash2 aria-hidden="true" strokeWidth={1.8} /></button>
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

function FileTypeIcon({ file }: { file: FileDto }) {
  const extension = file.originalName.split('.').pop()?.toLowerCase()
  const Icon = extension === 'xlsx' || extension === 'xls' || extension === 'csv'
    ? FileSpreadsheet
    : extension === 'pdf'
      ? FileType2
      : FileTextIcon
  return <Icon className="file-type-icon" aria-hidden="true" strokeWidth={1.8} />
}

function describeMemory(memory: FileImportOutcome['memoryResult']): string {
  if (!memory) return '—'
  if ('error' in memory) return '失败'
  return memory.deduplicated ? '已登记（去重）' : `${memory.chunkCount} 块`
}
