import { ArrowUpRight, BookOpen, Bot, Boxes, FileDown, FileText, Files, FolderOpen, Info, LoaderCircle, PlugZap, RefreshCw, Search, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  DocumentImportBatchItemView,
  DocumentImportBatchView,
  ExternalDocumentListItem,
  ExternalDocumentProvider,
} from '@nxcore/agent-contract'
import type { KnowledgeRoomDto } from '../../../../shared/knowledge'
import type { OpenConnectorConnectionSummary } from '../../../../shared/open-connector'
import { SourceIcon } from './sources/SourceIcon'
import { showToast } from '../../state/toast'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
// 面板样式随组件自带：数据源页抽屉等场景不会加载 ConnectorSyncPage 模块。
import './ConnectorSyncPage.css'

/**
 * 连接器页"文档导入"面板：按连接全量列出飞书/Notion 文档 → 批量勾选 →
 * 「导入到 Room」走批量 commitToRoom；「AI 自动归类」走归房+孵化混合
 * （高置信进 Room，无匹配进待处理晋升队列）。批量为异步批，轮询进度可取消。
 */

const BATCH_POLL_MS = 2_000

function formatTime(value: string | null, locale: AppLocale): string {
  return value ? new Date(value).toLocaleDateString(locale) : ''
}

function batchItemStatusKey(status: string, t: Translate): string {
  return t({
    pending: 'surface:connectorSync.batchItemPending',
    imported: 'surface:connectorSync.batchItemImported',
    incubated: 'surface:connectorSync.batchItemIncubated',
    failed: 'surface:connectorSync.batchItemFailed',
    skipped: 'surface:connectorSync.batchItemSkipped',
  }[status as 'pending' | 'imported' | 'incubated' | 'failed' | 'skipped'] ?? 'surface:connectorSync.batchItemPending')
}

