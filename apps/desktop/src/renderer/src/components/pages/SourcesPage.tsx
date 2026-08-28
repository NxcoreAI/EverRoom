import { Ban, Bot, HardDrive, Plus, RefreshCw, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  DataSourceSummary,
  EvidenceDocument,
  EvidenceSearchResult,
  MarkdownPreview,
  SourceChangeEvent,
  SourceFileSummary,
} from '../../../../shared/sources'
import type { ObsidianVaultBinding, ObsidianVaultCandidate } from '../../../../shared/obsidian'
import type { MigrationRun, MigrationSource } from '@nxcore/agent-contract'
import { PageHeader } from './PageHeader'
import { ConnectSourceMenu, type ConnectorProviderId } from './sources/ConnectSourceMenu'
import { EvidenceSearch } from './sources/EvidenceSearch'
import { EvidenceViewer } from './sources/EvidenceViewer'
import { FilterPreferenceGuideDialog } from './sources/FilterPreferenceGuideDialog'
import { GitHubConnectDialog, type GitHubConnectionInput } from './sources/GitHubConnectDialog'
import { MarkdownSourceDialog } from './sources/MarkdownSourceDialog'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import { ObsidianImportDialog } from './sources/ObsidianImportDialog'
import { describeSync } from './sources/sourceFormatters'
import { SourceTable } from './sources/SourceTable'
import { SourceIcon } from './sources/SourceIcon'
import { ConnectorSection } from './ConnectorPage'
import { PRODUCT_NAME } from '@/components/ui/brand'
import { useLocale } from '@/i18n/LocaleContext'

const EMPTY_GITHUB_FORM: GitHubConnectionInput = {
  repository: '',
  branch: '',
  token: '',
  syncIssues: true,
}

/** 过滤偏好引导的"已引导过"记录（按 provider 类型，一生一次）。 */
const GUIDE_STORAGE_KEY = 'nxcore:filter-guide:guided'
function guidedProviders(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function markProviderGuided(provider: string): void {
  try {
    localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify([...guidedProviders(), provider]))
  } catch { /* 存储不可用时退化为每次都弹 */ }
}

type DeletionProgress = NonNullable<SourceChangeEvent['deletion']> & { sourceId: string }

