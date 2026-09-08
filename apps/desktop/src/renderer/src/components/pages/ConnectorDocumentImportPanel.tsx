import { Bot, FileDown, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  DocumentImportBatchView,
  ExternalDocumentListItem,
  ExternalDocumentProvider,
} from '@nxcore/agent-contract'
import type { KnowledgeRoomDto } from '../../../../shared/knowledge'
import type { OpenConnectorConnectionSummary } from '../../../../shared/open-connector'
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

  const [batch, setBatch] = useState<DocumentImportBatchView | null>(null)
  const [autoDisabled, setAutoDisabled] = useState(false)
  const [roomPickerOpen, setRoomPickerOpen] = useState(false)
  const [rooms, setRooms] = useState<KnowledgeRoomDto[]>([])
  const [roomsLoading, setRoomsLoading] = useState(false)
  const [roomQuery, setRoomQuery] = useState('')
  const pollRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
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
  const batchStatusById = useMemo(() => new Map((batch?.items ?? []).map((item) => [item.remoteDocumentId, item])), [batch])
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

  const startBatch = async (mode: 'room' | 'auto', roomId?: string) => {
    if (!external || selected.size === 0 || batch?.status === 'running') return
    try {
      const created = await external.importBatch({
        provider,
        ...(connectionName ? { connectionName } : {}),
        remoteDocumentIds: [...selected],
        mode,
        ...(roomId ? { roomId } : {}),
      })
      setSelected(new Set())
      const view = await external.importBatchStatus(created.batchId)
      setBatch(view)
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(() => {
        void external.importBatchStatus(created.batchId)
          .then((next) => {
            setBatch(next)
            if (next.status !== 'running') {
              if (pollRef.current !== null) window.clearInterval(pollRef.current)
              pollRef.current = null
              const imported = next.items.filter((item) => item.status === 'imported').length
              const incubated = next.items.filter((item) => item.status === 'incubated').length
              const failed = next.items.filter((item) => item.status === 'failed').length
              showToast({
                title: next.status === 'cancelled'
                  ? t('surface:connectorSync.batchCancelled')
                  : t('surface:connectorSync.batchCompleted'),
                message: t('surface:connectorSync.batchSummary', {
                  imported: String(imported),
                  incubated: String(incubated),
                  failed: String(failed),
                }),
              })
              void loadDocuments()
            }
          })
          .catch(() => undefined)
      }, BATCH_POLL_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('BATCH_AUTO_UNAVAILABLE')) {
        setAutoDisabled(true)
        showToast({ title: t('surface:connectorSync.autoClassifyUnavailable'), message })
      } else if (message.includes('BATCH_ROUTER_DISABLED')) {
        setAutoDisabled(true)
        showToast({ title: t('surface:connectorSync.autoRouterDisabled'), message })
      } else {
        showToast({ title: t('surface:connectorSync.batchStartFailed'), message })
      }
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

  const batchRunning = batch?.status === 'running'
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

  return (
    <section className="connector-sync-section">
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
          <span className="connector-doc-locked-provider">
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
        <button type="button" className="secondary-button" disabled={listLoading || batchRunning} onClick={() => void loadDocuments()}>
          {listLoading ? <LoaderCircle className="spin" /> : <RefreshCw />}
          {t(listLoading ? 'surface:connectorSync.loadingDocuments' : items.length > 0 ? 'surface:connectorSync.reloadDocuments' : 'surface:connectorSync.loadDocuments')}
        </button>
      </div>

      {fetchedAt && items.length > 0 ? (
        <p className="connector-doc-hint connector-doc-fetched-at">
          {t('surface:connectorSync.listFetchedAt', { time: new Date(fetchedAt).toLocaleString(locale) })}
        </p>
      ) : null}

      {provider === 'notion' ? (
        <p className="connector-doc-hint">{t('surface:connectorSync.notionScopeHint')}</p>
      ) : null}
      {connectionMissing ? (
        <div className="connector-doc-connect-hint">
          <span>{t(authorizing ? 'surface:connectorSync.authorizingHint' : 'surface:connectorSync.noConnectionHint')}</span>
          <div className="connector-doc-connect-actions">
            <button type="button" className="primary-button" disabled={authorizing} onClick={goAuthorize}>
              {t('surface:connectorSync.goAuthorize')}
            </button>
            <button type="button" className="secondary-button" onClick={openConsole}>
              {t('surface:connectorSync.openConsole')}
            </button>
          </div>
        </div>
      ) : null}
      {truncated ? <div className="connector-doc-warning">{t('surface:connectorSync.listTruncated')}</div> : null}
      {warnings.length > 0 ? <div className="connector-doc-warning">{warnings.join('；')}</div> : null}
      {listError ? <div className="connector-sync-alert" role="alert"><span>{listError}</span><button type="button" onClick={() => setListError(null)}><X /></button></div> : null}

      {items.length > 0 ? (
        <>
          <div className="connector-doc-filter">
            <Search aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('surface:connectorSync.filterDocuments')}
            />
          </div>
          <div className="connector-doc-list" data-embedded={String(embedded)}>
            {embedded ? (
              <label className="connector-doc-row connector-doc-row-head">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  aria-label={t('surface:connectorSync.selectAllDocuments')}
                />
                <span className="connector-doc-title">{t('surface:connectorSync.selectAllDocuments')}</span>
                <span className="connector-doc-head-count">{t('surface:connectorSync.selectedCount', { count: String(selected.size) })}</span>
              </label>
            ) : (
              <label className="connector-doc-row connector-doc-row-head">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  aria-label={t('surface:connectorSync.selectAllDocuments')}
                />
                <span className="connector-doc-title">{t('surface:connectorSync.documentTitle')}</span>
                <span className="connector-doc-origin">{t('surface:connectorSync.documentOrigin')}</span>
                <span className="connector-doc-updated">{t('surface:connectorSync.documentUpdated')}</span>
                <span className="connector-doc-state">{t('surface:connectorSync.documentState')}</span>
              </label>
            )}
            {visibleItems.map((item) => {
              const status = batchStatusById.get(item.remoteDocumentId)
              const originLabel = t({
                drive: 'surface:connectorSync.originDrive',
                wiki: 'surface:connectorSync.originWiki',
                page: 'surface:connectorSync.originPage',
              }[item.origin])
              if (embedded) {
                return (
                  <label key={item.remoteDocumentId} className="connector-doc-row" data-selected={String(selected.has(item.remoteDocumentId))}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.remoteDocumentId)}
                      onChange={() => toggleItem(item.remoteDocumentId)}
                      disabled={batchRunning}
                    />
                    <span className="connector-doc-main">
                      <span className="connector-doc-title">
                        <strong>{item.title}</strong>
                        {item.wikiSpaceName ? <small>{item.wikiSpaceName}</small> : null}
                      </span>
                      <span className="connector-doc-state">
                        {status && status.status !== 'pending' ? <em data-status={status.status}>{batchItemStatusKey(status.status, t)}</em> : null}
                        {item.imported ? <em className="connector-doc-imported">{t('surface:connectorSync.importedBadge')}</em> : null}
                      </span>
                    </span>
                    <span className="connector-doc-meta">
                      {originLabel}{item.updatedAt ? ` · ${formatTime(item.updatedAt, locale)}` : ''}
                    </span>
                  </label>
                )
              }
              return (
                <label key={item.remoteDocumentId} className="connector-doc-row" data-selected={String(selected.has(item.remoteDocumentId))}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.remoteDocumentId)}
                    onChange={() => toggleItem(item.remoteDocumentId)}
                    disabled={batchRunning}
                  />
                  <span className="connector-doc-title">
                    <strong>{item.title}</strong>
                    {item.wikiSpaceName ? <small>{item.wikiSpaceName}</small> : null}
                  </span>
                  <span className="connector-doc-origin">{originLabel}</span>
                  <span className="connector-doc-updated">{formatTime(item.updatedAt, locale)}</span>
                  <span className="connector-doc-state">
                    {status && status.status !== 'pending' ? <em data-status={status.status}>{batchItemStatusKey(status.status, t)}</em> : null}
                    {item.imported ? <em className="connector-doc-imported">{t('surface:connectorSync.importedBadge')}</em> : null}
                  </span>
                </label>
              )
            })}
          </div>

          <div className="connector-doc-actions">
            <span>{t('surface:connectorSync.selectedCount', { count: String(selected.size) })}</span>
            {batchRunning ? (
              <>
                <span className="connector-doc-progress">
                  <LoaderCircle className="spin" />{t('surface:connectorSync.batchProgress', {
                    processed: String(batch!.processed),
                    total: String(batch!.total),
                  })}
                </span>
                <button type="button" className="secondary-button" onClick={() => {
                  if (!external) return
                  void external.cancelImportBatch(batch!.id).then(setBatch).catch(() => undefined)
                }}>
                  {t('surface:connectorSync.batchCancel')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="primary-button" disabled={selected.size === 0} onClick={() => void openRoomPicker()}>
                  <FileDown aria-hidden="true" />
                  {t('surface:connectorSync.importToRoom')}
                </button>
                <button type="button" className="secondary-button" disabled={selected.size === 0 || autoDisabled} onClick={() => void startBatch('auto')}>
                  <Bot aria-hidden="true" />
                  {t('surface:connectorSync.aiAutoClassify')}
                </button>
              </>
            )}
          </div>
          {batch && batch.status !== 'running' && batch.items.some((item) => item.status === 'failed') ? (
            <div className="connector-doc-failures">
              <strong>{t('surface:connectorSync.batchFailedItems')}</strong>
              {batch.items.filter((item) => item.status === 'failed').map((item) => (
                <div key={item.remoteDocumentId}>
                  <span>{item.title ?? item.remoteDocumentId}</span>
                  <small>{item.error}</small>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : !listLoading && !listError ? (
        <div className="connector-sync-empty">
          {items.length === 0 && (truncated || warnings.length > 0)
            ? t('surface:connectorSync.documentListEmpty')
            : t('surface:connectorSync.documentListEmptyHint')}
        </div>
      ) : null}

      {roomPickerOpen ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRoomPickerOpen(false)
        }}>
          <section className="connector-room-picker" role="dialog" aria-modal="true" aria-label={t('surface:connectorSync.chooseTargetRoom')}>
            <header>
              <span>{t('surface:connectorSync.chooseTargetRoom')}</span>
              <button type="button" onClick={() => setRoomPickerOpen(false)}><X /></button>
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
              {visibleRooms.map((room) => (
                <button key={room.id} type="button" className="connector-room-row" onClick={() => {
                  setRoomPickerOpen(false)
                  void startBatch('room', room.id)
                }}>
                  <strong>{room.title}</strong>
                  <small>{room.kind}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}
