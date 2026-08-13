import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileText,
  File,
  FolderOpen,
  HardDrive,
  ListChecks,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { PageId } from '@/data/navigation'
import type {
  DataSourceSummary,
  EvidenceDocument,
  EvidenceParseStatus,
  EvidenceSearchResult,
  SourceFileStatus,
  SourceFileSummary,
  SyncResult,
} from '../../../shared/sources'

function PageHeader({
  title,
  description,
  action,
  actionDisabled = false,
  onAction,
}: {
  title: string
  description: string
  action?: string
  actionDisabled?: boolean
  onAction?: () => void
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? (
        <button type="button" className="primary-button" disabled={actionDisabled} onClick={onAction}>
          <Plus aria-hidden="true" />
          {action}
        </button>
      ) : null}
    </header>
  )
}

function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [sourceCount, setSourceCount] = useState(0)

  useEffect(() => {
    let active = true
    void window.nexcore?.sources.list().then((sources) => {
      if (active) setSourceCount(sources.length)
    }).catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="page page-home">
      <header className="home-heading">
        <span>2026 年 8 月 11 日 · 上海</span>
        <h1>晚上好</h1>
        <p>继续最近的工作，或从新的上下文开始。</p>
      </header>

      <section className="home-band">
        <div className="section-heading">
          <h2>继续工作</h2>
          <button type="button" className="text-button" onClick={() => onNavigate('rooms')}>
            查看全部 <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="recent-grid">
          <button type="button" className="recent-item" onClick={() => onNavigate('rooms')}>
            <span className="item-icon"><BookOpen aria-hidden="true" /></span>
            <span className="recent-copy">
              <strong>极核开源 PC 版</strong>
              <small>Context Room · 12 分钟前</small>
            </span>
            <ArrowUpRight aria-hidden="true" />
          </button>
          <button type="button" className="recent-item" onClick={() => onNavigate('docs')}>
            <span className="item-icon"><FileText aria-hidden="true" /></span>
            <span className="recent-copy">
              <strong>开源版工程基线</strong>
              <small>Context Doc · 昨天</small>
            </span>
            <ArrowUpRight aria-hidden="true" />
          </button>
        </div>
      </section>

      <div className="home-columns">
        <section className="home-band">
          <div className="section-heading">
            <h2>今天</h2>
            <span className="quiet-label">3 项</span>
          </div>
          <div className="simple-list">
            {[
              ['确认开源版界面骨架', '进行中'],
              ['检查首批数据连接范围', '待处理'],
              ['审阅记忆治理规则', '待处理'],
            ].map(([title, status], index) => (
              <div key={title} className="simple-row">
                <span className={index === 0 ? 'status-dot active' : 'status-dot'} />
                <strong>{title}</strong>
                <small>{status}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="home-band">
          <div className="section-heading">
            <h2>系统状态</h2>
            <span className="status-ok"><Check aria-hidden="true" />正常</span>
          </div>
          <div className="metric-grid">
            <div><strong>{sourceCount}</strong><span>数据源</span></div>
            <div><strong>0</strong><span>记忆</span></div>
            <div><strong>0</strong><span>运行任务</span></div>
          </div>
        </section>
      </div>
    </div>
  )
}

function RoomsPage() {
  const rooms = [
    { title: '极核开源 PC 版', meta: '项目', updated: '12 分钟前', sources: 18, memories: 46 },
    { title: '连接器架构研究', meta: '议题', updated: '昨天', sources: 9, memories: 21 },
    { title: '个人上下文产品设计', meta: '长期目标', updated: '3 天前', sources: 27, memories: 61 },
  ]

  return (
    <div className="page">
      <PageHeader title="Context Room" description="围绕项目、人物或目标组织动态上下文。" action="新建 Room" />
      <div className="toolbar-row">
        <label className="search-field">
          <Search aria-hidden="true" />
          <input aria-label="搜索 Room" placeholder="搜索 Room" />
        </label>
        <div className="segmented-control" aria-label="Room 筛选">
          <button type="button" data-active="true">全部</button>
          <button type="button">项目</button>
          <button type="button">人物</button>
          <button type="button">目标</button>
        </div>
      </div>
      <div className="room-grid">
        {rooms.map((room, index) => (
          <article key={room.title} className="room-card">
            <div className="room-card-top">
              <span className="room-glyph" data-index={index}><BookOpen aria-hidden="true" /></span>
              <button type="button" className="icon-button" aria-label="更多操作"><MoreHorizontal aria-hidden="true" /></button>
            </div>
            <div className="room-meta"><span>{room.meta}</span><span>{room.updated}</span></div>
            <h2>{room.title}</h2>
            <p>恢复目标、进展、关键决策和待解决问题。</p>
            <div className="room-stats"><span>{room.sources} 个来源</span><span>{room.memories} 条记忆</span></div>
          </article>
        ))}
      </div>
    </div>
  )
}

function DocsPage() {
  return (
    <div className="page doc-page">
      <PageHeader title="文档" description="在原生写作空间中使用 Room、来源与 Agent。" action="新建文档" />
      <div className="doc-list">
        {[
          ['开源版工程基线', '极核开源 PC 版', '刚刚'],
          ['Context Room 产品说明', '个人上下文产品设计', '昨天'],
          ['连接器技术调研', '连接器架构研究', '8 月 9 日'],
        ].map(([title, room, time]) => (
          <button key={title} type="button" className="doc-row">
            <span className="item-icon"><FileText aria-hidden="true" /></span>
            <span><strong>{title}</strong><small>{room}</small></span>
            <time>{time}</time>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

const SOURCE_STATUS_LABELS: Record<DataSourceSummary['status'], string> = {
  connected: '已同步',
  syncing: '同步中',
  paused: '已暂停',
  disconnected: '已断开',
  error: '同步失败',
}

const FILE_STATUS_LABELS: Record<SourceFileStatus, string> = {
  added: '新增',
  updated: '已修改',
  renamed: '已重命名',
  moved: '已移动',
  restored: '已恢复',
  unchanged: '未变化',
  missing: '已删除',
  error: '读取失败',
}

const EVIDENCE_STATUS_LABELS: Record<EvidenceParseStatus, string> = {
  pending: '待解析',
  running: '解析中',
  success: '已解析',
  failed: '解析失败',
  unsupported: '暂不支持',
}

function formatDate(value: string | null): string {
  if (!value) return '尚未同步'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function describeSync(result: SyncResult): string {
  return `发现 ${result.discovered} 个文件，新增 ${result.added}，更新 ${result.updated}，移动 ${result.moved}，未变化 ${result.unchanged}。`
}

function EvidenceViewer({
  evidence,
  activeBlockId,
  onClose,
  onShowFile,
}: {
  evidence: EvidenceDocument
  activeBlockId: string | null
  onClose: () => void
  onShowFile: () => void
}) {
  useEffect(() => {
    if (!activeBlockId) return
    window.document.getElementById(`evidence-${activeBlockId}`)?.scrollIntoView({ block: 'center' })
  }, [activeBlockId, evidence.blocks])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="evidence-dialog-title">
        <header className="evidence-dialog-head">
          <div>
            <span>证据查看</span>
            <h2 id="evidence-dialog-title">{evidence.fileName}</h2>
            <small>{evidence.relativePath} · 当前版本 · {formatDate(evidence.modifiedAt)}</small>
          </div>
          <span className="evidence-dialog-actions">
            <button
              type="button"
              className="icon-button"
              title={evidence.exists ? '在 Finder 中显示' : '原始文件已不存在'}
              aria-label="在 Finder 中显示"
              disabled={!evidence.exists}
              onClick={onShowFile}
            >
              <FolderOpen aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" title="关闭" aria-label="关闭证据查看" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </span>
        </header>
        <div className="evidence-dialog-body">
          {evidence.status === 'pending' || evidence.status === 'running' ? (
            <div className="evidence-viewer-state"><RefreshCw aria-hidden="true" />正在解析当前版本...</div>
          ) : null}
          {evidence.status === 'unsupported' ? (
            <div className="evidence-viewer-state"><FileText aria-hidden="true" />该格式将在接入 Docling 后解析。</div>
          ) : null}
          {evidence.status === 'failed' ? (
            <div className="evidence-viewer-state error"><AlertCircle aria-hidden="true" />{evidence.error ?? '解析失败'}</div>
          ) : null}
          {evidence.status === 'success' && evidence.blocks.length === 0 ? (
            <div className="evidence-viewer-state">当前文档没有可提取的文本段落。</div>
          ) : null}
          {evidence.status === 'success' ? evidence.blocks.map((block) => (
            <article
              id={`evidence-${block.id}`}
              key={block.id}
              className="evidence-block"
              data-kind={block.kind}
              data-active={String(activeBlockId === block.id)}
            >
              <div className="evidence-block-location">
                <span>{block.pageNumber ? `第 ${block.pageNumber} 页` : block.startLine === block.endLine ? `第 ${block.startLine} 行` : `第 ${block.startLine}-${block.endLine} 行`}</span>
                {block.headingPath.length > 0 ? <small>{block.headingPath.join(' / ')}</small> : null}
              </div>
              {block.kind === 'heading' ? (
                <h3 data-level={block.headingLevel ?? 1}>{block.text}</h3>
              ) : (
                <p>{block.text}</p>
              )}
            </article>
          )) : null}
        </div>
      </section>
    </div>
  )
}

function SourcesPage() {
  const api = window.nexcore?.sources
  const [sources, setSources] = useState<DataSourceSummary[]>([])
  const [loading, setLoading] = useState(Boolean(api))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
  const [filesBySource, setFilesBySource] = useState<Record<string, SourceFileSummary[]>>({})
  const [filesLoadingId, setFilesLoadingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<EvidenceSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [evidenceDocument, setEvidenceDocument] = useState<EvidenceDocument | null>(null)
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null)

  const loadSources = useCallback(async (): Promise<DataSourceSummary[] | null> => {
    if (!api) return null
    try {
      const nextSources = await api.list()
      const sourceIds = new Set(nextSources.map((source) => source.id))
      setSources(nextSources)
      setExpandedSourceId((current) => current && sourceIds.has(current) ? current : null)
      setFilesBySource((current) => Object.fromEntries(
        Object.entries(current).filter(([sourceId]) => sourceIds.has(sourceId)),
      ))
      setError(null)
      return nextSources
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取数据源。')
      return null
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadFiles = useCallback(async (sourceId: string, showLoading = true) => {
    if (!api) return
    if (showLoading) setFilesLoadingId(sourceId)
    try {
      const files = await api.listFiles(sourceId)
      setFilesBySource((current) => ({ ...current, [sourceId]: files }))
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : '无法读取文件清单。'
      if (message.includes('数据源不存在或已断开')) {
        setExpandedSourceId((current) => current === sourceId ? null : current)
        setFilesBySource((current) => {
          const next = { ...current }
          delete next[sourceId]
          return next
        })
      } else {
        setError(message)
      }
    } finally {
      if (showLoading) setFilesLoadingId(null)
    }
  }, [api])

  useEffect(() => {
    void loadSources()
    if (!api) return
    return api.onChanged((event) => {
      if (!event.filesChanged) {
        void loadSources()
        return
      }
      void loadSources().then((nextSources) => {
        if (expandedSourceId === event.sourceId && nextSources?.some((source) => source.id === event.sourceId)) {
          void loadFiles(event.sourceId, false)
        }
      })
    })
  }, [api, expandedSourceId, loadFiles, loadSources])

  const toggleFiles = (sourceId: string) => {
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(null)
      return
    }
    setExpandedSourceId(sourceId)
  }

  useEffect(() => {
    if (!expandedSourceId) return
    void loadFiles(expandedSourceId)
  }, [expandedSourceId, loadFiles])

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setMessage(null)
    setError(null)
    try {
      await action()
      const nextSources = await loadSources()
      if (expandedSourceId === id && nextSources?.some((source) => source.id === id)) {
        await loadFiles(id)
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败，请重试。')
    } finally {
      setBusyId(null)
    }
  }

  const addLocalFolder = async () => {
    if (!api) {
      setMessage('网页版不读取本机文件夹。请在 NexCore 桌面版中使用此功能。')
      return
    }
    setBusyId('new')
    setMessage(null)
    setError(null)
    try {
      const result = await api.addLocalFolder()
      if (result) {
        setMessage(describeSync(result))
        await loadSources()
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : '无法连接该文件夹。')
    } finally {
      setBusyId(null)
    }
  }

  const disconnect = (source: DataSourceSummary, deleteLocalData: boolean) => {
    if (!api) return
    const detail = deleteLocalData
      ? '这会删除极核保存的文件副本和版本记录，不会删除原文件。'
      : '原文件不会受到影响，极核保存的来源、版本和对象副本将保留，可随时恢复。'
    if (!window.confirm(`要断开“${source.name}”吗？\n\n${detail}`)) return

    if (deleteLocalData && expandedSourceId === source.id) setExpandedSourceId(null)
    void runAction(source.id, () => api.disconnect(source.id, deleteLocalData))
  }

  const openEvidence = useCallback(async (
    sourceId: string,
    fileId: string,
    blockId: string | null = null,
  ) => {
    if (!api) return
    setActiveEvidenceId(blockId)
    try {
      setEvidenceDocument(await api.listEvidence(sourceId, fileId))
      setError(null)
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : '无法读取证据。')
    }
  }, [api])

  useEffect(() => {
    if (!evidenceDocument || !['pending', 'running'].includes(evidenceDocument.status)) return
    const timer = window.setInterval(() => {
      void openEvidence(evidenceDocument.sourceId, evidenceDocument.fileId, activeEvidenceId)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [activeEvidenceId, evidenceDocument, openEvidence])

  const searchEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!api) return
    const query = searchQuery.trim()
    if (!query) {
      setSearchResults(null)
      return
    }
    setSearching(true)
    setError(null)
    try {
      setSearchResults(await api.searchEvidence(query))
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '搜索失败，请重试。')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="数据源"
        description="管理进入极核的文件、应用和网页资料。"
        action="连接文件夹"
        actionDisabled={busyId === 'new'}
        onAction={() => void addLocalFolder()}
      />

      {!api ? (
        <div className="source-notice">
          <HardDrive aria-hidden="true" />
          <div><strong>请在桌面版中连接本地文件夹</strong><span>网页版不会请求或读取本机文件权限。</span></div>
        </div>
      ) : null}
      {message ? <div className="source-feedback" role="status">{message}</div> : null}
      {error ? <div className="source-feedback error" role="alert"><AlertCircle aria-hidden="true" />{error}</div> : null}

      {api && sources.length > 0 ? (
        <form className="evidence-search" role="search" onSubmit={(event) => void searchEvidence(event)}>
          <label>
            <Search aria-hidden="true" />
            <input
              value={searchQuery}
              aria-label="搜索证据内容"
              placeholder="搜索已解析的文档内容"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={searching || !searchQuery.trim()}>
            {searching ? '搜索中' : '搜索'}
          </button>
          {searchResults !== null ? (
            <button type="button" className="icon-button" title="清除搜索" aria-label="清除搜索" onClick={() => {
              setSearchQuery('')
              setSearchResults(null)
            }}><X aria-hidden="true" /></button>
          ) : null}
        </form>
      ) : null}

      {searchResults !== null ? (
        <section className="evidence-search-results" aria-label="证据搜索结果">
          <div className="evidence-results-head">
            <strong>{searchResults.length} 条结果</strong>
            <span>来自当前文件版本</span>
          </div>
          {searchResults.length === 0 ? <div className="evidence-results-empty">没有找到相关证据。</div> : null}
          {searchResults.map((result) => (
            <button
              type="button"
              key={result.id}
              className="evidence-result"
              onClick={() => void openEvidence(result.sourceId, result.fileId, result.id)}
            >
              <span className="evidence-result-source">
                <strong>{result.fileName}</strong>
                <small>{result.sourceName} · {result.startLine === result.endLine ? `第 ${result.startLine} 行` : `第 ${result.startLine}-${result.endLine} 行`}</small>
              </span>
              <span className="evidence-result-text">{result.text}</span>
              <ExternalLink aria-hidden="true" />
            </button>
          ))}
        </section>
      ) : null}

      {api && !loading && sources.length === 0 ? (
        <div className="sources-empty">
          <span className="sources-empty-icon"><HardDrive aria-hidden="true" /></span>
          <strong>还没有连接数据源</strong>
          <p>选择一个本地文件夹，极核会保存受支持文件的版本与同步状态。</p>
          <button type="button" className="primary-button" disabled={busyId === 'new'} onClick={() => void addLocalFolder()}>
            <Plus aria-hidden="true" />连接文件夹
          </button>
        </div>
      ) : null}

      {api && (loading || sources.length > 0) ? (
        <div className="data-table source-table">
          <div className="table-head"><span>名称</span><span>文件</span><span>状态</span><span>最近同步</span><span>操作</span></div>
          {loading ? <div className="source-loading">正在读取本地数据源...</div> : null}
          {sources.map((source) => {
            const busy = busyId === source.id || source.status === 'syncing'
            return (
              <div key={source.id} className="source-record">
                <div className="table-row">
                  <span className="name-cell">
                    <button
                      type="button"
                      className="source-expand-button"
                      aria-label={`${expandedSourceId === source.id ? '收起' : '查看'} ${source.name} 的文件清单`}
                      aria-expanded={expandedSourceId === source.id}
                      onClick={() => toggleFiles(source.id)}
                    >
                      {expandedSourceId === source.id ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </button>
                    <span className="item-icon"><HardDrive aria-hidden="true" /></span>
                    <span className="source-name-copy"><strong>{source.name}</strong><small title={source.rootPath}>{source.rootPath}</small></span>
                  </span>
                  <button type="button" className="source-count source-count-button" onClick={() => toggleFiles(source.id)}>
                    <strong>{source.fileCount}</strong><small>{formatBytes(source.totalBytes)} · {source.versionCount} 个版本</small>
                  </button>
                  <span className="status-cell" data-status={source.status} title={source.lastError ?? undefined}>
                    <span className="status-dot active" />{SOURCE_STATUS_LABELS[source.status]}
                  </span>
                  <span>{formatDate(source.lastSyncedAt)}</span>
                  <span className="source-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`重新扫描 ${source.name}`}
                      title="重新扫描"
                      disabled={busy || source.status === 'paused' || source.status === 'disconnected'}
                      onClick={() => void runAction(source.id, async () => {
                        const result = await api.sync(source.id)
                        setMessage(describeSync(result))
                      })}
                    ><RefreshCw aria-hidden="true" /></button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? `恢复 ${source.name}` : `暂停 ${source.name}`}
                      title={source.status === 'disconnected' ? '重新连接' : source.status === 'paused' || source.status === 'error' ? '恢复同步' : '暂停同步'}
                      disabled={busy}
                      onClick={() => void runAction(source.id, () => api.setPaused(source.id, source.status === 'connected'))}
                    >{source.status === 'paused' || source.status === 'disconnected' || source.status === 'error' ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`断开 ${source.name}`}
                      title="仅断开"
                      disabled={busy}
                      onClick={() => disconnect(source, false)}
                    ><Unplug aria-hidden="true" /></button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`断开并清理 ${source.name}`}
                      title="断开并清理本地副本"
                      disabled={busy}
                      onClick={() => disconnect(source, true)}
                    ><Trash2 aria-hidden="true" /></button>
                  </span>
                </div>
                {expandedSourceId === source.id ? (
                  <div className="source-files-panel">
                    <div className="source-files-head">
                      <span>文件</span><span>变化</span><span>证据</span><span>修改时间</span><span>大小</span><span />
                    </div>
                    {filesLoadingId === source.id ? <div className="source-files-empty">正在读取文件清单...</div> : null}
                    {filesLoadingId !== source.id && (filesBySource[source.id]?.length ?? 0) === 0 ? (
                      <div className="source-files-empty">该文件夹中没有受支持的文件。</div>
                    ) : null}
                    {filesBySource[source.id]?.map((file) => (
                      <div key={file.id} className="source-file-row" data-status={file.status}>
                        <span className="source-file-name">
                          <File aria-hidden="true" />
                          <span>
                            <strong>{file.name}</strong>
                            <small title={file.originalPath}>
                              {file.previousRelativePath
                                ? `${file.previousRelativePath} → ${file.relativePath}`
                                : file.relativePath}
                            </small>
                          </span>
                        </span>
                        <span className="file-status" title={`变化时间：${formatDate(file.changedAt)}`}>
                          {FILE_STATUS_LABELS[file.status]}
                        </span>
                        <button
                          type="button"
                          className="evidence-status"
                          data-status={file.parseStatus}
                          title={file.parseStatus === 'success' ? `${file.evidenceCount} 个证据段落` : EVIDENCE_STATUS_LABELS[file.parseStatus]}
                          onClick={() => void openEvidence(source.id, file.id)}
                        >{file.parseStatus === 'success' ? `${file.evidenceCount} 段` : EVIDENCE_STATUS_LABELS[file.parseStatus]}</button>
                        <span>{formatDate(file.modifiedAt)}</span>
                        <span>{formatBytes(file.size)}</span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`在 Finder 中显示 ${file.name}`}
                          title={file.exists ? '在 Finder 中显示' : '原始文件已不存在'}
                          disabled={!file.exists}
                          onClick={() => void api.showFile(source.id, file.id).catch((showError) => {
                            setError(showError instanceof Error ? showError.message : '无法定位原始文件。')
                          })}
                        ><FolderOpen aria-hidden="true" /></button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {evidenceDocument ? (
        <EvidenceViewer
          evidence={evidenceDocument}
          activeBlockId={activeEvidenceId}
          onClose={() => {
            setEvidenceDocument(null)
            setActiveEvidenceId(null)
          }}
          onShowFile={() => void api?.showFile(evidenceDocument.sourceId, evidenceDocument.fileId).catch((showError) => {
            setError(showError instanceof Error ? showError.message : '无法定位原始文件。')
          })}
        />
      ) : null}
    </div>
  )
}

function MemoryPage() {
  return (
    <div className="page">
      <PageHeader title="记忆" description="查看 AI 记住了什么，并决定哪些内容可以继续使用。" />
      <div className="memory-layout">
        <aside className="memory-filters">
          <button type="button" data-active="true">全部记忆 <span>128</span></button>
          <button type="button">已确认 <span>96</span></button>
          <button type="button">待确认 <span>24</span></button>
          <button type="button">冲突 <span>8</span></button>
        </aside>
        <section className="memory-feed">
          {[
            ['开源版首发平台只支持 macOS', '已确认', '来自产品 PRD · 2 个证据'],
            ['连接器优先于虚拟机能力', '已确认', '来自产品讨论 · 1 个证据'],
            ['用户偏好中性黑白灰界面', '待确认', '来自当前会话 · 1 个证据'],
          ].map(([title, status, source]) => (
            <article key={title} className="memory-row">
              <span className="memory-symbol"><Brain aria-hidden="true" /></span>
              <div><strong>{title}</strong><small>{source}</small></div>
              <span className="memory-status">{status}</span>
              <ChevronRight aria-hidden="true" />
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}

function TasksPage() {
  return (
    <div className="page">
      <PageHeader title="任务" description="查看 Agent 的执行范围、进度与产物。" action="新建任务" />
      <div className="task-board">
        {[
          ['进行中', '搭建前端样式框架', 'Nex', '当前'],
          ['待开始', '接入本地文件连接器', '未分配', 'P0'],
          ['已完成', '确定开源版工程边界', 'Codex', '今天'],
        ].map(([status, title, owner, time], index) => (
          <article key={title} className="task-row">
            <span className="task-state">{index === 0 ? <CircleDashed aria-hidden="true" /> : index === 2 ? <Check aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span>
            <div><strong>{title}</strong><small>{owner}</small></div>
            <span className="quiet-label">{status}</span>
            <time>{time}</time>
            <ChevronRight aria-hidden="true" />
          </article>
        ))}
      </div>
    </div>
  )
}

function SettingsPage() {
  return (
    <div className="page settings-page">
      <PageHeader title="设置" description="管理本地工作区、模型和数据边界。" />
      <div className="settings-list">
        {[
          [HardDrive, '本地数据', '数据目录、备份与保留策略'],
          [Brain, '模型与记忆', '模型供应商、Embedding 与记忆治理'],
          [ShieldCheck, '隐私与权限', '外发范围、审批和审计记录'],
          [Settings, '通用', '语言、启动行为与界面偏好'],
        ].map(([Icon, title, description]) => {
          const ItemIcon = Icon as typeof Settings
          return (
            <button key={String(title)} type="button" className="settings-row">
              <span className="item-icon"><ItemIcon aria-hidden="true" /></span>
              <span><strong>{String(title)}</strong><small>{String(description)}</small></span>
              <ChevronRight aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function PageCanvas({ page, onNavigate }: { page: PageId; onNavigate: (page: PageId) => void }) {
  if (page === 'home') return <HomePage onNavigate={onNavigate} />
  if (page === 'rooms') return <RoomsPage />
  if (page === 'docs') return <DocsPage />
  if (page === 'sources') return <SourcesPage />
  if (page === 'memory') return <MemoryPage />
  if (page === 'tasks') return <TasksPage />
  return <SettingsPage />
}
