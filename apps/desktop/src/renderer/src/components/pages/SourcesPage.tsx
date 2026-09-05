import { ArrowLeft, HardDrive } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  DataSourceSummary,
  EvidenceDocument,
  EvidenceSearchResult,
  MarkdownPreview,
  SourceChangeEvent,
  SourceFileSummary,
} from '../../../../shared/sources'
import type { ConnectorStatus, ConnectorConnection, SyncRun, SyncScope } from '@nxcore/connector-contract'
import type { ObsidianVaultBinding, ObsidianVaultCandidate } from '../../../../shared/obsidian'
import { ConnectGrid, type ConnectorProviderId } from './sources/ConnectGrid'
import { EvidenceSearch } from './sources/EvidenceSearch'
import { EvidenceViewer } from './sources/EvidenceViewer'
import { FilterPreferenceGuideDialog } from './sources/FilterPreferenceGuideDialog'
import { GitHubConnectDialog, type GitHubConnectionInput } from './sources/GitHubConnectDialog'
import { WebcalSubscriptionDialog } from './sources/WebcalSubscriptionDialog'
import { useConnectorProviders } from './sources/useConnectorProviders'
import { MarkdownSourceDialog } from './sources/MarkdownSourceDialog'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import { ObsidianImportDialog } from './sources/ObsidianImportDialog'
import { describeSync } from './sources/sourceFormatters'
import { CloudSourceCard, LocalSourceCard, ObsidianSourceCard } from './sources/SourceCard'
import { SourceDrawer, type DrawerTarget } from './sources/SourceDrawer'
import { IngestFeed } from './sources/IngestFeed'
import { SourceIcon } from './sources/SourceIcon'
import { PRODUCT_NAME } from '@/components/ui/brand'
import { useLocale } from '@/i18n/LocaleContext'
import './SourcesPage.css'

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
  const [githubOpen, setGithubOpen] = useState(false)
  const [webcalOpen, setWebcalOpen] = useState(false)
  const [webcalUrl, setWebcalUrl] = useState('')
  const [webcalError, setWebcalError] = useState<string | null>(null)
  const { providers: connectorProviders } = useConnectorProviders()
  const [githubForm, setGithubForm] = useState(EMPTY_GITHUB_FORM)
  const [markdownSource, setMarkdownSource] = useState<'google-docs' | 'notion' | null>(null)
  const [markdownForm, setMarkdownForm] = useState({ ids: '', token: '' })
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus | null>(null)
  const [cloudBusyId, setCloudBusyId] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null)
  // 二级页（页内下钻,不占全局导航）：最近进入全量 / 全部连接器。
  const [subPage, setSubPage] = useState<null | 'ingest' | 'connectors'>(null)
  const [obsidianImportOpen, setObsidianImportOpen] = useState(false)
  const obsidianDiscoveryRequestRef = useRef(0)
  const obsidianCandidateIdsRef = useRef(new Set<string>())
  const connectorsEnabled = connectorStatus?.enabled ?? false
  const connections = connectorStatus?.connections ?? []
  const scopes = connectorStatus?.scopes ?? []
  const runs = connectorStatus?.runs ?? []
  // 已连接的 provider 集合：待连接区隐藏这些条目（OAuth 单槽位,换账号从已连接卡片的「更换账号」进）
  const connectedProviders = new Set(connections.map((item) => item.provider))

  // 云服务卡与抽屉的数据源：页面级轮询。
  const refreshConnectorStatus = useCallback(async () => {
    try {
      setConnectorStatus(await window.nxcore?.nangoConnector.status() ?? null)
    } catch { /* 网关暂不可达时保留上一次状态 */ }
  }, [])
  useEffect(() => {
    const tick = () => { if (!document.hidden) void refreshConnectorStatus() }
    tick()
    const timer = window.setInterval(tick, 5_000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [refreshConnectorStatus])

  const importOpenClaw = async () => {
    setBusyId('migration-openclaw'); setMessage(null)
    try {
      const discovered = await window.nxcore!.migrations.discover()
      const run = discovered.length === 1
        ? await window.nxcore!.migrations.importOpenClaw(discovered[0]!.id)
        : await window.nxcore!.migrations.chooseOpenClaw()
      if (run) setMessage(t('surface:sources.migrationCompleted', { count: run.messagesCompleted }))
    } catch (error) { setMessage(error instanceof Error ? error.message : t('surface:sources.migrationFailed')) }
    finally { setBusyId(null) }
  }

  const importLocalAgentHistory = async (provider: 'codex' | 'claude') => {
    setBusyId(`migration-${provider}`); setMessage(null)
    try {
      const discovered = await window.nxcore!.migrations.localAgentSources(provider)
      const run = discovered.length
        ? await window.nxcore!.migrations.importLocalAgentMigration(provider, discovered[0]!.id)
        : await window.nxcore!.migrations.chooseLocalAgentDirectory(provider)
      if (run) setMessage(t('surface:sources.localAgentMigrationCompleted', { count: run.messagesCompleted }))
    } catch (error) { setMessage(error instanceof Error ? error.message : t('surface:sources.migrationFailed')) }
    finally { setBusyId(null) }
  }

  const importNotionZip = async () => {
    setBusyId('migration-notion'); setMessage(null)
    try { const run = await window.nxcore!.migrations.importNotionZip(); if (run) setMessage(t('surface:sources.notionMigrationCompleted', { count: run.pagesCompleted })) }
    catch (error) { setMessage(error instanceof Error ? error.message : t('surface:sources.migrationFailed')) }
    finally { setBusyId(null) }
  }

  const mountObsidian = async () => {
    setObsidianImportOpen(true)
  }

  useEffect(() => {
    const obsidian = window.nxcore?.obsidian
    if (!obsidian) return
    const refreshVaults = () => void obsidian.list().then(setVaults).catch(() => undefined)
    const refreshDiscovery = () => {
      const request = ++obsidianDiscoveryRequestRef.current
      void obsidian.discover().then((candidates) => {
        if (request !== obsidianDiscoveryRequestRef.current) return
        obsidianCandidateIdsRef.current = new Set(candidates.map((candidate) => candidate.id))
        setObsidianCandidates(candidates)
      }).catch(() => undefined)
    }
    const unsubscribeChanged = obsidian.onChanged(refreshVaults)
    const unsubscribeDiscovery = obsidian.onDiscoveryChanged(() => refreshDiscovery())
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

  // webcal 连接按地址建连、无账号概念；OAuth 连接单槽位——重授权会顶替同 provider 现有连接。
  const isWebcalConnection = (connection: ConnectorConnection) =>
    connectorProviders.find((item) => item.provider === connection.provider)?.authChannel === 'webcal-url'

  // 已连接卡片的「更换账号」：重新走一次授权,新账号自动顶替旧连接。
  const replaceAccountFor = (connection: ConnectorConnection) => {
    if (connectorsEnabled) void connectConnector(connection.provider)
  }

  // WebCal/ICS 订阅（webcal-url 通道）：无 OAuth，提交地址即建连（幂等）。
  const submitWebcalSubscription = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setWebcalError(null)
    setBusyId('new')
    try {
      await window.nxcore?.nangoConnector.createWebcalSubscription(webcalUrl)
      setWebcalOpen(false)
      setWebcalUrl('')
      // 连接与首同步由网关轮询/引导流程接管；本页无需额外刷新。
      setMessage(t('surface:webcalDialog.subscribed'))
    } catch (error) {
      setWebcalError(error instanceof Error ? error.message : t('surface:webcalDialog.subscribeFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const loadSources = useCallback(async (): Promise<DataSourceSummary[] | null> => {
    if (!api) return null
    try {
      const nextSources = await api.list()
      const sourceIds = new Set(nextSources.map((source) => source.id))
      setSources(nextSources)
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
        if (event.filesChanged && drawer?.type === 'local' && drawer.source.id === event.sourceId && nextSources?.some((source) => source.id === event.sourceId)) {
          void loadFiles(event.sourceId, false)
        }
      })
    })
  }, [api, drawer, loadFiles, loadSources])

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setMessage(null)
    try {
      await action()
      await loadSources()
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
      setMarkdownSource(null); setMarkdownForm({ ids: '', token: '' }); setMessage(describeSync(result, t)); await loadSources()
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

  // ── 云服务卡/抽屉操作（与引擎视图同源的 API,页面级入口）──
  const runCloudAction = async (id: string, action: () => Promise<unknown>) => {
    setCloudBusyId(id)
    setMessage(null)
    try {
      await action()
      await refreshConnectorStatus()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('surface:connector.operationFailed'))
    } finally {
      setCloudBusyId(null)
    }
  }
  const syncConnection = (connection: ConnectorConnection) => {
    const connectionScopes = scopes.filter((item) => item.connectionId === connection.id)
    void runCloudAction(connection.id, () => Promise.all(connectionScopes.map((scope) => window.nxcore!.nangoConnector.triggerSync(scope.id, 'incremental'))))
  }
  const toggleConnectionEnabled = (connection: ConnectorConnection) => {
    if (connection.status === 'active' && !window.confirm(t('surface:connector.disablingThisConnectionStopsAutomaticSyncContinue'))) return
    void runCloudAction(connection.id, () => connection.status === 'active'
      ? window.nxcore!.nangoConnector.disableConnection(connection.id)
      : window.nxcore!.nangoConnector.enableConnection(connection.id))
  }
  const purgeConnectionData = (connection: ConnectorConnection) => {
    if (!window.confirm(t('surface:connector.clearThisConnectorSLocalDataThisCannot'))) return
    void runCloudAction(connection.id, () => window.nxcore!.nangoConnector.purgeConnection(connection.id))
  }
  const syncScopeNow = (scope: SyncScope) => {
    void runCloudAction(scope.connectionId, () => window.nxcore!.nangoConnector.triggerSync(scope.id, scope.state === 'resync_required' ? 'rebuild' : 'incremental'))
  }

  // ── 详情抽屉 ──
  const drawerSource = drawer?.type === 'local' ? sources.find((source) => source.id === drawer.source.id) ?? null : null
  const drawerFiles = drawerSource ? filesBySource[drawerSource.id] ?? [] : []
  const drawerScopes = drawer?.type === 'cloud' ? scopes.filter((item) => item.connectionId === drawer.connection.id) : []
  const drawerScopeIds = new Set(drawerScopes.map((item) => item.id))
  const drawerRuns: SyncRun[] = drawer?.type === 'cloud' ? runs.filter((item) => drawerScopeIds.has(item.scopeId)) : []
  useEffect(() => {
    if (drawer?.type === 'local') void loadFiles(drawer.source.id)
  }, [drawer, loadFiles])
  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])
  useEffect(() => {
    if (!subPage) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSubPage(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subPage])
  useEffect(() => {
    if (drawer?.type === 'local' && !drawerSource) setDrawer(null)
    if (drawer?.type === 'cloud' && !connections.some((item) => item.id === drawer.connection.id)) setDrawer(null)
  }, [connections, drawer, drawerSource])

  // ── 脉搏行（全部由现有状态计算）──
  const obsidianPending = obsidianCandidates.filter((candidate) => !candidate.mountedVaultId)
  const hasObsidian = vaults.length + obsidianPending.length > 0
  const sourceCount = sources.length + (hasObsidian ? 1 : 0) + connections.length
  const attentionCount
    = sources.filter((source) => source.status === 'error' || source.status === 'disconnected').length
    + connections.filter((connection) => connection.status === 'error').length
    + (vaults.some((vault) => vault.status !== 'connected') ? 1 : 0)

  return (
    <div className="page src-page">
      {subPage ? (
        <header className="src-head">
          <div>
            <button type="button" className="src-back" onClick={() => setSubPage(null)}>
              <ArrowLeft aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.back')}
            </button>
            <h1>{t(subPage === 'ingest' ? 'surface:sources.recentIngest' : 'surface:sources.pendingConnect')}</h1>
          </div>
        </header>
      ) : (
        <header className="src-head">
          <div>
            <h1>{t('surface:sources.sources')}</h1>
            <p className="src-pulse">
              <span><i className="dot" aria-hidden="true" />&nbsp;{t('surface:sources.countSources', { count: sourceCount })}</span>
              {attentionCount > 0 ? (
                <>
                  <span className="sep" aria-hidden="true" />
                  <span><i className="dot danger" aria-hidden="true" />&nbsp;{t('surface:sources.countNeedsAttention', { count: attentionCount })}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="src-head-actions">
            {api && sources.length > 0 ? (
              <div className="src-search-wrap">
                <EvidenceSearch query={searchQuery} results={searchResults} searching={searching} onQueryChange={setSearchQuery} onSearch={(event) => void searchEvidence(event)} onClear={() => { setSearchQuery(''); setSearchResults(null) }} onOpen={(result) => void openEvidence(result.sourceId, result.fileId, result.id)} />
              </div>
            ) : null}
          </div>
        </header>
      )}
      {!api ? <div className="source-notice"><HardDrive aria-hidden="true" strokeWidth={1.8} /><div><strong>{t('surface:sources.connectLocalFoldersInTheDesktopApp')}</strong><span>{t('surface:sources.theWebVersionNeverRequestsOrReadsLocal')}</span></div></div> : null}
      {deletionProgress ? <div className="source-feedback source-delete-progress" role="status"><div className="source-delete-progress-copy"><strong>{deletionProgress.message}</strong><span className="source-delete-progress-track"><span style={{ width: `${deletionProgress.percent}%` }} /></span></div><b>{deletionProgress.percent}%</b></div> : message ? <div className="source-feedback" role="status">{message}</div> : null}
      {previewError ? <div className="source-feedback" role="alert">{previewError}</div> : null}
      {/* 二级页正文（主页分区在下方 {!subPage && …} 中整体让位） */}
      {subPage === 'ingest' ? (
        <section className="src-zone">
          <IngestFeed refreshKey={sources.length} limit={200} />
        </section>
      ) : null}
      {subPage === 'connectors' ? (
        <section className="src-zone">
          <ConnectGrid
            busy={Boolean(busyId)}
            connectedProviders={connectedProviders}
            onLocalFolder={() => void addLocalFolder()}
            onObsidian={() => void mountObsidian()}
            onGitHub={() => setGithubOpen(true)}
            onGoogleDocs={() => setMarkdownSource('google-docs')}
            onNotion={() => setMarkdownSource('notion')}
            onNotionZip={() => void importNotionZip()}
            onOpenClaw={() => void importOpenClaw()}
            onLocalAgentHistory={(provider) => void importLocalAgentHistory(provider)}
            connectorsEnabled={connectorsEnabled}
            onConnectorProvider={(provider) => void connectConnector(provider)}
            providers={connectorProviders}
            onWebcalSubscription={() => setWebcalOpen(true)}
          />
        </section>
      ) : null}
      {!subPage && api ? (
        <>
          <section className="src-zone">
            <header className="src-zone-head"><h2>{t('surface:sources.pendingConnect')}</h2></header>
            <ConnectGrid
              busy={Boolean(busyId)}
              limit={6}
              connectedProviders={connectedProviders}
              onViewAll={() => { setDrawer(null); setSubPage('connectors') }}
              onLocalFolder={() => void addLocalFolder()}
              onObsidian={() => void mountObsidian()}
              onGitHub={() => setGithubOpen(true)}
              onGoogleDocs={() => setMarkdownSource('google-docs')}
              onNotion={() => setMarkdownSource('notion')}
              onNotionZip={() => void importNotionZip()}
              onOpenClaw={() => void importOpenClaw()}
              onLocalAgentHistory={(provider) => void importLocalAgentHistory(provider)}
              connectorsEnabled={connectorsEnabled}
              onConnectorProvider={(provider) => void connectConnector(provider)}
              providers={connectorProviders}
              onWebcalSubscription={() => setWebcalOpen(true)}
            />
          </section>
          {loading ? <div className="src-feed-empty" role="status">{t('surface:sourceTable.loadingSources')}</div> : null}
          {!loading && (sources.length > 0 || hasObsidian || connections.length > 0) ? (
            <section className="src-zone">
              <header className="src-zone-head"><h2>{t('surface:sources.connectedSources')}</h2><small>{sources.length + (hasObsidian ? 1 : 0) + connections.length}</small></header>
              <div className="src-cards">
                {sources.map((source) => (
                  <LocalSourceCard key={source.id} source={source} busy={busyId === source.id} onOpen={() => setDrawer({ type: 'local', source })} onSync={() => void runAction(source.id, async () => { const result = await api.sync(source.id); setMessage(describeSync(result, t)) })} onTogglePaused={() => void runAction(source.id, () => api.setPaused(source.id, source.status === 'connected'))} onClear={() => clearSourceData(source)} />
                ))}
                {hasObsidian ? (
                  <ObsidianSourceCard vaults={vaults} candidates={obsidianCandidates} busy={busyId === 'obsidian'} onOpen={() => setDrawer({ type: 'obsidian' })} onRescan={() => void rescanObsidian()} />
                ) : null}
                {connections.map((connection) => {
                  const connectionScopes = scopes.filter((item) => item.connectionId === connection.id)
                  const connectionScopeIds = new Set(connectionScopes.map((item) => item.id))
                  return (
                    <CloudSourceCard key={connection.id} connection={connection} scopes={connectionScopes} runs={runs.filter((run) => connectionScopeIds.has(run.scopeId))} busy={cloudBusyId === connection.id} onOpen={() => setDrawer({ type: 'cloud', connection })} onSync={() => syncConnection(connection)} onToggleEnabled={() => toggleConnectionEnabled(connection)} onPurge={() => purgeConnectionData(connection)} onReplaceAccount={isWebcalConnection(connection) ? undefined : () => replaceAccountFor(connection)} />
                  )
                })}
              </div>
            </section>
          ) : null}
          <section className="src-zone">
            <header className="src-zone-head"><h2>{t('surface:sources.recentIngest')}</h2></header>
            <IngestFeed refreshKey={sources.length} onViewAll={() => { setDrawer(null); setSubPage('ingest') }} />
          </section>
        </>
      ) : null}
      {drawer ? (
        <SourceDrawer
          target={drawer}
          open
          files={drawerFiles}
          filesLoading={drawerSource != null && filesLoadingId === drawerSource.id}
          vaults={vaults}
          obsidianCandidates={obsidianCandidates}
          scopes={drawerScopes}
          runs={drawerRuns}
          busyId={drawer.type === 'cloud' ? cloudBusyId : drawerSource ? busyId : null}
          onClose={() => setDrawer(null)}
          onSync={() => { if (drawerSource && api) void runAction(drawerSource.id, async () => { const result = await api.sync(drawerSource.id); setMessage(describeSync(result, t)) }) }}
          onTogglePaused={() => { if (drawerSource && api) void runAction(drawerSource.id, () => api.setPaused(drawerSource.id, drawerSource.status === 'connected')) }}
          onClear={() => { if (drawerSource) clearSourceData(drawerSource) }}
          onOpenEvidence={(sourceId, fileId) => void openEvidence(sourceId, fileId)}
          onPreviewFile={(sourceId, fileId) => void previewFile(sourceId, fileId)}
          onShowFile={showFile}
          onRescanObsidian={() => void rescanObsidian()}
          onOpenVaultRoom={(vault) => window.dispatchEvent(new CustomEvent('nxcore:room:open', { detail: { id: vault.roomId, title: vault.name } }))}
          onDisconnectVault={(vault) => void disconnectVault(vault)}
          onImportObsidianCandidate={(candidate) => void importObsidianCandidate(candidate)}
          onScopeSync={(scope) => syncScopeNow(scope)}
          onToggleEnabled={(connection) => toggleConnectionEnabled(connection)}
          onPurge={(connection) => purgeConnectionData(connection)}
          onReplaceAccount={drawer.type === 'cloud' && !isWebcalConnection(drawer.connection) ? () => replaceAccountFor(drawer.connection) : undefined}
        />
      ) : null}
      {evidenceDocument ? <EvidenceViewer evidence={evidenceDocument} activeBlockId={activeEvidenceId} onClose={() => { setEvidenceDocument(null); setActiveEvidenceId(null) }} onShowFile={() => showFile(evidenceDocument.sourceId, evidenceDocument.fileId)} /> : null}
      {markdownPreview ? <MarkdownPreviewDialog preview={markdownPreview.data} onClose={() => setMarkdownPreview(null)} onShowFile={() => showFile(markdownPreview.sourceId, markdownPreview.fileId)} /> : null}
      {githubOpen ? <GitHubConnectDialog values={githubForm} busy={busyId === 'new'} onChange={setGithubForm} onClose={() => setGithubOpen(false)} onSubmit={(event) => void addGitHub(event)} /> : null}
      {webcalOpen ? <WebcalSubscriptionDialog url={webcalUrl} busy={busyId === 'new'} error={webcalError} onUrlChange={setWebcalUrl} onClose={() => setWebcalOpen(false)} onSubmit={(event) => void submitWebcalSubscription(event)} /> : null}
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
