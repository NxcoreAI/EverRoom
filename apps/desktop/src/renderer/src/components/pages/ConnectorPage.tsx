import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, CirclePause, Database, Eye, FileText, LoaderCircle, Mail, MapPin, Play, RefreshCw, Trash2, Users, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectorConnection, ConnectorJsonRecord, ConnectorStatus, MailMessage, NormalizedCalendarEvent, SyncMode, SyncRun, SyncScope, WikiDocumentPreview, WikiDocumentSummary } from '@nxcore/connector-contract'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import './ConnectorPage.css'

type View = 'connections' | 'runs' | 'scopes' | 'mail' | 'calendar' | 'wiki'
const VIEWS: Array<{ id: View; label: string; icon: typeof Database }> = [
  { id: 'connections', label: '连接', icon: Database }, { id: 'runs', label: '同步', icon: RefreshCw },
  { id: 'scopes', label: '范围', icon: ChevronRight }, { id: 'mail', label: '邮件', icon: Mail }, { id: 'calendar', label: '日程', icon: CalendarDays },
  { id: 'wiki', label: '文档', icon: FileText },
]
const INITIAL: ConnectorStatus = { enabled: false, connections: [], scopes: [], runs: [] }

function date(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--' }
function api() { return window.nxcore?.connectors }

/** 数据源页内嵌的连接器管理区块（邮件/日程/文档连接器的授权与同步）。 */
export function ConnectorSection() {
  const [view, setView] = useState<View>('connections')
  const [status, setStatus] = useState<ConnectorStatus>(INITIAL)
  const [mail, setMail] = useState<MailMessage[]>([])
  const [calendarRecords, setCalendarRecords] = useState<ConnectorJsonRecord<NormalizedCalendarEvent>[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const connectors = api()

  const refresh = useCallback(async () => {
    if (!connectors) return
    try {
      setError(null)
      const next = await connectors.status()
      setStatus(next)
      if (view === 'mail') setMail(await connectors.mail({ connectionId: selectedConnection ?? undefined, limit: 100 }))
      if (view === 'calendar') {
        const ids = next.connections.filter((item) => item.provider === 'google-calendar' && (!selectedConnection || item.id === selectedConnection)).map((item) => item.id)
        setCalendarRecords((await Promise.all(ids.map((id) => connectors!.records(id, 'calendar')))).flat() as ConnectorJsonRecord<NormalizedCalendarEvent>[])
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取连接器状态。') }
    finally { setLoading(false) }
  }, [connectors, selectedConnection, view])

  useEffect(() => {
    const tick = () => { if (!document.hidden) void refresh() }
    tick()
    const timer = window.setInterval(tick, 2_000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [refresh])
  const connections = status.connections
  const wikiConnections = useMemo(() => connections.filter((item) => item.provider === 'google-docs' || item.provider === 'notion'), [connections])
  const selected = useMemo(() => connections.find((item) => item.id === selectedConnection) ?? null, [connections, selectedConnection])
  const visibleScopes = useMemo(() => selectedConnection ? status.scopes.filter((item) => item.connectionId === selectedConnection) : status.scopes, [selectedConnection, status.scopes])
  const visibleRuns = useMemo(() => { if (!selectedConnection) return status.runs; const scopeIds = new Set(visibleScopes.map((item) => item.id)); return status.runs.filter((item) => scopeIds.has(item.scopeId)) }, [selectedConnection, status.runs, visibleScopes])
  const run = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(key)
    try { await action(); await refresh(); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。'); return false }
    finally { setBusy(null) }
  }
  const triggerConnection = (connection: ConnectorConnection, mode: SyncMode) => {
    if (mode === 'rebuild' && !window.confirm('重建会重新扫描该连接的同步范围。确认继续？')) return
    const scopes = status.scopes.filter((item) => item.connectionId === connection.id)
    void run(`${connection.id}:${mode}`, () => Promise.all(scopes.map((scope) => connectors!.triggerSync(scope.id, mode))))
  }
  const triggerScope = (scope: SyncScope, mode: SyncMode) => { if (mode !== 'rebuild' || window.confirm(`确认重建 ${scope.displayName}？`)) void run(`${scope.id}:${mode}`, () => connectors!.triggerSync(scope.id, mode)) }

  if (!connectors) return null
  return <section className="connector-debug-page connector-section">
    <div className="connector-toolbar"><div className="connector-tabs" role="tablist">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} data-active={String(view === id)} onClick={() => setView(id)}><Icon aria-hidden="true" />{label}<span>{id === 'connections' ? connections.length : id === 'runs' ? status.runs.length : id === 'scopes' ? status.scopes.length : id === 'wiki' ? wikiConnections.length : id === 'calendar' ? calendarRecords.length : mail.length}</span></button>)}</div><button className="icon-button" onClick={() => void refresh()} disabled={busy !== null} title="刷新" aria-label="刷新"><RefreshCw className={busy === 'refresh' ? 'spin' : undefined} /></button></div>
    {error ? <div className="connector-error" role="alert"><AlertTriangle />{error}<button className="icon-button" onClick={() => setError(null)} title="关闭" aria-label="关闭"><X /></button></div> : null}
    {loading ? <div className="connector-loading" role="status"><LoaderCircle className="spin" />正在读取连接器状态...</div> : null}
    {!loading && !status.enabled ? <div className="connector-callout"><AlertTriangle />连接器模块未配置。请在 .env 配置 Nango（NXCORE_NANGO_URL / NXCORE_NANGO_SECRET）并重启。</div> : null}
    {view === 'connections' ? <ConnectionsView connections={connections} scopes={status.scopes} selectedId={selectedConnection} onSelect={setSelectedConnection} busy={busy} onSync={triggerConnection} onDisable={(id) => { if (window.confirm('停用后将停止该连接的自动同步。确认继续？')) void run(`disable:${id}`, () => connectors.disableConnection(id)) }} onPurge={(id) => { if (window.confirm('确认清理该连接器的本地数据？此操作不可撤销。')) void run(`purge:${id}`, () => connectors.purgeConnection(id)) }} /> : null}
    {view === 'runs' ? <RunsView runs={visibleRuns} scopes={status.scopes} connections={connections} busy={busy} onCancel={(id) => run(`cancel:${id}`, () => connectors.cancelRun(id))} /> : null}
    {view === 'scopes' ? <ScopesView scopes={visibleScopes} connections={connections} busy={busy} onSync={triggerScope} /> : null}
    {view === 'mail' ? <MailView messages={mail} /> : null}
    {view === 'calendar' ? <CalendarView records={calendarRecords} connections={connections} scopes={status.scopes} /> : null}
    {view === 'wiki' ? <WikiSourcesView connections={wikiConnections} scopes={status.scopes} runs={status.runs} busy={busy} onSync={(connection) => triggerConnection(connection, 'full')} /> : null}
    {selected ? <div className="connector-selection"><strong>选中连接</strong><span>{selected.provider} · {selected.nangoConnectionId}</span><button className="icon-button" onClick={() => setSelectedConnection(null)} title="清除选择" aria-label="清除选择"><X /></button></div> : null}
  </section>
}

function providerLabel(provider: string): string { return provider === 'gmail' ? 'Gmail' : provider === 'outlook' ? 'Outlook' : provider === 'google-docs' ? 'Google Docs' : provider === 'google-calendar' ? 'Google Calendar' : 'Notion' }
function ConnectionsView({ connections, scopes, selectedId, onSelect, busy, onSync, onDisable, onPurge }: { connections: ConnectorConnection[]; scopes: SyncScope[]; selectedId: string | null; onSelect: (id: string) => void; busy: string | null; onSync: (connection: ConnectorConnection, mode: SyncMode) => void; onDisable: (id: string) => void; onPurge: (id: string) => void }) {
  return <section className="connector-table-wrap"><div className="connector-table-head"><span>服务 / 连接</span><span>状态</span><span>更新时间</span><span>操作</span></div>{connections.length === 0 ? <Empty icon={<Database />} title="尚未连接服务" detail="通过上方「连接数据源」菜单完成 OAuth 授权。" /> : connections.map((item) => { const hasScopes = scopes.some((scope) => scope.connectionId === item.id); return <div className="connector-table-row" key={item.id} data-selected={String(item.id === selectedId)}><button className="connector-primary-cell" onClick={() => onSelect(item.id)}><strong>{providerLabel(item.provider)}</strong><small>{item.nangoConnectionId}</small></button><span><i className={`connector-status-dot ${item.status}`} />{item.status === 'error' ? '需重新授权' : item.status === 'active' ? '正常' : item.status}</span><span>{date(item.updatedAt)}</span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'incremental')} title="运行增量同步" aria-label="运行增量同步"><Play /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'full')} title="运行全量同步" aria-label="运行全量同步"><RefreshCw /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'rebuild')} title="重建同步范围" aria-label="重建同步范围"><Wrench /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active'} onClick={() => onDisable(item.id)} title="停用连接" aria-label="停用连接"><CirclePause /></button><button className="icon-button danger" disabled={busy !== null} onClick={() => onPurge(item.id)} title="清理本地数据" aria-label="清理本地数据"><Trash2 /></button></div></div> })}</section>
}
function RunsView({ runs, scopes, connections, busy, onCancel }: { runs: SyncRun[]; scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onCancel: (id: string) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head runs"><span>连接 / 运行</span><span>模式</span><span>进度</span><span>状态 / 错误</span></div>{runs.length === 0 ? <Empty icon={<RefreshCw />} title="暂无同步运行" detail="手动触发或等待调度器创建运行。" /> : runs.map((run) => { const scope = scopes.find((item) => item.id === run.scopeId); const connection = scope ? connections.find((item) => item.id === scope.connectionId) : null; return <div className="connector-table-row runs" key={run.id}><span><strong>{connection ? providerLabel(connection.provider) : '未知连接'}</strong><small>{connection?.nangoConnectionId ?? run.scopeId} · run {run.id.slice(0, 12)}</small></span><span>{run.mode}</span><span>{run.processed.toLocaleString()} 条 · {run.failed} 失败</span><span className="run-state"><i className={`connector-status-dot ${run.status}`} />{run.status}{run.error ? <details className="run-error" open><summary>错误详情</summary><code>{run.error}</code></details> : null}{run.status === 'running' ? <button className="icon-button" disabled={busy !== null} onClick={() => onCancel(run.id)} title="取消运行" aria-label="取消运行"><CirclePause /></button> : null}</span></div> })}</section> }
function ScopesView({ scopes, connections, busy, onSync }: { scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onSync: (scope: SyncScope, mode: SyncMode) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head scopes"><span>连接 / 范围</span><span>状态</span><span>进度</span><span>租约 / 操作</span></div>{scopes.length === 0 ? <Empty icon={<ChevronRight />} title="暂无同步范围" detail="连接注册后，邮箱或文档范围会出现在这里。" /> : scopes.map((scope) => { const connection = connections.find((item) => item.id === scope.connectionId); return <div className="connector-table-row scopes" key={scope.id}><span><strong>{connection ? providerLabel(connection.provider) : '未知连接'}</strong><small>{connection?.nangoConnectionId ?? scope.connectionId} · {scope.displayName}</small></span><span><i className={`connector-status-dot ${scope.state}`} />{scope.state}</span><span>{scope.deliveryCursor.toLocaleString()} · rev {scope.checkpointRevision}</span><span className="connector-scope-actions"><span>{scope.leaseOwner ? date(scope.leaseExpiresAt) : '无租约'}</span><button className="icon-button" disabled={busy !== null || scope.state === 'running' || scope.state === 'disabled'} onClick={() => onSync(scope, scope.state === 'resync_required' ? 'rebuild' : 'incremental')} title={scope.state === 'resync_required' ? '重建范围' : '增量同步'} aria-label={scope.state === 'resync_required' ? '重建范围' : '增量同步'}>{scope.state === 'resync_required' ? <Wrench /> : <Play />}</button></span></div> })}</section> }
function MailView({ messages }: { messages: MailMessage[] }) { const [selected, setSelected] = useState<MailMessage | null>(null); return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head mail"><span>主题 / 摘要</span><span>接收时间</span><span>标记</span><span>消息 ID</span></div>{messages.length === 0 ? <Empty icon={<Mail />} title="暂无邮件" detail="同步成功后，规范化邮件会显示在这里。" /> : messages.map((message) => <button type="button" className="connector-table-row mail connector-mail-row" key={message.id} onClick={() => setSelected(message)}><span><strong>{message.subject || '(无主题)'}</strong><small>{message.snippet || '无摘要'}</small></span><span>{date(message.receivedAt)}</span><span>{message.isRead ? '已读' : '未读'}{message.isStarred ? ' · 星标' : ''}{message.isDraft ? ' · 草稿' : ''}</span><span>{message.providerMessageId}</span></button>)}</section>{selected ? <aside className="connector-inspector" aria-label="邮件详情"><header><div><strong>{selected.subject || '(无主题)'}</strong><small>{date(selected.receivedAt)}</small></div><button className="icon-button" onClick={() => setSelected(null)} title="关闭详情" aria-label="关闭详情"><X /></button></header><dl><dt>消息 ID</dt><dd>{selected.providerMessageId}</dd><dt>会话</dt><dd>{selected.providerThreadId || '--'}</dd><dt>状态</dt><dd>{selected.isTombstone ? '已删除' : selected.isDraft ? '草稿' : '有效'}</dd></dl><div className="connector-message-body">{selected.textBody || selected.snippet || '无可显示正文。'}</div></aside> : null}</div> }
function CalendarView({ records, connections, scopes }: { records: ConnectorJsonRecord<NormalizedCalendarEvent>[]; connections: ConnectorConnection[]; scopes: SyncScope[] }) {
  const [selected, setSelected] = useState<ConnectorJsonRecord<NormalizedCalendarEvent> | null>(null)
  const ordered = useMemo(() => [...records].sort((left, right) => left.data.startsAt.localeCompare(right.data.startsAt)), [records])
  return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head calendar"><span>日程</span><span>时间</span><span>日历</span><span>状态</span></div>{ordered.length === 0 ? <Empty icon={<CalendarDays />} title="没有日程数据" detail="连接 Google Calendar 并完成同步后，日程会显示在这里。" /> : ordered.map((record) => { const event = record.data; const connection = connections.find((item) => item.id === record.connectionId); const calendar = scopes.find((scope) => scope.connectionId === record.connectionId); return <button type="button" className="connector-table-row calendar connector-mail-row" key={`${record.connectionId}:${event.providerEventId}`} onClick={() => setSelected(record)}><span><strong>{event.title || '(无标题)'}</strong><small>{event.location || event.description || event.providerEventId}</small></span><span><strong>{date(event.startsAt)}</strong><small>至 {date(event.endsAt)}{event.timeZone ? ` · ${event.timeZone}` : ''}</small></span><span>{calendar?.displayName || providerLabel(connection?.provider ?? 'google-calendar')}<small>{connection?.nangoConnectionId}</small></span><span><i className={`connector-status-dot ${event.status === 'cancelled' ? 'error' : 'active'}`} />{event.status === 'cancelled' ? '已取消' : '已确认'}</span></button> })}</section>{selected ? <CalendarInspector record={selected} onClose={() => setSelected(null)} /> : null}</div>
}
function CalendarInspector({ record, onClose }: { record: ConnectorJsonRecord<NormalizedCalendarEvent>; onClose: () => void }) {
  const event = record.data
  return <aside className="connector-inspector connector-calendar-inspector" aria-label="日程详情"><header><div><strong>{event.title || '(无标题)'}</strong><small>{date(event.startsAt)} - {date(event.endsAt)}</small></div><button className="icon-button" onClick={onClose} title="关闭详情" aria-label="关闭详情"><X /></button></header><div className="connector-calendar-facts">{event.location ? <span><MapPin />{event.location}</span> : null}<span><CalendarDays />{event.timeZone || '本地时区'}</span>{event.attendees?.length ? <span><Users />{event.attendees.length} 位参与者</span> : null}</div><dl><dt>日程 ID</dt><dd>{event.providerEventId}</dd><dt>状态</dt><dd>{event.status || 'confirmed'}</dd><dt>组织者</dt><dd>{event.organizer?.displayName || event.organizer?.address || '--'}</dd><dt>连接</dt><dd>{record.connectionId}</dd></dl>{event.attendees?.length ? <div className="connector-calendar-attendees">{event.attendees.map((attendee, index) => <span key={`${attendee.address}:${index}`}><strong>{attendee.displayName || attendee.address}</strong><small>{attendee.address}</small></span>)}</div> : null}<div className="connector-message-body">{event.description || '无日程说明。'}</div></aside>
}
function WikiSourcesView({ connections, scopes, runs, busy, onSync }: { connections: ConnectorConnection[]; scopes: SyncScope[]; runs: SyncRun[]; busy: string | null; onSync: (connection: ConnectorConnection) => void }) {
  const connectors = api()!
  const [expanded, setExpanded] = useState<string | null>(null)
  const [documents, setDocuments] = useState<Record<string, WikiDocumentSummary[]>>({})
  const [loadingDocuments, setLoadingDocuments] = useState<string | null>(null)
  const [preview, setPreview] = useState<WikiDocumentPreview | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const toggle = async (connectionId: string) => {
    if (expanded === connectionId) { setExpanded(null); return }
    setExpanded(connectionId)
    setDocumentError(null)
    setLoadingDocuments(connectionId)
    try { const result = await connectors.documents(connectionId); setDocuments((current) => ({ ...current, [connectionId]: result })) }
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : '无法读取文档。') }
    finally { setLoadingDocuments(null) }
  }
  const openPreview = async (connectionId: string, documentId: string) => {
    setDocumentError(null)
    try { setPreview(await connectors.document(connectionId, documentId)) }
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : '无法预览文档。') }
  }
  return <><section className="connector-table-wrap"><div className="connector-table-head"><span>来源 / 服务</span><span>状态</span><span>文档</span><span>操作</span></div>{connections.length === 0 ? <Empty icon={<FileText />} title="暂无文档源" detail="请切换到「连接」标签，授权 Google Docs 或 Notion。" /> : connections.map((connection) => { const scopeIds = new Set(scopes.filter((scope) => scope.connectionId === connection.id).map((scope) => scope.id)); const latestRun = runs.find((run) => scopeIds.has(run.scopeId)); const open = expanded === connection.id; const items = documents[connection.id] ?? []; return <div className="connector-wiki-source" key={connection.id}><div className="connector-table-row"><button type="button" className="connector-primary-cell connector-wiki-toggle" onClick={() => void toggle(connection.id)} aria-expanded={open}>{open ? <ChevronDown /> : <ChevronRight />}<span><strong>{providerLabel(connection.provider)}</strong><small>{connection.nangoConnectionId} · {connection.id.slice(0, 12)}</small></span></button><span><i className={`connector-status-dot ${latestRun?.status ?? connection.status}`} />{latestRun?.status ?? connection.status}{latestRun?.error ? ` · ${latestRun.error}` : ''}</span><span>{latestRun ? `${latestRun.processed.toLocaleString()} 篇文档` : '尚未同步'}<br /><small>{date(latestRun?.finishedAt ?? null)}</small></span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || connection.status !== 'active' || scopeIds.size === 0 || latestRun?.status === 'running'} onClick={() => onSync(connection)} title="重新同步" aria-label="重新同步"><RefreshCw /></button></div></div>{open ? <div className="connector-wiki-documents">{loadingDocuments === connection.id ? <span className="connector-wiki-state"><LoaderCircle className="spin" />正在读取文档...</span> : items.length === 0 ? <span className="connector-wiki-state"><FileText />尚无已同步文档</span> : items.map((document) => <button type="button" className="connector-wiki-document" key={document.id} onClick={() => void openPreview(connection.id, document.id)}><FileText /><span><strong>{document.title}</strong><small>{document.fileName} · {(document.size / 1024).toFixed(1)} KB · {date(document.modifiedAt)}</small></span><Eye aria-hidden="true" /></button>)}</div> : null}</div> })}</section>{documentError ? <div className="connector-error" role="alert"><AlertTriangle />{documentError}<button className="icon-button" onClick={() => setDocumentError(null)} title="关闭" aria-label="关闭"><X /></button></div> : null}{preview ? <MarkdownPreviewDialog preview={{ fileName: preview.title, relativePath: preview.fileName, modifiedAt: preview.modifiedAt, content: preview.content }} onClose={() => setPreview(null)} /> : null}</>
}
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="connector-empty"><span>{icon}</span><strong>{title}</strong><small>{detail}</small></div> }
