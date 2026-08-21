import { HardDrive, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import type {
  DataSourceSummary,
  EvidenceDocument,
  EvidenceSearchResult,
  MarkdownPreview,
  SourceChangeEvent,
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
import { useLocale } from '@/i18n/LocaleContext'

const EMPTY_GITHUB_FORM: GitHubConnectionInput = {
  repository: '',
  branch: '',
  token: '',
  syncIssues: true,
}

type DeletionProgress = NonNullable<SourceChangeEvent['deletion']> & { sourceId: string }

export function SourcesPage() {
  const { t } = useLocale()
  const api = window.nxcore?.sources
  const [sources, setSources] = useState<DataSourceSummary[]>([])
  const [loading, setLoading] = useState(Boolean(api))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deletionProgress, setDeletionProgress] = useState<DeletionProgress | null>(null)
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
    void window.nxcore?.nangoConnector.status().then((status) => setConnectorsEnabled(status.enabled)).catch(() => undefined)
  }, [])

  // 授权确认由 gateway 在 status 轮询中完成（Nango 确认后自动注册连接），
  // 桌面端必须持续轮询 authorizationStatus 直到终态，否则连接永远不会登记。
  const [authorizationId, setAuthorizationId] = useState<string | null>(null)
  useEffect(() => {
    if (!authorizationId) return
    let active = true
    const check = async () => {
      try {
        const next = await window.nxcore!.nangoConnector.authorizationStatus(authorizationId)
        if (!active) return
        if (next.status === 'connected') { setAuthorizationId(null); setMessage(t('surface:sources.connectionCreatedSyncScopesAreBeingInitialized')) }
        else if (next.status !== 'pending') { setAuthorizationId(null); setMessage(next.error ?? t('surface:sources.authorizationWasNotCompleted')) }
      } catch { /* 网关暂不可达时继续等待 */ }
    }
    const timer = window.setInterval(() => void check(), 2_000)
    void check()
    return () => { active = false; window.clearInterval(timer) }
  }, [authorizationId, t])

  const connectConnector = async (provider: ConnectorProviderId) => {
    setConnectMenuOpen(false)
    setMessage(null)
    try {
      const attempt = await window.nxcore?.nangoConnector.startAuthorization(provider)
      if (attempt) {
        setAuthorizationId(attempt.id)
        setMessage(t('surface:sources.theAuthorizationPageIsOpenCompleteAuthorizationIn'))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:sources.failedToOpenTheAuthorizationPage'))
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
      const nextError = loadError instanceof Error ? loadError.message : t('surface:sources.failedToLoadTheFileList')
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
  }, [api, t])

  useEffect(() => {
    void loadSources()
    if (!api) return
    return api.onChanged((event) => {
      if (event.deletion) setDeletionProgress({ sourceId: event.sourceId, ...event.deletion })
      const terminalDeletion = event.deletion?.stage === 'completed' || event.deletion?.stage === 'failed'
      if (terminalDeletion) {
        setBusyId((current) => current === event.sourceId ? null : current)
        window.setTimeout(() => {
          setDeletionProgress((current) => current?.sourceId === event.sourceId ? null : current)
        }, event.deletion?.stage === 'completed' ? 1800 : 4000)
      }
      if (event.deletion && !terminalDeletion) return
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
    if (!api) return setMessage(t('surface:sources.theWebVersionCannotReadLocalFoldersUse', { product: PRODUCT_NAME }))
    setBusyId('new')
    setMessage(null)
    try {
      const result = await api.addLocalFolder()
      if (result) {
        setMessage(describeSync(result, t))
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
      setMessage(describeSync(result, t))
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
      setMarkdownSource(null); setMarkdownForm({ ids: '', token: '' }); setConnectMenuOpen(false); setMessage(describeSync(result, t)); await loadSources()
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

  const clearSourceData = (source: DataSourceSummary) => {
    if (!api || !window.confirm(t('surface:sources.clearNameThisRemovesFileCopiesAndKeepsFolder', { name: source.name, product: PRODUCT_NAME }))) return
    setBusyId(source.id)
    setFilesBySource((current) => {
      const next = { ...current }
      delete next[source.id]
      return next
    })
    if (expandedSourceId === source.id) setExpandedSourceId(null)
    setMessage(t('surface:sources.clearingFolderDocumentData'))
    void api.disconnect(source.id, true).catch((error) => {
      setBusyId(null)
      setMessage(error instanceof Error ? error.message : t('surface:sources.failedToClearSourceData'))
      void loadSources()
    })
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
      setPreviewError(error instanceof Error ? error.message : t('surface:sources.failedToPreviewMarkdown'))
    }
  }

  return (
    <div className="page">
      <PageHeader title={t('surface:sources.sources')} description={t('surface:sources.manageFilesAppsAndWebContentEnteringProduct', { product: PRODUCT_NAME })} action={t('surface:sources.connectSource')} actionDisabled={busyId === 'new'} onAction={() => setConnectMenuOpen((open) => !open)} />
      {api && connectMenuOpen ? <ConnectSourceMenu busy={busyId === 'new'} onLocalFolder={() => void addLocalFolder()} onGitHub={() => { setConnectMenuOpen(false); setGithubOpen(true) }} onGoogleDocs={() => { setConnectMenuOpen(false); setMarkdownSource('google-docs') }} onNotion={() => { setConnectMenuOpen(false); setMarkdownSource('notion') }} connectorsEnabled={connectorsEnabled} onConnectorProvider={(provider) => void connectConnector(provider)} /> : null}
      {!api ? <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>{t('surface:sources.connectLocalFoldersInTheDesktopApp')}</strong><span>{t('surface:sources.theWebVersionNeverRequestsOrReadsLocal')}</span></div></div> : null}
      {deletionProgress ? <div className="source-feedback source-delete-progress" role="status"><div className="source-delete-progress-copy"><strong>{deletionProgress.message}</strong><span className="source-delete-progress-track"><span style={{ width: `${deletionProgress.percent}%` }} /></span></div><b>{deletionProgress.percent}%</b></div> : message ? <div className="source-feedback" role="status">{message}</div> : null}
      {previewError ? <div className="source-feedback" role="alert">{previewError}</div> : null}
      {api && sources.length > 0 ? <EvidenceSearch query={searchQuery} results={searchResults} searching={searching} onQueryChange={setSearchQuery} onSearch={(event) => void searchEvidence(event)} onClear={() => { setSearchQuery(''); setSearchResults(null) }} onOpen={(result) => void openEvidence(result.sourceId, result.fileId, result.id)} /> : null}
      {api && !loading && sources.length === 0 ? <div className="sources-empty"><span className="sources-empty-icon"><HardDrive aria-hidden="true" strokeWidth={1.8} /></span><strong>{t('surface:sources.noSourcesConnectedYet')}</strong><p>{t('surface:sources.connectASourceAndProductWillTrackVersions', { product: PRODUCT_NAME })}</p><button type="button" className="primary-button" disabled={busyId === 'new'} onClick={() => void addLocalFolder()}><Plus aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.connectFolder')}</button></div> : null}
      {api && (loading || sources.length > 0) ? <SourceTable sources={sources} loading={loading} busyId={busyId} expandedSourceId={expandedSourceId} filesBySource={filesBySource} filesLoadingId={filesLoadingId} onToggleFiles={(id) => setExpandedSourceId((current) => current === id ? null : id)} onSync={(source) => void runAction(source.id, async () => { const result = await api.sync(source.id); setMessage(describeSync(result, t)) })} onTogglePaused={(source) => void runAction(source.id, () => api.setPaused(source.id, source.status === 'connected'))} onClear={clearSourceData} onOpenEvidence={(sourceId, fileId) => void openEvidence(sourceId, fileId)} onPreviewFile={(sourceId, fileId) => void previewFile(sourceId, fileId)} onShowFile={showFile} /> : null}
      <div className="sources-connector-heading">
        <h2>{t('surface:sources.connectors')}</h2>
      </div>
      <ConnectorSection />
      {evidenceDocument ? <EvidenceViewer evidence={evidenceDocument} activeBlockId={activeEvidenceId} onClose={() => { setEvidenceDocument(null); setActiveEvidenceId(null) }} onShowFile={() => showFile(evidenceDocument.sourceId, evidenceDocument.fileId)} /> : null}
      {markdownPreview ? <MarkdownPreviewDialog preview={markdownPreview.data} onClose={() => setMarkdownPreview(null)} onShowFile={() => showFile(markdownPreview.sourceId, markdownPreview.fileId)} /> : null}
      {githubOpen ? <GitHubConnectDialog values={githubForm} busy={busyId === 'new'} onChange={setGithubForm} onClose={() => setGithubOpen(false)} onSubmit={(event) => void addGitHub(event)} /> : null}
      {markdownSource ? <MarkdownSourceDialog kind={markdownSource} value={markdownForm} busy={busyId === 'new'} onChange={setMarkdownForm} onClose={() => setMarkdownSource(null)} onSubmit={(event) => void addMarkdownSource(event)} /> : null}
    </div>
  )
}