export function ConnectorDocumentImportPanel({
  connections: providedConnections,
  provider: lockedProvider,
  connectionName: lockedConnectionName,
  embedded = false,
}: {
  /** 连接器页传入已加载的连接清单；数据源页等上下文不传时面板自拉（cliConnector apps）。 */
  connections?: OpenConnectorConnectionSummary[]
  /** 数据源页按平台分入口传入：锁定 provider 并隐藏平台切换。 */
  provider?: ExternalDocumentProvider
  /** 抽屉等单连接场景传入：锁定连接名并隐藏连接选择。 */
  connectionName?: string
  /** 嵌入模式（抽屉内）：隐藏区块标题，只保留工具栏/列表/操作条。 */
  embedded?: boolean
}) {
  const { locale, t } = useLocale()
  const external = window.nxcore?.externalDocuments

  const [ownConnections, setOwnConnections] = useState<OpenConnectorConnectionSummary[]>([])
  const connections = useMemo(
    () => (providedConnections ?? ownConnections).filter((item) => item.service === 'feishu' || item.service === 'notion'),
    [providedConnections, ownConnections],
  )
  const [authorizing, setAuthorizing] = useState(false)
  const loadConnections = useCallback(() => {
    if (!window.nxcore) return
    void window.nxcore.cliConnector
      .execute({ requestId: crypto.randomUUID(), command: { kind: 'apps' } })
      .then((result) => {
        setOwnConnections(Array.isArray(result.data) ? result.data as OpenConnectorConnectionSummary[] : [])
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (providedConnections !== undefined) return
    loadConnections()
  }, [providedConnections, loadConnections])

  const [provider, setProvider] = useState<ExternalDocumentProvider>(lockedProvider ?? 'feishu')
  const providerOptions = useMemo(() => {
    const services = new Set(connections.map((item) => item.service as ExternalDocumentProvider))
    if (services.size === 0) {
      services.add('feishu')
      services.add('notion')
    }
    return [...services]
  }, [connections])
  const [connectionName, setConnectionName] = useState(lockedConnectionName ?? '')
  const activeConnections = useMemo(
    () => connections.filter((item) => item.service === provider),
    [connections, provider],
  )
  useEffect(() => {
    // provider 切换后默认连接：isDefault 优先，其次唯一连接；多连接留空（后端报多连接错误会 toast）。
    if (lockedConnectionName !== undefined) return
    const preferred = activeConnections.find((item) => item.isDefault) ?? (activeConnections.length === 1 ? activeConnections[0] : undefined)
    setConnectionName(preferred?.connectionName ?? '')
  }, [activeConnections, lockedConnectionName])

  const [items, setItems] = useState<ExternalDocumentListItem[]>([])
  const [truncated, setTruncated] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /** 聚合批次视图：一次导入动作可能拆多批（单批上限 50），跨批聚合进度与明细。 */
  const [run, setRun] = useState<{
    status: 'running' | 'completed' | 'cancelled'
    total: number
    processed: number
    imported: number
    incubated: number
    failed: number
    skipped: number
    items: DocumentImportBatchItemView[]
  } | null>(null)
  const [autoDisabled, setAutoDisabled] = useState(false)
  /** 批次发起中的即时反馈（IPC 往返期间按钮防重入，避免"点了没反应"的观感）。 */
  const [batchStarting, setBatchStarting] = useState(false)
  /** 发起失败的常驻错误（toast 只显示 3.2s，易被错过后只剩静默禁用的按钮）。 */
  const [startError, setStartError] = useState<string | null>(null)
  const [roomPickerOpen, setRoomPickerOpen] = useState(false)
  /** 已导入冲突确认：选了 Room 且勾选中存在已导入文档时进入。 */
  const [conflict, setConflict] = useState<{ roomId: string; roomTitle: string; existingRemoteIds: Set<string> } | null>(null)
  const [conflictChecking, setConflictChecking] = useState(false)
  const [rooms, setRooms] = useState<KnowledgeRoomDto[]>([])
  const [roomsLoading, setRoomsLoading] = useState(false)
  const [roomQuery, setRoomQuery] = useState('')
  const pollRef = useRef<number | null>(null)
  const runCancelRef = useRef(false)
  const currentBatchIdRef = useRef<string | null>(null)
  const unmountedRef = useRef(false)

  // 卸载不清 sleep 定时器（挂起 chunk 循环）：置标志让循环自行终止，
  // 已完成的分批落库、剩余分批放弃（重挂载后按 imported 徽标可辨）。
  // setup 里复位：StrictMode dev 双挂载会先跑一次 cleanup，不复位则恒 true，
  // 首次导入即被误判为已卸载而卡死在 running。
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  const loadDocuments = useCallback(async () => {
    if (!external || listLoading) return
    setListLoading(true)
    setListError(null)
    try {
      const response = await external.importList(provider, connectionName || undefined)
      setItems(response.items)
      setTruncated(response.truncated)
      setWarnings(response.warnings.map((warning) => warning.message))
      setFetchedAt(response.fetchedAt ?? new Date().toISOString())
      setSelected(new Set())
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    } finally {
      setListLoading(false)
    }
  }, [external, provider, connectionName, listLoading])

  // 打开/切换 provider 或连接时先回显上次列举缓存（秒开，不拉远端）；
  // imported 徽标由服务端按当前库重算，导入后无需重拉。
  useEffect(() => {
    if (!external) return
    void external.importList(provider, connectionName || undefined, true)
      .then((response) => {
        if (response.fetchedAt && response.items.length > 0) {
          setItems(response.items)
          setTruncated(response.truncated)
          setWarnings(response.warnings.map((warning) => warning.message))
          setFetchedAt(response.fetchedAt)
          setSelected(new Set())
        }
      })
      .catch(() => undefined)
  }, [external, provider, connectionName])

  const visibleItems = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) => item.title.toLowerCase().includes(keyword)
      || (item.wikiSpaceName ?? '').toLowerCase().includes(keyword))
  }, [items, filter])
  const batchStatusById = useMemo(() => new Map((run?.items ?? []).map((item) => [item.remoteDocumentId, item])), [run])
  /** 明细行显示名：批量项 title 常为 null（失败/跳过发生在标题回填前），回退到列表项标题。 */
  const listTitleById = useMemo(() => new Map(items.map((item) => [item.remoteDocumentId, item.title])), [items])
  const itemDisplayName = (item: DocumentImportBatchItemView) =>
    item.title || listTitleById.get(item.remoteDocumentId) || item.remoteDocumentId
  const visibleSelectableIds = visibleItems.map((item) => item.remoteDocumentId)
  const allVisibleSelected = visibleSelectableIds.length > 0
    && visibleSelectableIds.every((id) => selected.has(id))

  const toggleItem = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleVisible = () => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (allVisibleSelected) visibleSelectableIds.forEach((id) => next.delete(id))
      else visibleSelectableIds.forEach((id) => next.add(id))
      return next
    })
  }

  /** 单批接口上限（网关 BATCH_MAX_ITEMS + schema maxItems）：超出自动分批串行。 */
  const BATCH_CHUNK = 50

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    pollRef.current = window.setTimeout(resolve, ms)
  })

  const mergeBatchIntoRun = (
    agg: { imported: number; incubated: number; failed: number; skipped: number; items: DocumentImportBatchItemView[] },
    view: DocumentImportBatchView,
  ) => {
    agg.items.push(...view.items)
    agg.imported += view.items.filter((item) => item.status === 'imported').length
    agg.incubated += view.items.filter((item) => item.status === 'incubated').length
    agg.failed += view.items.filter((item) => item.status === 'failed').length
    agg.skipped += view.items.filter((item) => item.status === 'skipped' && item.error).length
  }

  const startBatch = async (mode: 'room' | 'auto', roomId?: string, forceNew?: boolean) => {
    if (!external || selected.size === 0 || run?.status === 'running' || batchStarting) return
    setBatchStarting(true)
    setStartError(null)
    const ids = [...selected]
    const chunks: string[][] = []
    for (let index = 0; index < ids.length; index += BATCH_CHUNK) chunks.push(ids.slice(index, index + BATCH_CHUNK))
    const agg = { imported: 0, incubated: 0, failed: 0, skipped: 0, items: [] as DocumentImportBatchItemView[] }
    runCancelRef.current = false
    setSelected(new Set())
    setRun({ status: 'running', total: ids.length, processed: 0, ...agg })
    try {
      let connectionLost = false
      for (const chunk of chunks) {
        if (runCancelRef.current || unmountedRef.current) break
        const created = await external.importBatch({
          provider,
          ...(connectionName ? { connectionName } : {}),
          remoteDocumentIds: chunk,
          mode,
          ...(roomId ? { roomId } : {}),
          ...(forceNew ? { forceNew } : {}),
        })
        // 创建往返期间点了取消：立即取消该批，避免下一轮轮询前多导入数篇。
        if (runCancelRef.current) {
          await external.cancelImportBatch(created.batchId).catch(() => undefined)
          break
        }
        currentBatchIdRef.current = created.batchId
        let pollFailures = 0
        for (;;) {
          await sleep(BATCH_POLL_MS)
          if (unmountedRef.current) return
          if (runCancelRef.current && currentBatchIdRef.current === created.batchId) {
            await external.cancelImportBatch(created.batchId).catch(() => undefined)
          }
          const view = await external.importBatchStatus(created.batchId).catch(() => null)
          if (!view) {
            // 网关不可达/批 404 连续失败要有上限，否则 run 永远停在 running。
            pollFailures += 1
            if (pollFailures >= 10) throw new Error(`批量导入状态查询连续失败（${String(pollFailures)} 次），已中断`)
            continue
          }
          pollFailures = 0
          if (view.status === 'running') {
            setRun((prev) => prev && prev.status === 'running'
              ? { ...prev, processed: agg.imported + agg.incubated + agg.failed + agg.skipped + view.processed }
              : prev)
            continue
          }
          mergeBatchIntoRun(agg, view)
          // 连接级失败（token 失效/oo 不可达）网关会短路整批：继续建剩余
          // 分批只会逐批复现同样失败，熔断整个导入。
          if (view.errorCode === 'IMPORT_CONNECTION_REQUIRED' || view.errorCode === 'OPEN_CONNECTOR_UNAVAILABLE') {
            connectionLost = true
          }
          break
        }
        if (connectionLost) break
        setRun((prev) => prev && prev.status === 'running' ? { ...prev, ...agg } : prev)
      }
      if (unmountedRef.current) return
      const cancelled = runCancelRef.current || connectionLost
      // 终态进度用实际完成数（items 全部已终态）：中途取消/熔断时不跳满。
      setRun({ status: cancelled ? 'cancelled' : 'completed', total: ids.length, processed: agg.items.length, ...agg })
      showToast({
        title: cancelled ? t('surface:connectorSync.batchCancelled') : t('surface:connectorSync.batchCompleted'),
        message: agg.skipped > 0
          ? t('surface:connectorSync.batchSummaryWithSkipped', {
            imported: String(agg.imported),
            incubated: String(agg.incubated),
            failed: String(agg.failed),
            skipped: String(agg.skipped),
          })
          : t('surface:connectorSync.batchSummary', {
            imported: String(agg.imported),
            incubated: String(agg.incubated),
            failed: String(agg.failed),
          }),
      })
      void loadDocuments()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('BATCH_AUTO_UNAVAILABLE')) {
        setAutoDisabled(true)
      }
      setStartError(message)
      setRun((prev) => prev && prev.status === 'running' ? { ...prev, status: 'cancelled' } : prev)
      // 发起失败恢复勾选：可能是几百篇的全选，失败后不应让用户重选一遍
      //（已导入的会在重载后带 imported 徽标）。
      if (!unmountedRef.current) setSelected(new Set(ids))
      showToast({ title: t('surface:connectorSync.batchStartFailed'), message })
    } finally {
      currentBatchIdRef.current = null
      setBatchStarting(false)
    }
  }

  const openRoomPicker = async () => {
    setRoomPickerOpen(true)
    setRoomQuery('')
    if (rooms.length === 0) {
      setRoomsLoading(true)
      try {
        const response = await window.nxcore?.knowledge.listRooms()
        setRooms(response?.items ?? [])
      } catch {
        setRooms([])
      } finally {
        setRoomsLoading(false)
      }
    }
  }

  /** 选定目标 Room：先查勾选中已在该 Room 导入过的文档（>50 时分批查询），
   * 无冲突直接开批，有冲突弹确认（更新已有=默认候选链路 / 创建新的=跳过去重）。 */
  const pickRoom = async (room: { id: string; title: string }) => {
    if (!external || conflictChecking) return
    setConflictChecking(true)
    try {
      const ids = [...selected]
      const existing = new Set<string>()
      for (let index = 0; index < ids.length; index += BATCH_CHUNK) {
        const result = await external.importExistingInRoom(provider, room.id, ids.slice(index, index + BATCH_CHUNK)).catch(() => null)
        if (!result) continue
        for (const id of result.existingRemoteIds) existing.add(id)
      }
      // 部分分批预检失败但已查到冲突时仍弹确认（用已得集合），避免静默覆盖；
      // 完全查不到冲突信息（size=0）时按默认（更新已有）继续，与旧行为一致。
      if (existing.size === 0) {
        setRoomPickerOpen(false)
        await startBatch('room', room.id)
      } else {
        setConflict({ roomId: room.id, roomTitle: room.title, existingRemoteIds: existing })
      }
    } finally {
      setConflictChecking(false)
    }
  }

  const connectionMissing = !listLoading
    && (activeConnections.length === 0 || Boolean(listError?.includes('IMPORT_CONNECTION_REQUIRED')))
  // 授权中轮询：主进程打开授权页后，每 3s 检查一次连接，新连接出现即提示卡消失。
  useEffect(() => {
    if (!authorizing || providedConnections !== undefined) return
    const timer = window.setInterval(loadConnections, 3_000)
    return () => window.clearInterval(timer)
  }, [authorizing, providedConnections, loadConnections])
  useEffect(() => {
    if (authorizing && activeConnections.length > 0) setAuthorizing(false)
  }, [authorizing, activeConnections])
  const goAuthorize = () => {
    setAuthorizing(true)
    void window.nxcore?.cliConnector.startAuthorization(provider)
      .then(() => {
        showToast({ title: t('surface:connectorSync.authPageOpened') })
      })
      .catch((error) => {
        setAuthorizing(false)
        showToast({
          title: t('surface:connectorSync.authorizeFailed'),
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }
  const openConsole = () => {
    void window.nxcore?.cliConnector.openConsole().catch((error) => {
      showToast({
        title: t('surface:connectorSync.openConsoleFailed'),
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }
  const visibleRooms = useMemo(() => {
    const keyword = roomQuery.trim().toLowerCase()
    if (!keyword) return rooms
    return rooms.filter((room) => room.title.toLowerCase().includes(keyword)
      || room.kind.toLowerCase().includes(keyword)
      || room.aliases.some((alias) => alias.toLowerCase().includes(keyword)))
  }, [rooms, roomQuery])

  const originIcon = (origin: ExternalDocumentListItem['origin']) =>
    origin === 'wiki' ? <BookOpen aria-hidden="true" /> : origin === 'drive' ? <FolderOpen aria-hidden="true" /> : <FileText aria-hidden="true" />

  const renderRow = (item: ExternalDocumentListItem) => {
    const status = batchStatusById.get(item.remoteDocumentId)
    const originLabel = t({
      drive: 'surface:connectorSync.originDrive',
      wiki: 'surface:connectorSync.originWiki',
      page: 'surface:connectorSync.originPage',
    }[item.origin])
    const meta = [originLabel, item.ownerName, item.updatedAt ? formatTime(item.updatedAt, locale) : null].filter(Boolean).join(' · ')
    return (
      <label key={item.remoteDocumentId} className="connector-doc-row" data-selected={String(selected.has(item.remoteDocumentId))}>
        <input
          type="checkbox"
          checked={selected.has(item.remoteDocumentId)}
          onChange={() => toggleItem(item.remoteDocumentId)}
          disabled={batchRunning}
          aria-label={item.title}
        />
        <span className="connector-doc-origin-icon" data-origin={item.origin}>{originIcon(item.origin)}</span>
        <span className="connector-doc-main">
          <span className="connector-doc-title">
            <strong>{item.title}</strong>
            {item.wikiSpaceName ? <small>{item.wikiSpaceName}</small> : null}
          </span>
          <span className="connector-doc-meta">{meta}</span>
        </span>
        <span className="connector-doc-state">
          {status && status.status !== 'pending' ? <em data-status={status.status}>{batchItemStatusKey(status.status, t)}</em> : null}
          {status && status.status === 'pending' && batchRunning ? <em data-status="queued">{t('surface:connectorSync.batchItemPending')}</em> : null}
          {item.imported ? <em className="connector-doc-imported">{t('surface:connectorSync.importedBadge')}</em> : null}
        </span>
        {item.sourceUrl ? (
          <a
            className="connector-doc-link"
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={t('surface:connectorSync.openSource')}
            aria-label={`${item.title} · ${t('surface:connectorSync.openSource')}`}
            onClick={(event) => event.stopPropagation()}
          >
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
      </label>
    )
  }

  const batchRunning = run?.status === 'running'
  const batchPercent = run && run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0

  return (
    <section className="connector-sync-section" data-embedded={String(embedded)}>
      {embedded ? null : (
        <div className="connector-section-heading">
          <div>
            <h2>{t('surface:connectorSync.documentImport')}</h2>
            <p>{t('surface:connectorSync.documentImportDesc')}</p>
          </div>
        </div>
      )}

      <div className="connector-doc-toolbar">
        {lockedProvider ? (
          <span className="connector-doc-provider-chip">
            <SourceIcon kind={lockedProvider} />
            {t(lockedProvider === 'feishu' ? 'surface:connectorSync.providerFeishu' : 'surface:connectorSync.providerNotion')}
          </span>
        ) : (
          <div className="connector-segmented">
            {providerOptions.map((service) => (
              <button key={service} type="button" data-active={String(provider === service)} onClick={() => setProvider(service)}>
                {t(service === 'feishu' ? 'surface:connectorSync.providerFeishu' : 'surface:connectorSync.providerNotion')}
              </button>
            ))}
          </div>
        )}
        {activeConnections.length > 1 && lockedConnectionName === undefined ? (
          <select value={connectionName} onChange={(event) => setConnectionName(event.target.value)}>
            <option value="">{t('surface:connectorSync.defaultConnection')}</option>
            {activeConnections.map((item) => (
              <option key={item.connectionName ?? 'default'} value={item.connectionName ?? ''}>
                {item.displayName || item.connectionName || item.service}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="connector-icon-btn"
          disabled={listLoading || batchRunning}
          title={t(items.length > 0 ? 'surface:connectorSync.reloadDocuments' : 'surface:connectorSync.loadDocuments')}
          aria-label={t(items.length > 0 ? 'surface:connectorSync.reloadDocuments' : 'surface:connectorSync.loadDocuments')}
          onClick={() => void loadDocuments()}
        >
          {listLoading ? <LoaderCircle className="spin" /> : <RefreshCw />}
        </button>
      </div>

      {connectionMissing ? (
        <div className="connector-doc-connect-hint">
          <PlugZap aria-hidden="true" />
          <span>{t(authorizing ? 'surface:connectorSync.authorizingHint' : 'surface:connectorSync.noConnectionHint')}</span>
          <div className="connector-doc-connect-actions">
            <button type="button" className="primary-button" disabled={authorizing} onClick={goAuthorize}>
              {authorizing ? <LoaderCircle className="spin" /> : null}
              {t('surface:connectorSync.goAuthorize')}
            </button>
            <button type="button" className="secondary-button" onClick={openConsole}>
              {t('surface:connectorSync.openConsole')}
            </button>
          </div>
        </div>
      ) : null}
      {truncated || warnings.length > 0 ? (
        <div className="connector-doc-warning">
          <TriangleAlert aria-hidden="true" />
          <span>{[truncated ? t('surface:connectorSync.listTruncated') : null, ...warnings].filter(Boolean).join('；')}</span>
        </div>
      ) : null}
      {listError ? (
        <div className="connector-sync-alert" role="alert">
          <span>{listError}</span>
          <button type="button" onClick={() => setListError(null)} aria-label="dismiss"><X /></button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <div className="connector-doc-meta-row">
            <span>
              {fetchedAt
                ? t('surface:connectorSync.docListMeta', { count: String(items.length), time: new Date(fetchedAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
                : t('surface:connectorSync.docListMetaNoTime', { count: String(items.length) })}
            </span>
            {provider === 'notion' ? (
              <span className="connector-doc-info" role="note" title={t('surface:connectorSync.notionScopeHint')}>
                <Info aria-hidden="true" />
              </span>
            ) : null}
          </div>
          <div className="connector-doc-filter">
            <Search aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('surface:connectorSync.filterDocuments')}
            />
            {filter ? (
              <button
                type="button"
                className="connector-doc-filter-clear"
                onClick={() => setFilter('')}
                aria-label={t('surface:connectorSync.filterClear')}
                title={t('surface:connectorSync.filterClear')}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="connector-doc-list" data-embedded={String(embedded)} data-running={String(batchRunning)}>
            <label className="connector-doc-row connector-doc-row-head">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleVisible}
                disabled={batchRunning || visibleSelectableIds.length === 0}
                aria-label={t('surface:connectorSync.selectAllDocuments')}
              />
              <span>{t('surface:connectorSync.selectAllDocuments')}</span>
              <span className="connector-doc-head-count">{t('surface:connectorSync.selectedCount', { count: String(selected.size) })}</span>
            </label>
            {visibleItems.length === 0 ? (
              <div className="connector-doc-list-empty">
                <span>{t('surface:connectorSync.filterNoMatch', { query: filter.trim() })}</span>
                <button type="button" onClick={() => setFilter('')}>{t('surface:connectorSync.filterClear')}</button>
              </div>
            ) : (
              visibleItems.map(renderRow)
            )}
          </div>

          <div className="connector-doc-actions">
            {batchRunning && run ? (
              <div className="connector-doc-progress">
                <div className="connector-doc-progress-row">
                  <LoaderCircle className="spin" aria-hidden="true" />
                  <strong>{t('surface:connectorSync.batchProgress', {
                    processed: String(run.processed),
                    total: String(run.total),
                  })}</strong>
                  <span>{t('surface:connectorSync.batchProgressDetail', {
                    succeeded: String(run.imported + run.incubated),
                    failed: String(run.failed),
                  })}</span>
                  <button type="button" className="connector-text-btn" onClick={() => {
                    runCancelRef.current = true
                    if (currentBatchIdRef.current && external) {
                      void external.cancelImportBatch(currentBatchIdRef.current).catch(() => undefined)
                    }
                  }}>
                    {t('surface:connectorSync.batchCancel')}
                  </button>
                </div>
                <div className="connector-doc-progress-track"><div style={{ width: `${batchPercent}%` }} /></div>
              </div>
            ) : (
              <>
                <span className="connector-doc-count" data-active={String(selected.size > 0)}>
                  {t('surface:connectorSync.selectedCount', { count: String(selected.size) })}
                </span>
                <button
                  type="button"
                  className="primary-button"
                  disabled={selected.size === 0 || batchStarting}
                  title={t('surface:connectorSync.importToRoomTooltip')}
                  onClick={() => void openRoomPicker()}
                >
                  <FileDown aria-hidden="true" />
                  {t('surface:connectorSync.importToRoom')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={selected.size === 0 || autoDisabled || batchStarting}
                  title={t(autoDisabled ? 'surface:connectorSync.autoClassifyUnavailable' : 'surface:connectorSync.aiClassifyTooltip')}
                  onClick={() => void startBatch('auto')}
                >
                  {batchStarting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Bot aria-hidden="true" />}
                  {t('surface:connectorSync.aiAutoClassify')}
                </button>
              </>
            )}
          </div>
          {startError ? (
            <div className="connector-doc-failures">
              <strong><TriangleAlert aria-hidden="true" />{t('surface:connectorSync.batchStartFailed')}</strong>
              <div>
                <span>{startError}</span>
              </div>
            </div>
          ) : null}
          {run && run.status !== 'running' && run.items.some((item) => item.status === 'failed') ? (
            <div className="connector-doc-failures">
              <strong><TriangleAlert aria-hidden="true" />{t('surface:connectorSync.batchFailedItems')}</strong>
              {run.items.filter((item) => item.status === 'failed').map((item) => (
                <div key={item.remoteDocumentId}>
                  <span>{itemDisplayName(item)}</span>
                  <small>{item.error}</small>
                </div>
              ))}
            </div>
          ) : null}
          {run && run.status !== 'running' && run.items.some((item) => item.status === 'skipped' && item.error) ? (
            <div className="connector-doc-failures connector-doc-skipped">
              <strong><Info aria-hidden="true" />{t('surface:connectorSync.batchSkippedItems')}</strong>
              {run.items.filter((item) => item.status === 'skipped' && item.error).map((item) => (
                <div key={item.remoteDocumentId}>
                  <span>{itemDisplayName(item)}</span>
                  <small>{item.error}</small>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : listLoading ? (
        <div className="connector-doc-skeleton" aria-busy="true" aria-label={t('surface:connectorSync.loadingDocuments')}>
          {[0, 1, 2, 3, 4].map((index) => <span key={index} style={{ animationDelay: `${index * 120}ms` }} />)}
        </div>
      ) : !listError ? (
        <div className="connector-doc-empty">
          <Files aria-hidden="true" />
          <p>{items.length === 0 && (truncated || warnings.length > 0)
            ? t('surface:connectorSync.documentListEmpty')
            : t('surface:connectorSync.documentListEmptyHint')}</p>
          <button type="button" className="primary-button" disabled={batchRunning} onClick={() => void loadDocuments()}>
            <RefreshCw aria-hidden="true" />
            {t('surface:connectorSync.loadDocuments')}
          </button>
        </div>
      ) : null}

      {roomPickerOpen ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRoomPickerOpen(false)
        }}>
          <section className="connector-room-picker" role="dialog" aria-modal="true" aria-label={t('surface:connectorSync.chooseTargetRoom')}>
            <header>
              <div className="connector-room-picker-title">
                <FileDown aria-hidden="true" />
                <span>{t('surface:connectorSync.chooseTargetRoomCount', { count: String(selected.size) })}</span>
              </div>
              <button type="button" className="connector-icon-btn" onClick={() => setRoomPickerOpen(false)} aria-label={t('surface:connectorSync.chooseTargetRoom')}>
                <X />
              </button>
            </header>
            <div className="connector-doc-filter">
              <Search aria-hidden="true" />
              <input
                value={roomQuery}
                onChange={(event) => setRoomQuery(event.target.value)}
                placeholder={t('surface:connectorSync.roomSearchPlaceholder')}
                autoFocus
              />
            </div>
            <div className="connector-room-list">
              {roomsLoading ? <div className="connector-sync-empty"><LoaderCircle className="spin" /></div> : null}
              {!roomsLoading && visibleRooms.length === 0 ? (
                <div className="connector-sync-empty">{t('surface:connectorSync.noRoomsAvailable')}</div>
              ) : null}
      {conflict ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConflict(null)
        }}>
          <section className="connector-conflict-confirm" role="dialog" aria-modal="true" aria-label={t('surface:connectorSync.conflictTitle')}>
            <header>
              <div className="connector-conflict-confirm-title">
                <TriangleAlert aria-hidden="true" />
                <span>{t('surface:connectorSync.conflictTitle')}</span>
              </div>
              <button type="button" className="connector-icon-btn" onClick={() => setConflict(null)} aria-label={t('surface:connectorSync.close')}>
                <X />
              </button>
            </header>
            <div className="connector-conflict-confirm-body">
              <p>
                {t('surface:connectorSync.conflictSummary', {
                  count: String(conflict.existingRemoteIds.size),
                  total: String(selected.size),
                  room: conflict.roomTitle,
                })}
              </p>
              <ul className="connector-conflict-confirm-list">
                {items
                  .filter((item) => conflict.existingRemoteIds.has(item.remoteDocumentId))
                  .slice(0, 6)
                  .map((item) => (
                    <li key={item.remoteDocumentId}>
                      <SourceIcon kind={provider} aria-hidden="true" />
                      <span>{item.title}</span>
                    </li>
                  ))}
                {conflict.existingRemoteIds.size > 6 ? (
                  <li className="connector-conflict-confirm-more">
                    {t('surface:connectorSync.conflictMoreCount', { count: String(conflict.existingRemoteIds.size - 6) })}
                  </li>
                ) : null}
              </ul>
              <p className="connector-conflict-confirm-hint">{t('surface:connectorSync.conflictUpdateHint')}</p>
            </div>
            <footer>
              <button type="button" className="secondary-button" onClick={() => setConflict(null)}>
                {t('surface:connectorSync.cancel')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setConflict(null)
                  setRoomPickerOpen(false)
                  void startBatch('room', conflict.roomId, true)
                }}
              >
                {t('surface:connectorSync.conflictCreateNew')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setConflict(null)
                  setRoomPickerOpen(false)
                  void startBatch('room', conflict.roomId)
                }}
              >
                {t('surface:connectorSync.conflictUpdate')}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
              {visibleRooms.map((room) => (
                <button key={room.id} type="button" className="connector-room-row" disabled={conflictChecking} onClick={() => { void pickRoom(room) }}>
                  <span className="connector-room-icon"><Boxes aria-hidden="true" /></span>
                  <span className="connector-room-copy">
                    <strong>{room.title}</strong>
                    <small>{room.kind}</small>
                  </span>
                  <ArrowUpRight className="connector-room-go" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
