import { AlertTriangle, Braces, CalendarDays, Check, ChevronDown, ChevronRight, CirclePause, Database, Eye, FileText, KeyRound, LoaderCircle, Mail, MapPin, Play, Plus, RefreshCw, ShieldAlert, Trash2, Users, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectorAuthorizationAttempt, ConnectorConnection, ConnectorJsonRecord, ConnectorStatus, MailMessage, NormalizedCalendarEvent, SyncMode, SyncRun, SyncScope, WikiDocumentPreview, WikiDocumentSummary } from '@nxcore/connector-contract'
import { PageHeader } from './PageHeader'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import './ConnectorDebugPage.css'

type View = 'connections' | 'runs' | 'scopes' | 'mail' | 'calendar' | 'json' | 'failures' | 'wiki'
const VIEWS: Array<{ id: View; label: string; icon: typeof Database }> = [
  { id: 'connections', label: 'Connections', icon: Database }, { id: 'runs', label: 'Runs', icon: RefreshCw },
  { id: 'scopes', label: 'Scopes', icon: ChevronRight }, { id: 'mail', label: 'Mail', icon: Mail }, { id: 'calendar', label: 'Calendar', icon: CalendarDays }, { id: 'json', label: 'JSON', icon: Braces }, { id: 'failures', label: 'Failures', icon: AlertTriangle },
  { id: 'wiki', label: 'Wiki', icon: FileText },
]
const INITIAL: ConnectorStatus = { enabled: false, connections: [], scopes: [], runs: [] }