export function SourcesPage() {
  const { t } = useLocale()
  const api = window.nxcore?.sources
  const [sources, setSources] = useState<DataSourceSummary[]>([])
  const [vaults, setVaults] = useState<ObsidianVaultBinding[]>([])
  const [obsidianCandidates, setObsidianCandidates] = useState<ObsidianVaultCandidate[]>([])
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
  const [migrationSources, setMigrationSources] = useState<MigrationSource[]>([])
  const [migrationRuns, setMigrationRuns] = useState<MigrationRun[]>([])
  const [obsidianImportOpen, setObsidianImportOpen] = useState(false)
  const [obsidianExpanded, setObsidianExpanded] = useState(false)
  const obsidianDiscoveryRequestRef = useRef(0)
  const obsidianCandidateIdsRef = useRef(new Set<string>())

  const refreshMigrations = useCallback(async () => {
    if (!window.nxcore?.migrations) return
    const [nextSources, nextRuns] = await Promise.all([window.nxcore.migrations.sources(), window.nxcore.migrations.runs()])
    setMigrationSources(nextSources); setMigrationRuns(nextRuns)
  }, [])

  useEffect(() => {
    void refreshMigrations().catch(() => undefined)
    return window.nxcore?.migrations.onProgress(({ run }) => {
      setMigrationRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
      void window.nxcore?.migrations.sources().then(setMigrationSources).catch(() => undefined)
    })
  }, [refreshMigrations])

  const importOpenClaw = async () => {
    setConnectMenuOpen(false); setBusyId('migration-openclaw'); setMessage(null)
    try {
      const discovered = await window.nxcore!.migrations.discover()
      const run = discovered.length === 1
        ? await window.nxcore!.migrations.importOpenClaw(discovered[0]!.id)
        : await window.nxcore!.migrations.chooseOpenClaw()
      if (run) setMessage(t('surface:sources.migrationCompleted', { count: run.messagesCompleted }))
      await refreshMigrations()
    } catch (error) { setMessage(error instanceof Error ? error.message : t('surface:sources.migrationFailed')) }
    finally { setBusyId(null) }
  }

  const importNotionZip = async () => {
    setConnectMenuOpen(false); setBusyId('migration-notion'); setMessage(null)
    try { const run = await window.nxcore!.migrations.importNotionZip(); if (run) setMessage(t('surface:sources.notionMigrationCompleted', { count: run.pagesCompleted })); await refreshMigrations() }
    catch (error) { setMessage(error instanceof Error ? error.message : t('surface:sources.migrationFailed')) }
    finally { setBusyId(null) }
  }

  const mountObsidian = async () => {
    setConnectMenuOpen(false)
    setObsidianImportOpen(true)
  }

  useEffect(() => {
    const obsidian = window.nxcore?.obsidian
    if (!obsidian) return
    const refreshVaults = () => void obsidian.list().then(setVaults).catch(() => undefined)
    const refreshDiscovery = (expandNewProjects = false) => {
      const request = ++obsidianDiscoveryRequestRef.current
      void obsidian.discover().then((candidates) => {
        if (request !== obsidianDiscoveryRequestRef.current) return
        const hasNewProject = candidates.some((candidate) => !candidate.mountedVaultId && !obsidianCandidateIdsRef.current.has(candidate.id))
        obsidianCandidateIdsRef.current = new Set(candidates.map((candidate) => candidate.id))
        setObsidianCandidates(candidates)
        if (expandNewProjects && hasNewProject) setObsidianExpanded(true)
      }).catch(() => undefined)
    }
    const unsubscribeChanged = obsidian.onChanged(refreshVaults)
    const unsubscribeDiscovery = obsidian.onDiscoveryChanged(() => refreshDiscovery(true))
    refreshVaults()
    refreshDiscovery()
    return () => {
      obsidianDiscoveryRequestRef.current += 1
      unsubscribeChanged()
      unsubscribeDiscovery()
    }
  }, [])

  const importObsidianCandidate = async (candidate: ObsidianVaultCandidate) => {
    const obsidian = window.nxcore?.obsidian
    if (!obsidian) return
    setBusyId(candidate.id)
    setMessage(null)
    try {
      const result = await obsidian.importCandidate(candidate.id, { kind: 'memory' })
      if (result.kind === 'memory') {
        setMessage(t('surface:obsidian.memoryImportComplete', { name: result.projectName, succeeded: result.succeeded, failed: result.failed }))
      }
      const [nextVaults, nextCandidates] = await Promise.all([obsidian.list(), obsidian.discover()])
      setVaults(nextVaults)
      obsidianCandidateIdsRef.current = new Set(nextCandidates.map((item) => item.id))
      setObsidianCandidates(nextCandidates)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:obsidian.importFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const disconnectVault = async (vault: ObsidianVaultBinding) => {
    if (!window.nxcore?.obsidian || !window.confirm(t('surface:sources.obsidianDisconnectConfirm', { name: vault.name }))) return
    setBusyId(vault.id)
    try {
      await window.nxcore.obsidian.disconnect(vault.id)
      setVaults((current) => current.filter((item) => item.id !== vault.id))
      const nextCandidates = await window.nxcore.obsidian.discover()
      obsidianCandidateIdsRef.current = new Set(nextCandidates.map((item) => item.id))
      setObsidianCandidates(nextCandidates)
      setMessage(t('surface:sources.obsidianDisconnected', { name: vault.name }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:sources.obsidianDisconnectFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const rescanObsidian = async () => {
    const obsidian = window.nxcore?.obsidian
    if (!obsidian) return
    setBusyId('obsidian')
    setMessage(null)
    try {
      await Promise.all(vaults.map((vault) => obsidian.rescan(vault.id)))
      const [nextVaults, nextCandidates] = await Promise.all([obsidian.list(), obsidian.discover()])
      setVaults(nextVaults)
      obsidianCandidateIdsRef.current = new Set(nextCandidates.map((item) => item.id))
      setObsidianCandidates(nextCandidates)
      setMessage(t('surface:sources.obsidianRescanned'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:sources.obsidianRescanFailed'))
    } finally {
      setBusyId(null)
    }
  }

  useEffect(() => {
    void window.nxcore?.nangoConnector.status().then((status) => setConnectorsEnabled(status.enabled)).catch(() => undefined)
  }, [])

  // 授权确认由 gateway 在 status 轮询中完成（Nango 确认后自动注册连接），
  // 桌面端必须持续轮询 authorizationStatus 直到终态，否则连接永远不会登记。
  const [authorizationId, setAuthorizationId] = useState<string | null>(null)
  const [guideProvider, setGuideProvider] = useState<string | null>(null)
  const guided = useRef(guidedProviders())
  // 引导关闭（偏好设置完成或跳过）→ 触发该 provider 连接的首同步。
  // gateway 对授权新建的连接暂缓了首同步（deferFirstSync），等的就是这一刻；
  // 手动触发失败不阻塞——轮询周期（默认 5 分钟）会兜底。
  const closeGuide = useCallback(() => {
    const provider = guideProvider
    setGuideProvider(null)
    if (!provider) return
    void window.nxcore?.nangoConnector.status().then((status) => {
      const connection = status.connections.find((item) => item.provider === provider)
      if (!connection || connection.status !== 'active') return
      const scopes = status.scopes.filter((item) => item.connectionId === connection.id)
      return Promise.all(scopes.map((scope) => window.nxcore!.nangoConnector.triggerSync(scope.id, 'full')))
    }).catch(() => undefined)
  }, [guideProvider])
  // connected 时若是该 provider 类型第一次连接——弹过滤偏好引导。
  // "第一次"以 localStorage 记录为准（不依赖"当前有没有该类连接"：用户可能
  // 在别的设备/早前连过，也可能授权期间切走页面错过了轮询瞬间）。
  const maybeGuide = useCallback((provider: string) => {
    if (!provider || guided.current.has(provider)) return
    guided.current.add(provider)
    markProviderGuided(provider)
    setGuideProvider(provider)
  }, [])
  useEffect(() => {
    if (!authorizationId) return
    let active = true
    const check = async () => {
      try {
        const next = await window.nxcore!.nangoConnector.authorizationStatus(authorizationId)
        if (!active) return
        if (next.status === 'connected') {
          setAuthorizationId(null)
          setMessage(t('surface:sources.connectionCreatedSyncScopesAreBeingInitialized'))
          void window.nxcore!.nangoConnector.status().then((status) => {
            const connection = status.connections.find((item) => item.provider === next.provider && item.status === 'active')
            return Promise.all(status.scopes.filter((scope) => scope.connectionId === connection?.id).map((scope) => window.nxcore!.nangoConnector.triggerSync(scope.id, 'full')))
          }).catch(() => undefined)
          maybeGuide(next.provider)
        }
        else if (next.status !== 'pending') { setAuthorizationId(null); setMessage(next.error ?? t('surface:sources.authorizationWasNotCompleted')) }
      } catch { /* 网关暂不可达时继续等待 */ }
    }
    const timer = window.setInterval(() => void check(), 2_000)
    void check()
    return () => { active = false; window.clearInterval(timer) }
  }, [authorizationId, maybeGuide, t])

  // 存量连接补引导：页面挂载时扫一遍已有连接，某 provider 类型已连接但从未
  // 引导过（旧版本连接的、或授权期间切走页面错过的）——补弹一次。
  useEffect(() => {
    void window.nxcore?.nangoConnector.status().then((status) => {
      if (!status.enabled) return
      for (const connection of status.connections) {
        if (guided.current.has(connection.provider)) continue
        maybeGuide(connection.provider)
        break // 一次只弹一个，下一个来源页挂载时再补
      }
    }).catch(() => undefined)
  }, [maybeGuide])

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
      <PageHeader title={t('surface:sources.sources')} action={t('surface:sources.connectSource')} actionDisabled={busyId === 'new'} onAction={() => setConnectMenuOpen((open) => !open)} />
      {api && connectMenuOpen ? <ConnectSourceMenu busy={Boolean(busyId)} onLocalFolder={() => void addLocalFolder()} onObsidian={() => void mountObsidian()} onGitHub={() => { setConnectMenuOpen(false); setGithubOpen(true) }} onGoogleDocs={() => { setConnectMenuOpen(false); setMarkdownSource('google-docs') }} onNotion={() => { setConnectMenuOpen(false); setMarkdownSource('notion') }} onNotionZip={() => void importNotionZip()} onOpenClaw={() => void importOpenClaw()} connectorsEnabled={connectorsEnabled} onConnectorProvider={(provider) => void connectConnector(provider)} /> : null}
      {!api ? <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>{t('surface:sources.connectLocalFoldersInTheDesktopApp')}</strong><span>{t('surface:sources.theWebVersionNeverRequestsOrReadsLocal')}</span></div></div> : null}
      {deletionProgress ? <div className="source-feedback source-delete-progress" role="status"><div className="source-delete-progress-copy"><strong>{deletionProgress.message}</strong><span className="source-delete-progress-track"><span style={{ width: `${deletionProgress.percent}%` }} /></span></div><b>{deletionProgress.percent}%</b></div> : message ? <div className="source-feedback" role="status">{message}</div> : null}
      {previewError ? <div className="source-feedback" role="alert">{previewError}</div> : null}
      {api && sources.length > 0 ? <EvidenceSearch query={searchQuery} results={searchResults} searching={searching} onQueryChange={setSearchQuery} onSearch={(event) => void searchEvidence(event)} onClear={() => { setSearchQuery(''); setSearchResults(null) }} onOpen={(result) => void openEvidence(result.sourceId, result.fileId, result.id)} /> : null}
      {api && !loading && sources.length === 0 && vaults.length === 0 && obsidianCandidates.length === 0 ? <div className="sources-empty"><span className="sources-empty-icon"><HardDrive aria-hidden="true" strokeWidth={1.8} /></span><strong>{t('surface:sources.noSourcesConnectedYet')}</strong><p>{t('surface:sources.connectASourceAndProductWillTrackVersions', { product: PRODUCT_NAME })}</p><button type="button" className="primary-button" disabled={busyId === 'new'} onClick={() => void addLocalFolder()}><Plus aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.connectFolder')}</button></div> : null}
      {api && (loading || sources.length > 0 || vaults.length > 0 || obsidianCandidates.length > 0) ? <SourceTable sources={sources} vaults={vaults} obsidianCandidates={obsidianCandidates} loading={loading} busyId={busyId} expandedSourceId={expandedSourceId} filesBySource={filesBySource} filesLoadingId={filesLoadingId} onToggleFiles={(id) => setExpandedSourceId((current) => current === id ? null : id)} onSync={(source) => void runAction(source.id, async () => { const result = await api.sync(source.id); setMessage(describeSync(result, t)) })} onTogglePaused={(source) => void runAction(source.id, () => api.setPaused(source.id, source.status === 'connected'))} onClear={clearSourceData} onOpenEvidence={(sourceId, fileId) => void openEvidence(sourceId, fileId)} onPreviewFile={(sourceId, fileId) => void previewFile(sourceId, fileId)} onShowFile={showFile} obsidianExpanded={obsidianExpanded} onToggleObsidian={() => setObsidianExpanded((current) => !current)} onRescanObsidian={() => void rescanObsidian()} onOpenVaultRoom={(vault) => window.dispatchEvent(new CustomEvent('nxcore:room:open', { detail: { id: vault.roomId, title: vault.name } }))} onDisconnectVault={(vault) => void disconnectVault(vault)} onImportObsidianCandidate={(candidate) => void importObsidianCandidate(candidate)} /> : null}
      <div className="sources-connector-heading migration-heading"><h2>{t('surface:sources.migrationRecords')}</h2><p>{t('surface:sources.notionAiChatUnavailable')}</p></div>
      {migrationSources.length ? <div className="data-table migration-table">
        <div className="table-head"><span>{t('surface:sourceTable.name')}</span><span>{t('surface:sources.importMethod')}</span><span>{t('surface:sourceTable.status')}</span><span>{t('surface:sources.importedContent')}</span><span>{t('surface:sourceTable.actions')}</span></div>
        {migrationSources.map((source) => { const run = migrationRuns.find((item) => item.sourceId === source.id); const busy = run?.status === 'running' || run?.status === 'queued'; return <div className="table-row" key={source.id}>
          <span className="name-cell"><span className="item-icon" data-source-kind={source.provider}>{source.provider === 'codex' || source.provider === 'claude' ? <Bot aria-hidden="true" /> : <SourceIcon kind={source.provider} />}</span><span className="source-name-copy"><strong>{source.displayName}</strong><small>{source.provider === 'claude' ? 'Claude Code' : source.provider === 'codex' ? 'Codex' : source.provider === 'openclaw' ? 'OpenClaw' : 'Notion'}</small></span></span>
          <span>{source.transport}</span><span className="status-cell" data-status={source.status}><span className={`status-dot ${source.status === 'completed' ? 'active' : ''}`} />{run?.phase ?? source.status}</span>
          <span className="migration-counts">{run ? <><strong>{source.provider === 'notion' ? run.pagesCompleted : run.threadsCompleted}</strong><small>{source.provider === 'notion' ? t('surface:sources.pages') : t('surface:sources.conversationsAndMessages', { count: run.messagesCompleted })}</small></> : '—'}</span>
          <span className="source-actions">{busy ? <button className="icon-button" title={t('surface:sources.cancelImport')} onClick={() => void window.nxcore!.migrations.cancel(run!.id)}><XCircle /></button> : <button className="icon-button" title={t('surface:sources.reimport')} onClick={() => void window.nxcore!.migrations.reimport(source.id).then(() => refreshMigrations())}><RefreshCw /></button>} {run?.status === 'failed' ? <button className="icon-button" title={t('surface:sources.retry')} onClick={() => void window.nxcore!.migrations.retry(run.id).then(() => refreshMigrations())}><RotateCcw /></button> : null}<button className="icon-button danger" title={t('surface:sources.clearLocalCopy')} onClick={() => { if (window.confirm(t('surface:sources.clearMigrationConfirm'))) void window.nxcore!.migrations.clear(source.id).then(() => refreshMigrations()) }}><Trash2 /></button></span>
          {run?.error ? <span className="migration-error"><Ban />{run.error}</span> : null}
        </div> })}
      </div> : <div className="migration-empty">{t('surface:sources.noMigrationRecords')}</div>}
      <div className="sources-connector-heading">
        <h2>{t('surface:sources.connectors')}</h2>
      </div>
      <ConnectorSection />
      {evidenceDocument ? <EvidenceViewer evidence={evidenceDocument} activeBlockId={activeEvidenceId} onClose={() => { setEvidenceDocument(null); setActiveEvidenceId(null) }} onShowFile={() => showFile(evidenceDocument.sourceId, evidenceDocument.fileId)} /> : null}
      {markdownPreview ? <MarkdownPreviewDialog preview={markdownPreview.data} onClose={() => setMarkdownPreview(null)} onShowFile={() => showFile(markdownPreview.sourceId, markdownPreview.fileId)} /> : null}
      {githubOpen ? <GitHubConnectDialog values={githubForm} busy={busyId === 'new'} onChange={setGithubForm} onClose={() => setGithubOpen(false)} onSubmit={(event) => void addGitHub(event)} /> : null}
      {markdownSource ? <MarkdownSourceDialog kind={markdownSource} value={markdownForm} busy={busyId === 'new'} onChange={setMarkdownForm} onClose={() => setMarkdownSource(null)} onSubmit={(event) => void addMarkdownSource(event)} /> : null}
      {guideProvider ? <FilterPreferenceGuideDialog provider={guideProvider} onClose={closeGuide} /> : null}
      {obsidianImportOpen ? <ObsidianImportDialog target={{ kind: 'memory' }} onClose={() => setObsidianImportOpen(false)} onImported={(result) => {
        if (result.kind !== 'memory') return
        setMessage(t('surface:obsidian.memoryImportComplete', { name: result.projectName, succeeded: result.succeeded, failed: result.failed }))
        const obsidian = window.nxcore?.obsidian
        if (!obsidian) return
        void Promise.all([obsidian.list(), obsidian.discover()]).then(([nextVaults, nextCandidates]) => {
          setVaults(nextVaults)
          obsidianCandidateIdsRef.current = new Set(nextCandidates.map((item) => item.id))
          setObsidianCandidates(nextCandidates)
        }).catch(() => undefined)
      }} /> : null}
    </div>
  )
}
