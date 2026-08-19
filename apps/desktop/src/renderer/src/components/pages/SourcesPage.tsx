import { HardDrive, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import type {
  DataSourceSummary,
  EvidenceDocument,
  EvidenceSearchResult,
  MarkdownPreview,
  SourceFileSummary,
} from '../../../../shared/sources'
import { PageHeader } from './PageHeader'
import { ConnectSourceMenu, type ConnectorProviderId } from './sources/ConnectSourceMenu'
import { EvidenceSearch } from './sources/EvidenceSearch'
import { EvidenceViewer } from './sources/EvidenceViewer'
import { GitHubConnectDialog, type GitHubConnectionInput } from './sources/GitHubConnectDialog'
import { MarkdownSourceDialog } from './sources/MarkdownSourceDialog'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import { describeSync } from './sources/sourceFormatters'
import { SourceTable } from './sources/SourceTable'
import { ConnectorSection } from './ConnectorPage'
import { PRODUCT_NAME } from '@/components/ui/brand'

const EMPTY_GITHUB_FORM: GitHubConnectionInput = {
  repository: '',
  branch: '',
  token: '',
  syncIssues: true,
}

export function SourcesPage() {
  const api = window.nxcore?.sources
  const [sources, setSources] = useState<DataSourceSummary[]>([])
  const [loading, setLoading] = useState(Boolean(api))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
  const [filesBySource, setFilesBySource] = useState<Record<string, SourceFileSummary[]>>({})
  const [filesLoadingId, setFilesLoadingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<EvidenceSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [evidenceDocument, setEvidenceDocument] = useState<EvidenceDocument | null>(null)
  const [markdownPreview, setMarkdownPreview] = useState<{ sourceId: string; fileId: string; data: MarkdownPreview } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null)
  const [connectMenuOpen, setConnectMenuOpen] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const [githubForm, setGithubForm] = useState(EMPTY_GITHUB_FORM)
  const [markdownSource, setMarkdownSource] = useState<'google-docs' | 'notion' | null>(null)
  const [markdownForm, setMarkdownForm] = useState({ ids: '', token: '' })
  const [connectorsEnabled, setConnectorsEnabled] = useState(false)

  useEffect(() => {
    void window.nxcore?.connectors.status().then((status) => setConnectorsEnabled(status.enabled)).catch(() => undefined)
  }, [])

  const connectConnector = async (provider: ConnectorProviderId) => {
    setConnectMenuOpen(false)
    setMessage(null)
    try {
      await window.nxcore?.connectors.startAuthorization(provider)
      setMessage('已打开授权页面，完成后连接会自动出现在下方「连接器」列表。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法打开授权页面。')
    }
  }

  const loadSources = useCallback(async (): Promise<DataSourceSummary[] | null> => {
    if (!api) return null
    try {
      const nextSources = await api.list()
      const sourceIds = new Set(nextSources.map((source) => source.id))
      setSources(nextSources)
      setExpandedSourceId((current) => current && sourceIds.has(current) ? current : null)
      setFilesBySource((current) => Object.fromEntries(Object.entries(current).filter(([sourceId]) => sourceIds.has(sourceId))))
      return nextSources
    } catch {
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
      const nextError = loadError instanceof Error ? loadError.message : '无法读取文件清单。'
      if (nextError.includes('数据源不存在或已断开')) {
        setExpandedSourceId((current) => current === sourceId ? null : current)
        setFilesBySource((current) => {
          const next = { ...current }
          delete next[sourceId]
          return next
        })
      }
    } finally {
      if (showLoading) setFilesLoadingId(null)
    }
  }, [api])

  useEffect(() => {
    void loadSources()
    if (!api) return
    return api.onChanged((event) => {
      void loadSources().then((nextSources) => {
        if (event.filesChanged && expandedSourceId === event.sourceId && nextSources?.some((source) => source.id === event.sourceId)) {
          void loadFiles(event.sourceId, false)
        }
      })
    })
  }, [api, expandedSourceId, loadFiles, loadSources])

  useEffect(() => {
    if (expandedSourceId) void loadFiles(expandedSourceId)
  }, [expandedSourceId, loadFiles])

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setMessage(null)
    try {
      await action()
      const nextSources = await loadSources()
      if (expandedSourceId === id && nextSources?.some((source) => source.id === id)) await loadFiles(id)
    } catch {
    } finally {
      setBusyId(null)
    }
  }

  const addLocalFolder = async () => {
    if (!api) return setMessage(`网页版不读取本机文件夹。请在 ${PRODUCT_NAME} 桌面版中使用此功能。`)
    setBusyId('new')
    setMessage(null)
    try {
      const result = await api.addLocalFolder()
      if (result) {
        setMessage(describeSync(result))
        await loadSources()
      }
    } catch {
    } finally {
      setBusyId(null)
      setConnectMenuOpen(false)
    }
  }

  const addGitHub = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!api) return
    setBusyId('new')
    setMessage(null)
    try {
      const result = await api.addGitHub({
        repository: githubForm.repository,
        branch: githubForm.branch || undefined,
        token: githubForm.token || undefined,
        syncIssues: githubForm.syncIssues,
      })
      setGithubOpen(false)
      setConnectMenuOpen(false)
      setGithubForm((current) => ({ ...current, token: '' }))
      setMessage(describeSync(result))
      await loadSources()
    } catch {
    } finally {
      setBusyId(null)
    }
  }

  const addMarkdownSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!api || !markdownSource) return
    setBusyId('new'); setMessage(null)
    try {
      const ids = markdownForm.ids.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean)
      const result = markdownSource === 'google-docs'
        ? await api.addGoogleDocs({ documentIds: ids, token: markdownForm.token })
        : await api.addNotion({ pageIds: ids, token: markdownForm.token })
      setMarkdownSource(null); setMarkdownForm({ ids: '', token: '' }); setConnectMenuOpen(false); setMessage(describeSync(result)); await loadSources()
    } catch {
    } finally { setBusyId(null) }
  }

  const openEvidence = useCallback(async (sourceId: string, fileId: string, blockId: string | null = null) => {
    if (!api) return
    setActiveEvidenceId(blockId)
    try {
      setEvidenceDocument(await api.listEvidence(sourceId, fileId))
    } catch {
    }
  }, [api])

  useEffect(() => {
    if (!evidenceDocument || !['pending', 'running'].includes(evidenceDocument.status)) return
    const timer = window.setInterval(() => void openEvidence(evidenceDocument.sourceId, evidenceDocument.fileId, activeEvidenceId), 1_000)
    return () => window.clearInterval(timer)
  }, [activeEvidenceId, evidenceDocument, openEvidence])

  const searchEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!api) return
    const query = searchQuery.trim()
    if (!query) return setSearchResults(null)
    setSearching(true)
    try {
      setSearchResults(await api.searchEvidence(query))
    } catch {
    } finally {
      setSearching(false)
    }
  }

  const deleteSource = (source: DataSourceSummary) => {
    if (!api || !window.confirm(`要删除“${source.name}”吗？\n\n这会删除 ${PRODUCT_NAME} 保存的文件副本和版本记录，不会删除原文件。`)) return
    if (expandedSourceId === source.id) setExpandedSourceId(null)
    void runAction(source.id, () => api.disconnect(source.id, true))
  }

  const showFile = (sourceId: string, fileId: string) => {
    void api?.showFile(sourceId, fileId).catch(() => undefined)
  }

  const previewFile = async (sourceId: string, fileId: string) => {
    if (!api) return
    setPreviewError(null)
    try {
      setMarkdownPreview({ sourceId, fileId, data: await api.previewFile(sourceId, fileId) })
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '无法预览 Markdown。')
    }
  }

  return (
    <div className="page">
      <PageHeader title="数据源" description={`管理进入 ${PRODUCT_NAME} 的文件、应用和网页资料。`} action="连接数据源" actionDisabled={busyId === 'new'} onAction={() => setConnectMenuOpen((open) => !open)} />
      {api && connectMenuOpen ? <ConnectSourceMenu busy={busyId === 'new'} onLocalFolder={() => void addLocalFolder()} onGitHub={() => { setConnectMenuOpen(false); setGithubOpen(true) }} onGoogleDocs={() => { setConnectMenuOpen(false); setMarkdownSource('google-docs') }} onNotion={() => { setConnectMenuOpen(false); setMarkdownSource('notion') }} connectorsEnabled={connectorsEnabled} onConnectorProvider={(provider) => void connectConnector(provider)} /> : null}
      {!api ? <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>请在桌面版中连接本地文件夹</strong><span>网页版不会请求或读取本机文件权限。</span></div></div> : null}
      {message ? <div className="source-feedback" role="status">{message}</div> : null}
      {previewError ? <div className="source-feedback" role="alert">{previewError}</div> : null}
      {api && sources.length > 0 ? <EvidenceSearch query={searchQuery} results={searchResults} searching={searching} onQueryChange={setSearchQuery} onSearch={(event) => void searchEvidence(event)} onClear={() => { setSearchQuery(''); setSearchResults(null) }} onOpen={(result) => void openEvidence(result.sourceId, result.fileId, result.id)} /> : null}
      {api && !loading && sources.length === 0 ? <div className="sources-empty"><span className="sources-empty-icon"><HardDrive aria-hidden="true" strokeWidth={1.8} /></span><strong>还没有连接数据源</strong><p>连接一个数据源，{PRODUCT_NAME} 会保存受支持内容的版本与同步状态。</p><button type="button" className="primary-button" disabled={busyId === 'new'} onClick={() => void addLocalFolder()}><Plus aria-hidden="true" strokeWidth={1.8} />连接文件夹</button></div> : null}
      {api && (loading || sources.length > 0) ? <SourceTable sources={sources} loading={loading} busyId={busyId} expandedSourceId={expandedSourceId} filesBySource={filesBySource} filesLoadingId={filesLoadingId} onToggleFiles={(id) => setExpandedSourceId((current) => current === id ? null : id)} onSync={(source) => void runAction(source.id, async () => { const result = await api.sync(source.id); setMessage(describeSync(result)) })} onTogglePaused={(source) => void runAction(source.id, () => api.setPaused(source.id, source.status === 'connected'))} onDelete={deleteSource} onOpenEvidence={(sourceId, fileId) => void openEvidence(sourceId, fileId)} onPreviewFile={(sourceId, fileId) => void previewFile(sourceId, fileId)} onShowFile={showFile} /> : null}
      <div className="sources-connector-heading">
        <h2>连接器</h2>
      </div>
      <ConnectorSection />
      {evidenceDocument ? <EvidenceViewer evidence={evidenceDocument} activeBlockId={activeEvidenceId} onClose={() => { setEvidenceDocument(null); setActiveEvidenceId(null) }} onShowFile={() => showFile(evidenceDocument.sourceId, evidenceDocument.fileId)} /> : null}
      {markdownPreview ? <MarkdownPreviewDialog preview={markdownPreview.data} onClose={() => setMarkdownPreview(null)} onShowFile={() => showFile(markdownPreview.sourceId, markdownPreview.fileId)} /> : null}
      {githubOpen ? <GitHubConnectDialog values={githubForm} busy={busyId === 'new'} onChange={setGithubForm} onClose={() => setGithubOpen(false)} onSubmit={(event) => void addGitHub(event)} /> : null}
      {markdownSource ? <MarkdownSourceDialog kind={markdownSource} value={markdownForm} busy={busyId === 'new'} onChange={setMarkdownForm} onClose={() => setMarkdownSource(null)} onSubmit={(event) => void addMarkdownSource(event)} /> : null}
    </div>
  )
}