function date(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--' }
function api() { return window.nxcore?.connectorDebug }
function requireRecordsApi(debug: NonNullable<ReturnType<typeof api>>) {
  if (typeof debug.records !== 'function') throw new Error('连接器调试 API 已更新，请重启 EverRoom 后重试。')
  return debug.records.bind(debug)
}

export function ConnectorDebugPage() {
  const [view, setView] = useState<View>('connections')
  const [status, setStatus] = useState<ConnectorStatus>(INITIAL)
  const [mail, setMail] = useState<MailMessage[]>([])
  const [calendarRecords, setCalendarRecords] = useState<ConnectorJsonRecord<NormalizedCalendarEvent>[]>([])
  const [jsonRecords, setJsonRecords] = useState<ConnectorJsonRecord[]>([])
  const [failures, setFailures] = useState<Array<{ id: string; scopeId: string | null; runId: string | null; category: string; message: string; createdAt: string }>>([])
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [authorization, setAuthorization] = useState<ConnectorAuthorizationAttempt | null>(null)
  const debug = api()

  const refresh = useCallback(async () => {
    if (!debug?.enabled) return
    try {
      setError(null)
      const next = await debug.status()
      setStatus(next)
      if (view === 'mail') setMail(await debug.mail({ connectionId: selectedConnection ?? undefined, limit: 100 }))
      if (view === 'calendar') {
        const records = requireRecordsApi(debug)
        const ids = next.connections.filter((item) => item.provider === 'google-calendar' && (!selectedConnection || item.id === selectedConnection)).map((item) => item.id)
        setCalendarRecords((await Promise.all(ids.map((id) => records(id, 'calendar')))).flat() as ConnectorJsonRecord<NormalizedCalendarEvent>[])
      }
      if (view === 'json') {
        const records = requireRecordsApi(debug)
        const dataConnections = next.connections.filter((item) => item.provider !== 'google-docs' && item.provider !== 'notion' && (!selectedConnection || item.id === selectedConnection))
        setJsonRecords((await Promise.all(dataConnections.map((item) => records(item.id, item.provider === 'google-calendar' ? 'calendar' : 'mail')))).flat())
      }
      if (view === 'failures') setFailures(await debug.failures({ connectionId: selectedConnection ?? undefined, limit: 100 }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取连接器状态。') }
    finally { setLoading(false) }
  }, [debug, selectedConnection, view])

  useEffect(() => {
    const tick = () => { if (!document.hidden) void refresh() }
    tick()
    const timer = window.setInterval(tick, 2_000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [refresh])
  useEffect(() => {
    if (!debug || authorization?.status !== 'pending') return
    let active = true
    const check = async () => {
      try {
        const next = await debug.authorizationStatus(authorization.id)
        if (!active) return
        setAuthorization(next)
        if (next.status === 'connected') await refresh()
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '无法确认授权状态。')
      }
    }
    const timer = window.setInterval(() => void check(), 2_000)
    void check()
    return () => { active = false; window.clearInterval(timer) }
  }, [authorization?.id, authorization?.status, debug, refresh])
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
    void run(`${connection.id}:${mode}`, () => Promise.all(scopes.map((scope) => debug!.triggerSync(scope.id, mode))))
  }
  const triggerScope = (scope: SyncScope, mode: SyncMode) => { if (mode !== 'rebuild' || window.confirm(`确认重建 ${scope.displayName}？`)) void run(`${scope.id}:${mode}`, () => debug!.triggerSync(scope.id, mode)) }
  const startAuthorization = async (provider: 'gmail' | 'outlook' | 'google-docs' | 'notion' | 'google-calendar') => {
    if (busy) return
    setBusy(`authorize:${provider}`)
    setError(null)
    try { setAuthorization(await debug!.startAuthorization(provider)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开授权页面。') }
    finally { setBusy(null) }
  }

  if (!debug?.enabled) return <div className="page connector-debug-page"><PageHeader title="连接器调试台" description="此开发者工具未启用。" /><div className="connector-callout"><ShieldAlert />请使用本地开发环境变量启用调试台。</div></div>
  return <div className="page connector-debug-page">
    <PageHeader title="连接器调试台" description="邮件、日程与文档连接器同步运行面板。凭据和原始游标永不进入 renderer。" />
    <div className="connector-toolbar"><div className="connector-tabs" role="tablist">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} data-active={String(view === id)} onClick={() => setView(id)}><Icon aria-hidden="true" />{label}<span>{id === 'connections' ? connections.length : id === 'runs' ? status.runs.length : id === 'scopes' ? status.scopes.length : id === 'failures' ? failures.length : id === 'wiki' ? wikiConnections.length : id === 'calendar' ? calendarRecords.length : id === 'json' ? jsonRecords.length : mail.length}</span></button>)}</div><button className="icon-button" onClick={() => void refresh()} disabled={busy !== null} title="刷新" aria-label="刷新"><RefreshCw className={busy === 'refresh' ? 'spin' : undefined} /></button></div>
    {error ? <div className="connector-error" role="alert"><AlertTriangle />{error}<button className="icon-button" onClick={() => setError(null)} title="关闭" aria-label="关闭"><X /></button></div> : null}
    {authorization ? <div className="connector-authorization" data-state={authorization.status} role="status">{authorization.status === 'pending' ? <LoaderCircle className="spin" /> : authorization.status === 'connected' ? <Check /> : <AlertTriangle />}<div><strong>{providerLabel(authorization.provider)} 授权</strong><span>{authorization.status === 'pending' ? '请在浏览器中完成授权，EverRoom 正在等待结果。' : authorization.status === 'connected' ? '连接已创建，同步范围正在初始化。' : authorization.error ?? '授权未完成。'}</span></div><button className="icon-button" onClick={() => setAuthorization(null)} title="关闭" aria-label="关闭授权状态"><X /></button></div> : null}
    {loading ? <div className="connector-loading" role="status"><LoaderCircle className="spin" />正在读取连接器状态...</div> : null}
    {!loading && !status.enabled ? <div className="connector-callout"><ShieldAlert />连接器模块未配置。检查本地 Nango URL、密钥和 provider config。</div> : null}
    {view === 'connections' ? <ConnectionsView connections={connections} scopes={status.scopes} selectedId={selectedConnection} onSelect={setSelectedConnection} busy={busy} onAuthorize={(provider) => void startAuthorization(provider)} onSync={triggerConnection} onDisable={(id) => { if (window.confirm('停用后将停止该连接的自动同步。确认继续？')) void run(`disable:${id}`, () => debug.disableConnection(id)) }} onPurge={(id) => { if (window.confirm('确认清理该连接器的本地数据？此操作不可撤销。')) void run(`purge:${id}`, () => debug.purgeConnection(id)) }} /> : null}
    {view === 'runs' ? <RunsView runs={visibleRuns} scopes={status.scopes} connections={connections} busy={busy} onCancel={(id) => run(`cancel:${id}`, () => debug.cancelRun(id))} /> : null}
    {view === 'scopes' ? <ScopesView scopes={visibleScopes} connections={connections} busy={busy} onSync={triggerScope} /> : null}
    {view === 'mail' ? <MailView messages={mail} /> : null}
    {view === 'calendar' ? <CalendarView records={calendarRecords} connections={connections} scopes={status.scopes} /> : null}
    {view === 'json' ? <JsonView records={jsonRecords} connections={connections} /> : null}
    {view === 'failures' ? <FailuresView failures={failures} /> : null}
    {view === 'wiki' ? <WikiSourcesView connections={wikiConnections} scopes={status.scopes} runs={status.runs} busy={busy} onSync={(connection) => triggerConnection(connection, 'full')} /> : null}
    {debug.faultsEnabled ? <FaultBar busy={busy} onArm={(point) => run(`fault:${point}`, () => debug.armFault(point))} /> : null}
    {selected ? <div className="connector-selection"><strong>选中连接</strong><span>{selected.provider} · {selected.nangoConnectionId}</span><button className="icon-button" onClick={() => setSelectedConnection(null)} title="清除选择" aria-label="清除选择"><X /></button></div> : null}
  </div>
}

function providerLabel(provider: string): string { return provider === 'gmail' ? 'Gmail' : provider === 'outlook' ? 'Outlook' : provider === 'google-docs' ? 'Google Docs' : provider === 'google-calendar' ? 'Google Calendar' : 'Notion' }
function ConnectionsView({ connections, scopes, selectedId, onSelect, busy, onAuthorize, onSync, onDisable, onPurge }: { connections: ConnectorConnection[]; scopes: SyncScope[]; selectedId: string | null; onSelect: (id: string) => void; busy: string | null; onAuthorize: (provider: 'gmail' | 'outlook' | 'google-docs' | 'notion' | 'google-calendar') => void; onSync: (connection: ConnectorConnection, mode: SyncMode) => void; onDisable: (id: string) => void; onPurge: (id: string) => void }) {
  return <><div className="connector-section-actions"><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('gmail')}><Plus />连接 Gmail</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('outlook')}><KeyRound />连接 Outlook</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('google-calendar')}><CalendarDays />连接 Google Calendar</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('google-docs')}><FileText />连接 Google Docs</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('notion')}><FileText />连接 Notion</button></div><section className="connector-table-wrap"><div className="connector-table-head"><span>Provider / connection</span><span>Status</span><span>Updated</span><span>Actions</span></div>{connections.length === 0 ? <Empty icon={<Database />} title="尚未连接服务" detail="使用上方按钮通过 Nango 授权服务。" /> : connections.map((item) => { const hasScopes = scopes.some((scope) => scope.connectionId === item.id); return <div className="connector-table-row" key={item.id} data-selected={String(item.id === selectedId)}><button className="connector-primary-cell" onClick={() => onSelect(item.id)}><strong>{providerLabel(item.provider)}</strong><small>{item.nangoConnectionId}</small></button><span><i className={`connector-status-dot ${item.status}`} />{item.status === 'error' ? 'error / reauth' : item.status}</span><span>{date(item.updatedAt)}</span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'incremental')} title="运行增量同步" aria-label="运行增量同步"><Play /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'full')} title="运行全量同步" aria-label="运行全量同步"><RefreshCw /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'rebuild')} title="重建同步范围" aria-label="重建同步范围"><Wrench /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active'} onClick={() => onDisable(item.id)} title="停用连接" aria-label="停用连接"><CirclePause /></button><button className="icon-button danger" disabled={busy !== null} onClick={() => onPurge(item.id)} title="清理本地数据" aria-label="清理本地数据"><Trash2 /></button></div></div> })}</section></>
}
function RunsView({ runs, scopes, connections, busy, onCancel }: { runs: SyncRun[]; scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onCancel: (id: string) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head runs"><span>Connector / run</span><span>Mode</span><span>Progress</span><span>Status / error</span></div>{runs.length === 0 ? <Empty icon={<RefreshCw />} title="暂无同步运行" detail="手动触发或等待调度器创建运行。" /> : runs.map((run) => { const scope = scopes.find((item) => item.id === run.scopeId); const connection = scope ? connections.find((item) => item.id === scope.connectionId) : null; return <div className="connector-table-row runs" key={run.id}><span><strong>{connection ? providerLabel(connection.provider) : 'Unknown connector'}</strong><small>{connection?.nangoConnectionId ?? run.scopeId} · run {run.id.slice(0, 12)}</small></span><span>{run.mode}</span><span>{run.processed.toLocaleString()} processed · {run.failed} failed</span><span className="run-state"><i className={`connector-status-dot ${run.status}`} />{run.status}{run.error ? <details className="run-error" open><summary>错误详情</summary><code>{run.error}</code></details> : null}{run.status === 'running' ? <button className="icon-button" disabled={busy !== null} onClick={() => onCancel(run.id)} title="取消运行" aria-label="取消运行"><CirclePause /></button> : null}</span></div> })}</section> }
function ScopesView({ scopes, connections, busy, onSync }: { scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onSync: (scope: SyncScope, mode: SyncMode) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head scopes"><span>Connector / scope</span><span>State</span><span>Checkpoint</span><span>Lease / actions</span></div>{scopes.length === 0 ? <Empty icon={<ChevronRight />} title="暂无同步范围" detail="连接注册后，邮箱或文档范围会出现在这里。" /> : scopes.map((scope) => { const connection = connections.find((item) => item.id === scope.connectionId); return <div className="connector-table-row scopes" key={scope.id}><span><strong>{connection ? providerLabel(connection.provider) : 'Unknown connector'}</strong><small>{connection?.nangoConnectionId ?? scope.connectionId} · {scope.displayName}</small></span><span><i className={`connector-status-dot ${scope.state}`} />{scope.state}</span><span>{scope.deliveryCursor.toLocaleString()} · rev {scope.checkpointRevision}</span><span className="connector-scope-actions"><span>{scope.leaseOwner ? date(scope.leaseExpiresAt) : 'unleased'}</span><button className="icon-button" disabled={busy !== null || scope.state === 'running' || scope.state === 'disabled'} onClick={() => onSync(scope, scope.state === 'resync_required' ? 'rebuild' : 'incremental')} title={scope.state === 'resync_required' ? '重建范围' : '增量同步'} aria-label={scope.state === 'resync_required' ? '重建范围' : '增量同步'}>{scope.state === 'resync_required' ? <Wrench /> : <Play />}</button></span></div> })}</section> }
function MailView({ messages }: { messages: MailMessage[] }) { const [selected, setSelected] = useState<MailMessage | null>(null); return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head mail"><span>Subject / summary</span><span>Received</span><span>Flags</span><span>Provider id</span></div>{messages.length === 0 ? <Empty icon={<Mail />} title="没有统一邮件" detail="同步成功后，规范化邮件会显示在这里。" /> : messages.map((message) => <button type="button" className="connector-table-row mail connector-mail-row" key={message.id} onClick={() => setSelected(message)}><span><strong>{message.subject || '(无主题)'}</strong><small>{message.snippet || '无摘要'}</small></span><span>{date(message.receivedAt)}</span><span>{message.isRead ? 'read' : 'unread'} {message.isStarred ? ' · starred' : ''}{message.isDraft ? ' · draft' : ''}</span><span>{message.providerMessageId}</span></button>)}</section>{selected ? <aside className="connector-inspector" aria-label="邮件详情"><header><div><strong>{selected.subject || '(无主题)'}</strong><small>{date(selected.receivedAt)}</small></div><button className="icon-button" onClick={() => setSelected(null)} title="关闭详情" aria-label="关闭详情"><X /></button></header><dl><dt>Provider message</dt><dd>{selected.providerMessageId}</dd><dt>Thread</dt><dd>{selected.providerThreadId || '--'}</dd><dt>State</dt><dd>{selected.isTombstone ? 'tombstone' : selected.isDraft ? 'draft' : 'active'}</dd></dl><div className="connector-message-body">{selected.textBody || selected.snippet || '无可显示正文。'}</div></aside> : null}</div> }
function CalendarView({ records, connections, scopes }: { records: ConnectorJsonRecord<NormalizedCalendarEvent>[]; connections: ConnectorConnection[]; scopes: SyncScope[] }) {
  const [selected, setSelected] = useState<ConnectorJsonRecord<NormalizedCalendarEvent> | null>(null)
  const ordered = useMemo(() => [...records].sort((left, right) => left.data.startsAt.localeCompare(right.data.startsAt)), [records])
  return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head calendar"><span>Event</span><span>Schedule</span><span>Calendar</span><span>Status</span></div>{ordered.length === 0 ? <Empty icon={<CalendarDays />} title="没有日程数据" detail="连接 Google Calendar 并完成同步后，日程会显示在这里。" /> : ordered.map((record) => { const event = record.data; const connection = connections.find((item) => item.id === record.connectionId); const calendar = scopes.find((scope) => scope.connectionId === record.connectionId); return <button type="button" className="connector-table-row calendar connector-mail-row" key={`${record.connectionId}:${event.providerEventId}`} onClick={() => setSelected(record)}><span><strong>{event.title || '(无标题)'}</strong><small>{event.location || event.description || event.providerEventId}</small></span><span><strong>{date(event.startsAt)}</strong><small>至 {date(event.endsAt)}{event.timeZone ? ` · ${event.timeZone}` : ''}</small></span><span>{calendar?.displayName || providerLabel(connection?.provider ?? 'google-calendar')}<small>{connection?.nangoConnectionId}</small></span><span><i className={`connector-status-dot ${event.status === 'cancelled' ? 'error' : 'active'}`} />{event.status || 'confirmed'}</span></button> })}</section>{selected ? <CalendarInspector record={selected} onClose={() => setSelected(null)} /> : null}</div>
}
function CalendarInspector({ record, onClose }: { record: ConnectorJsonRecord<NormalizedCalendarEvent>; onClose: () => void }) {
  const event = record.data
  return <aside className="connector-inspector connector-calendar-inspector" aria-label="日程详情"><header><div><strong>{event.title || '(无标题)'}</strong><small>{date(event.startsAt)} - {date(event.endsAt)}</small></div><button className="icon-button" onClick={onClose} title="关闭详情" aria-label="关闭详情"><X /></button></header><div className="connector-calendar-facts">{event.location ? <span><MapPin />{event.location}</span> : null}<span><CalendarDays />{event.timeZone || '本地时区'}</span>{event.attendees?.length ? <span><Users />{event.attendees.length} 位参与者</span> : null}</div><dl><dt>Provider event</dt><dd>{event.providerEventId}</dd><dt>Status</dt><dd>{event.status || 'confirmed'}</dd><dt>Organizer</dt><dd>{event.organizer?.displayName || event.organizer?.address || '--'}</dd><dt>Connection</dt><dd>{record.connectionId}</dd></dl>{event.attendees?.length ? <div className="connector-calendar-attendees">{event.attendees.map((attendee, index) => <span key={`${attendee.address}:${index}`}><strong>{attendee.displayName || attendee.address}</strong><small>{attendee.address}</small></span>)}</div> : null}<div className="connector-message-body">{event.description || '无日程说明。'}</div></aside>
}
function JsonView({ records, connections }: { records: ConnectorJsonRecord[]; connections: ConnectorConnection[] }) {
  const [selected, setSelected] = useState<ConnectorJsonRecord | null>(null)
  return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head json"><span>Record</span><span>Type</span><span>Provider</span><span>Connection</span></div>{records.length === 0 ? <Empty icon={<Braces />} title="没有 JSON 数据" detail="邮件和日程连接器同步后，规范化 JSON 记录会显示在这里。" /> : records.map((record, index) => { const data = record.data as Record<string, unknown>; const title = String(data.subject ?? data.title ?? data.providerMessageId ?? data.providerEventId ?? `record-${index + 1}`); return <button type="button" className="connector-table-row json connector-mail-row" key={`${record.connectionId}:${record.type}:${index}`} onClick={() => setSelected(record)}><span><strong>{title}</strong><small>{String(data.providerMessageId ?? data.providerEventId ?? '')}</small></span><span>{record.type}</span><span>{providerLabel(record.provider)}</span><span>{connections.find((item) => item.id === record.connectionId)?.nangoConnectionId ?? record.connectionId}</span></button> })}</section>{selected ? <aside className="connector-inspector connector-json-inspector" aria-label="JSON 数据详情"><header><div><strong>{providerLabel(selected.provider)} / {selected.type}</strong><small>schemaVersion {selected.schemaVersion}</small></div><button className="icon-button" onClick={() => setSelected(null)} title="关闭详情" aria-label="关闭详情"><X /></button></header><pre>{JSON.stringify(selected, null, 2)}</pre></aside> : null}</div>
}
function FailuresView({ failures }: { failures: Array<{ id: string; scopeId: string | null; runId: string | null; category: string; message: string; createdAt: string }> }) { return <section className="connector-table-wrap"><div className="connector-table-head failures"><span>Failure</span><span>Category</span><span>Scope / run</span><span>Created</span></div>{failures.length === 0 ? <Empty icon={<Check />} title="没有失败记录" detail="连接器运行干净。" /> : failures.map((failure) => <div className="connector-table-row failures" key={failure.id}><span><strong>{failure.message}</strong><small>{failure.id}</small></span><span><i className="connector-status-dot error" />{failure.category}</span><span>{failure.scopeId || '--'} / {failure.runId || '--'}</span><span>{date(failure.createdAt)}</span></div>)}</section> }
function WikiSourcesView({ connections, scopes, runs, busy, onSync }: { connections: ConnectorConnection[]; scopes: SyncScope[]; runs: SyncRun[]; busy: string | null; onSync: (connection: ConnectorConnection) => void }) {
  const debug = api()!
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
    try { const result = await debug.documents(connectionId); setDocuments((current) => ({ ...current, [connectionId]: result })) }
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : '无法读取 Wiki 文档。') }
    finally { setLoadingDocuments(null) }
  }
  const openPreview = async (connectionId: string, documentId: string) => {
    setDocumentError(null)
    try { setPreview(await debug.document(connectionId, documentId)) }
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : '无法预览 Wiki 文档。') }
  }
  return <><section className="connector-table-wrap"><div className="connector-table-head"><span>Source / provider</span><span>Status</span><span>Documents</span><span>Actions</span></div>{connections.length === 0 ? <Empty icon={<FileText />} title="暂无 Wiki 文档源" detail="请切换到 Connections，使用 Nango 授权 Google Docs 或 Notion。" /> : connections.map((connection) => { const scopeIds = new Set(scopes.filter((scope) => scope.connectionId === connection.id).map((scope) => scope.id)); const latestRun = runs.find((run) => scopeIds.has(run.scopeId)); const open = expanded === connection.id; const items = documents[connection.id] ?? []; return <div className="connector-wiki-source" key={connection.id}><div className="connector-table-row"><button type="button" className="connector-primary-cell connector-wiki-toggle" onClick={() => void toggle(connection.id)} aria-expanded={open}>{open ? <ChevronDown /> : <ChevronRight />}<span><strong>{providerLabel(connection.provider)}</strong><small>{connection.nangoConnectionId} · {connection.id.slice(0, 12)}</small></span></button><span><i className={`connector-status-dot ${latestRun?.status ?? connection.status}`} />{latestRun?.status ?? connection.status}{latestRun?.error ? ` · ${latestRun.error}` : ''}</span><span>{latestRun ? `${latestRun.processed.toLocaleString()} documents` : '尚未同步'}<br /><small>{date(latestRun?.finishedAt ?? null)}</small></span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || connection.status !== 'active' || scopeIds.size === 0 || latestRun?.status === 'running'} onClick={() => onSync(connection)} title="重新同步并写入 LLM wiki" aria-label="重新同步并写入 LLM wiki"><RefreshCw /></button></div></div>{open ? <div className="connector-wiki-documents">{loadingDocuments === connection.id ? <span className="connector-wiki-state"><LoaderCircle className="spin" />正在读取文档...</span> : items.length === 0 ? <span className="connector-wiki-state"><FileText />尚无已同步文档</span> : items.map((document) => <button type="button" className="connector-wiki-document" key={document.id} onClick={() => void openPreview(connection.id, document.id)}><FileText /><span><strong>{document.title}</strong><small>{document.fileName} · {(document.size / 1024).toFixed(1)} KB · {date(document.modifiedAt)}</small></span><Eye aria-hidden="true" /></button>)}</div> : null}</div> })}</section>{documentError ? <div className="connector-error" role="alert"><AlertTriangle />{documentError}<button className="icon-button" onClick={() => setDocumentError(null)} title="关闭" aria-label="关闭"><X /></button></div> : null}{preview ? <MarkdownPreviewDialog preview={{ fileName: preview.title, relativePath: preview.fileName, modifiedAt: preview.modifiedAt, content: preview.content }} onClose={() => setPreview(null)} /> : null}</>
}
function FaultBar({ busy, onArm }: { busy: string | null; onArm: (point: string) => void }) { const [point, setPoint] = useState('before_page_commit'); return <div className="connector-faultbar"><Wrench /><label>Mock fault <select value={point} onChange={(event) => setPoint(event.target.value)}>{['before_page_commit', 'after_page_commit_before_cursor_cas', 'rate_limited', 'cursor_expired'].map((item) => <option key={item}>{item}</option>)}</select></label><button className="secondary-button" disabled={busy !== null} onClick={() => onArm(point)}><Wrench />Arm one-shot</button></div> }
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="connector-empty"><span>{icon}</span><strong>{title}</strong><small>{detail}</small></div> }
