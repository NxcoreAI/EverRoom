import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, CirclePause, CirclePlay, Database, Eye, FileText, LoaderCircle, Mail, MapPin, Play, RefreshCw, Trash2, Users, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectorConnection, ConnectorJsonRecord, ConnectorStatus, MailMessage, NormalizedCalendarEvent, SyncMode, SyncRun, SyncScope, WikiDocumentPreview, WikiDocumentSummary } from '@nxcore/connector-contract'
import type { NangoRuntimeStatus } from '../../../../shared/sources'
import { useLocale, type AppLocale } from '@/i18n/LocaleContext'
import { MarkdownPreviewDialog } from './sources/MarkdownPreviewDialog'
import { SourceIcon } from './sources/SourceIcon'
import './ConnectorPage.css'

type View = 'connections' | 'runs' | 'scopes' | 'mail' | 'calendar' | 'wiki'
const VIEWS: Array<{ id: View; label: string; icon: typeof Database }> = [
  { id: 'connections', label: 'surface:connector.connectionsTab', icon: Database }, { id: 'runs', label: 'surface:connector.syncTab', icon: RefreshCw },
  { id: 'scopes', label: 'surface:connector.scopesTab', icon: ChevronRight }, { id: 'mail', label: 'surface:connector.mailTab', icon: Mail }, { id: 'calendar', label: 'surface:connector.calendarTab', icon: CalendarDays },
  { id: 'wiki', label: 'surface:connector.documentsTab', icon: FileText },
]
const INITIAL: ConnectorStatus = { enabled: false, connections: [], scopes: [], runs: [] }
const INITIAL_RUNTIME_STATUS: NangoRuntimeStatus = { state: 'starting', message: null }

const CONNECTOR_STATUS_KEYS: Record<string, string> = {
  active: 'surface:connector.active',
  disabled: 'surface:connector.statusDisabled',
  error: 'surface:connector.reauthorizationRequired',
  pending: 'surface:connector.statusPending',
  running: 'surface:connector.statusRunning',
  completed: 'surface:connector.statusCompleted',
  failed: 'surface:connector.statusFailed',
  cancelled: 'surface:connector.cancelled',
  idle: 'surface:connector.statusIdle',
  resync_required: 'surface:connector.statusResyncRequired',
  incremental: 'surface:connector.modeIncremental',
  full: 'surface:connector.modeFull',
  rebuild: 'surface:connector.modeRebuild',
  confirmed: 'surface:connector.confirmed',
}

function connectorStatusKey(value: string): string {
  return CONNECTOR_STATUS_KEYS[value] ?? value
}

function date(value: string | null, locale: AppLocale): string { return value ? new Date(value).toLocaleString(locale, { hour12: false }) : '--' }
function api() { return window.nxcore?.nangoConnector }

/** 数据源页内嵌的连接器管理区块（邮件/日程/文档连接器的授权与同步）。 */
export function ConnectorSection() {
  const { t } = useLocale()
  const [view, setView] = useState<View>('connections')
  const [status, setStatus] = useState<ConnectorStatus>(INITIAL)
  const [mail, setMail] = useState<MailMessage[]>([])
  const [calendarRecords, setCalendarRecords] = useState<ConnectorJsonRecord<NormalizedCalendarEvent>[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [runtimeStatus, setRuntimeStatus] = useState<NangoRuntimeStatus>(INITIAL_RUNTIME_STATUS)
  const connectors = api()

  const refresh = useCallback(async () => {
    if (!connectors) return
    try {
      setError(null)
      const [runtime, next] = await Promise.all([
        connectors.runtimeStatus(),
        connectors.status(),
      ])
      setRuntimeStatus(runtime)
      setStatus(next)
      if (view === 'mail') setMail(await connectors.mail({ connectionId: selectedConnection ?? undefined, limit: 100 }))
      if (view === 'calendar') {
        const ids = next.connections.filter((item) => item.provider === 'google-calendar' && (!selectedConnection || item.id === selectedConnection)).map((item) => item.id)
        setCalendarRecords((await Promise.all(ids.map((id) => connectors!.records(id, 'calendar')))).flat() as ConnectorJsonRecord<NormalizedCalendarEvent>[])
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('surface:connector.failedToLoadConnectorStatus')) }
    finally { setLoading(false) }
  }, [connectors, selectedConnection, t, view])

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
    catch (reason) { setError(reason instanceof Error ? reason.message : t('surface:connector.operationFailed')); return false }
    finally { setBusy(null) }
  }
  const triggerConnection = (connection: ConnectorConnection, mode: SyncMode) => {
    if (mode === 'rebuild' && !window.confirm(t('surface:connector.rebuildingRescansThisConnectionSSyncScopesContinue'))) return
    const scopes = status.scopes.filter((item) => item.connectionId === connection.id)
    void run(`${connection.id}:${mode}`, () => Promise.all(scopes.map((scope) => connectors!.triggerSync(scope.id, mode))))
  }
  const triggerScope = (scope: SyncScope, mode: SyncMode) => { if (mode !== 'rebuild' || window.confirm(t('surface:connector.rebuildName', { name: scope.displayName }))) void run(`${scope.id}:${mode}`, () => connectors!.triggerSync(scope.id, mode)) }

  if (!connectors) return null
  return <section className="connector-debug-page connector-section">
    <div className="connector-toolbar"><div className="connector-tabs" role="tablist">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} data-active={String(view === id)} onClick={() => setView(id)}><Icon aria-hidden="true" />{t(label)}<span>{id === 'connections' ? connections.length : id === 'runs' ? status.runs.length : id === 'scopes' ? status.scopes.length : id === 'wiki' ? wikiConnections.length : id === 'calendar' ? calendarRecords.length : mail.length}</span></button>)}</div><button className="icon-button" onClick={() => void refresh()} disabled={busy !== null} title={t('surface:connector.refresh')} aria-label={t('surface:connector.refresh')}><RefreshCw className={busy === 'refresh' ? 'spin' : undefined} /></button></div>
    {error ? <div className="connector-error" role="alert"><AlertTriangle />{error}<button className="icon-button" onClick={() => setError(null)} title={t('surface:connector.close')} aria-label={t('surface:connector.close')}><X /></button></div> : null}
    {runtimeStatus.state === 'error' ? <div className="connector-callout" role="alert"><AlertTriangle />{runtimeStatus.message ?? t('surface:connector.connectorServiceFailed')}</div> : null}
    {loading ? <div className="connector-loading" role="status"><LoaderCircle className="spin" />{t('surface:connector.loadingConnectorStatus')}</div> : null}
    {!loading && !status.enabled ? <div className="connector-callout"><AlertTriangle />{t('surface:connector.connectorsAreNotConfiguredConfigureNangoNxcoreNango')}</div> : null}
    {view === 'connections' ? <ConnectionsView connections={connections} scopes={status.scopes} selectedId={selectedConnection} onSelect={setSelectedConnection} busy={busy} onSync={triggerConnection} onDisable={(id) => { if (window.confirm(t('surface:connector.disablingThisConnectionStopsAutomaticSyncContinue'))) void run(`disable:${id}`, () => connectors.disableConnection(id)) }} onEnable={(id) => void run(`enable:${id}`, () => connectors.enableConnection(id))} onPurge={(id) => { if (window.confirm(t('surface:connector.clearThisConnectorSLocalDataThisCannot'))) void run(`purge:${id}`, () => connectors.purgeConnection(id)) }} /> : null}
    {view === 'runs' ? <RunsView runs={visibleRuns} scopes={status.scopes} connections={connections} busy={busy} onCancel={(id) => run(`cancel:${id}`, () => connectors.cancelRun(id))} /> : null}
    {view === 'scopes' ? <ScopesView scopes={visibleScopes} connections={connections} busy={busy} onSync={triggerScope} /> : null}
    {view === 'mail' ? <MailView messages={mail} /> : null}
    {view === 'calendar' ? <CalendarView records={calendarRecords} connections={connections} scopes={status.scopes} /> : null}
    {view === 'wiki' ? <WikiSourcesView connections={wikiConnections} scopes={status.scopes} runs={status.runs} busy={busy} onSync={(connection) => triggerConnection(connection, 'full')} /> : null}
    {selected ? <div className="connector-selection"><strong>{t('surface:connector.selectedConnection')}</strong><span>{selected.provider} · {selected.nangoConnectionId}</span><button className="icon-button" onClick={() => setSelectedConnection(null)} title={t('surface:connector.clearSelection')} aria-label={t('surface:connector.clearSelection')}><X /></button></div> : null}
    {runtimeStatus.state === 'starting' ? (
      <div className="connector-runtime-backdrop" role="presentation">
        <section className="connector-runtime-dialog" role="dialog" aria-modal="true" aria-labelledby="connector-runtime-title" aria-describedby="connector-runtime-description" aria-live="polite">
          <span className="connector-runtime-spinner" aria-hidden="true"><LoaderCircle /></span>
          <strong id="connector-runtime-title">{t('surface:connector.startingConnectorService')}</strong>
          <small id="connector-runtime-description">{t('surface:connector.startingConnectorServiceBody')}</small>
        </section>
      </div>
    ) : null}
  </section>
}

function providerLabel(provider: string): string { return provider === 'gmail' ? 'Gmail' : provider === 'outlook' ? 'Outlook' : provider === 'google-docs' ? 'Google Docs' : provider === 'google-calendar' ? 'Google Calendar' : 'Notion' }
function ProviderIdentity({ provider, detail }: { provider: ConnectorConnection['provider']; detail: string }) {
  return <span className="connector-provider-identity"><SourceIcon kind={provider} /><span><strong>{providerLabel(provider)}</strong><small>{detail}</small></span></span>
}
function ConnectionsView({ connections, scopes, selectedId, onSelect, busy, onSync, onDisable, onEnable, onPurge }: { connections: ConnectorConnection[]; scopes: SyncScope[]; selectedId: string | null; onSelect: (id: string) => void; busy: string | null; onSync: (connection: ConnectorConnection, mode: SyncMode) => void; onDisable: (id: string) => void; onEnable: (id: string) => void; onPurge: (id: string) => void }) {
  const { locale, t } = useLocale()
  return <section className="connector-table-wrap"><div className="connector-table-head"><span>{t('surface:connector.serviceConnection')}</span><span>{t('surface:connector.status')}</span><span>{t('surface:connector.updated')}</span><span>{t('surface:connector.actions')}</span></div>{connections.length === 0 ? <Empty icon={<Database />} title="surface:connector.noConnectedServices" detail="surface:connector.connectServiceHint" /> : connections.map((item) => { const hasScopes = scopes.some((scope) => scope.connectionId === item.id); return <div className="connector-table-row" key={item.id} data-selected={String(item.id === selectedId)}><button className="connector-primary-cell" onClick={() => onSelect(item.id)}><ProviderIdentity provider={item.provider} detail={item.nangoConnectionId} /></button><span><i className={`connector-status-dot ${item.status}`} />{t(connectorStatusKey(item.status))}</span><span>{date(item.updatedAt, locale)}</span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'incremental')} title={t('surface:connector.runIncrementalSync')} aria-label={t('surface:connector.runIncrementalSync')}><Play /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'full')} title={t('surface:connector.runFullSync')} aria-label={t('surface:connector.runFullSync')}><RefreshCw /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'rebuild')} title={t('surface:connector.rebuildSyncScopes')} aria-label={t('surface:connector.rebuildSyncScopes')}><Wrench /></button>{item.status === 'active' ? <button className="icon-button" disabled={busy !== null} onClick={() => onDisable(item.id)} title={t('surface:connector.disableConnection')} aria-label={t('surface:connector.disableConnection')}><CirclePause /></button> : <button className="icon-button" disabled={busy !== null} onClick={() => onEnable(item.id)} title="Enable connection" aria-label="Enable connection"><CirclePlay /></button>}<button className="icon-button danger" disabled={busy !== null} onClick={() => onPurge(item.id)} title={t('surface:connector.clearLocalData')} aria-label={t('surface:connector.clearLocalData')}><Trash2 /></button></div></div> })}</section>
}
function RunsView({ runs, scopes, connections, busy, onCancel }: { runs: SyncRun[]; scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onCancel: (id: string) => void }) { const { t } = useLocale(); return <section className="connector-table-wrap"><div className="connector-table-head runs"><span>{t('surface:connector.connectionRun')}</span><span>{t('surface:connector.mode')}</span><span>{t('surface:connector.progress')}</span><span>{t('surface:connector.statusError')}</span></div>{runs.length === 0 ? <Empty icon={<RefreshCw />} title="surface:connector.noSyncRuns" detail="surface:connector.noSyncRunsHint" /> : runs.map((run) => { const scope = scopes.find((item) => item.id === run.scopeId); const connection = scope ? connections.find((item) => item.id === scope.connectionId) : null; return <div className="connector-table-row runs" key={run.id}><span><strong>{connection ? providerLabel(connection.provider) : t('surface:connector.unknownConnection')}</strong><small>{connection?.nangoConnectionId ?? run.scopeId} · run {run.id.slice(0, 12)}</small></span><span>{t(connectorStatusKey(run.mode))}</span><span>{t('surface:connector.processedProcessedFailedFailed', { processed: run.processed.toLocaleString(), failed: run.failed })}</span><span className="run-state"><i className={`connector-status-dot ${run.status}`} />{t(connectorStatusKey(run.status))}{run.error ? <details className="run-error" open><summary>{t('surface:connector.errorDetails')}</summary><code>{run.error}</code></details> : null}{run.status === 'running' ? <button className="icon-button" disabled={busy !== null} onClick={() => onCancel(run.id)} title={t('surface:connector.cancelRun')} aria-label={t('surface:connector.cancelRun')}><CirclePause /></button> : null}</span></div> })}</section> }
function ScopesView({ scopes, connections, busy, onSync }: { scopes: SyncScope[]; connections: ConnectorConnection[]; busy: string | null; onSync: (scope: SyncScope, mode: SyncMode) => void }) { const { locale, t } = useLocale(); return <section className="connector-table-wrap"><div className="connector-table-head scopes"><span>{t('surface:connector.connectionScope')}</span><span>{t('surface:connector.status')}</span><span>{t('surface:connector.progress')}</span><span>{t('surface:connector.leaseActions')}</span></div>{scopes.length === 0 ? <Empty icon={<ChevronRight />} title="surface:connector.noSyncScopes" detail="surface:connector.noSyncScopesHint" /> : scopes.map((scope) => { const connection = connections.find((item) => item.id === scope.connectionId); return <div className="connector-table-row scopes" key={scope.id}><span><strong>{connection ? providerLabel(connection.provider) : t('surface:connector.unknownConnection')}</strong><small>{connection?.nangoConnectionId ?? scope.connectionId} · {scope.displayName}</small></span><span><i className={`connector-status-dot ${scope.state}`} />{t(connectorStatusKey(scope.state))}</span><span>{scope.deliveryCursor.toLocaleString(locale)} · rev {scope.checkpointRevision}</span><span className="connector-scope-actions"><span>{scope.leaseOwner ? date(scope.leaseExpiresAt, locale) : t('surface:connector.noLease')}</span><button className="icon-button" disabled={busy !== null || scope.state === 'running' || scope.state === 'disabled'} onClick={() => onSync(scope, scope.state === 'resync_required' ? 'rebuild' : 'incremental')} title={t(scope.state === 'resync_required' ? 'surface:connector.rebuildScope' : 'surface:connector.incrementalSync')} aria-label={t(scope.state === 'resync_required' ? 'surface:connector.rebuildScope' : 'surface:connector.incrementalSync')}>{scope.state === 'resync_required' ? <Wrench /> : <Play />}</button></span></div> })}</section> }
function MailView({ messages }: { messages: MailMessage[] }) { const { locale, t } = useLocale(); const [selected, setSelected] = useState<MailMessage | null>(null); return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head mail"><span>{t('surface:connector.subjectPreview')}</span><span>{t('surface:connector.received')}</span><span>{t('surface:connector.flags')}</span><span>{t('surface:connector.messageId')}</span></div>{messages.length === 0 ? <Empty icon={<Mail />} title="surface:connector.noMail" detail="surface:connector.noMailHint" /> : messages.map((message) => <button type="button" className="connector-table-row mail connector-mail-row" key={message.id} onClick={() => setSelected(message)}><span><strong>{message.subject || t('surface:connector.noSubject')}</strong><small>{message.snippet || t('surface:connector.noPreview')}</small></span><span>{date(message.receivedAt, locale)}</span><span>{t(message.isRead ? 'surface:connector.read' : 'surface:connector.unread')}{message.isStarred ? ` · ${t('surface:connector.starred')}` : ''}{message.isDraft ? ` · ${t('surface:connector.draft')}` : ''}</span><span>{message.providerMessageId}</span></button>)}</section>{selected ? <aside className="connector-inspector" aria-label={t('surface:connector.emailDetails')}><header><div><strong>{selected.subject || t('surface:connector.noSubject')}</strong><small>{date(selected.receivedAt, locale)}</small></div><button className="icon-button" onClick={() => setSelected(null)} title={t('surface:connector.closeDetails')} aria-label={t('surface:connector.closeDetails')}><X /></button></header><dl><dt>{t('surface:connector.messageId')}</dt><dd>{selected.providerMessageId}</dd><dt>{t('surface:connector.conversations')}</dt><dd>{selected.providerThreadId || '--'}</dd><dt>{t('surface:connector.status')}</dt><dd>{t(selected.isTombstone ? 'surface:connector.deleted' : selected.isDraft ? 'surface:connector.draft' : 'surface:connector.activeRecord')}</dd></dl><div className="connector-message-body">{selected.textBody || selected.snippet || t('surface:connector.noMessageBodyToDisplay')}</div></aside> : null}</div> }
function CalendarView({ records, connections, scopes }: { records: ConnectorJsonRecord<NormalizedCalendarEvent>[]; connections: ConnectorConnection[]; scopes: SyncScope[] }) {
  const { locale, t } = useLocale()
  const [selected, setSelected] = useState<ConnectorJsonRecord<NormalizedCalendarEvent> | null>(null)
  const ordered = useMemo(() => [...records].sort((left, right) => left.data.startsAt.localeCompare(right.data.startsAt)), [records])
  return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head calendar"><span>{t('surface:connector.calendar')}</span><span>{t('surface:connector.time')}</span><span>{t('surface:connector.calendarName')}</span><span>{t('surface:connector.status')}</span></div>{ordered.length === 0 ? <Empty icon={<CalendarDays />} title="surface:connector.noCalendarData" detail="surface:connector.noCalendarDataHint" /> : ordered.map((record) => { const event = record.data; const connection = connections.find((item) => item.id === record.connectionId); const calendar = scopes.find((scope) => scope.connectionId === record.connectionId); return <button type="button" className="connector-table-row calendar connector-mail-row" key={`${record.connectionId}:${event.providerEventId}`} onClick={() => setSelected(record)}><span><strong>{event.title || t('surface:connector.untitled')}</strong><small>{event.location || event.description || event.providerEventId}</small></span><span><strong>{date(event.startsAt, locale)}</strong><small>{t('surface:connector.toTime', { time: date(event.endsAt, locale) })}{event.timeZone ? ` · ${event.timeZone}` : ''}</small></span><span>{calendar?.displayName || providerLabel(connection?.provider ?? 'google-calendar')}<small>{connection?.nangoConnectionId}</small></span><span><i className={`connector-status-dot ${event.status === 'cancelled' ? 'error' : 'active'}`} />{t(event.status === 'cancelled' ? 'surface:connector.cancelled' : 'surface:connector.confirmed')}</span></button> })}</section>{selected ? <CalendarInspector record={selected} onClose={() => setSelected(null)} /> : null}</div>
}
function CalendarInspector({ record, onClose }: { record: ConnectorJsonRecord<NormalizedCalendarEvent>; onClose: () => void }) {
  const { locale, t } = useLocale()
  const event = record.data
  return <aside className="connector-inspector connector-calendar-inspector" aria-label={t('surface:connector.eventDetails')}><header><div><strong>{event.title || t('surface:connector.untitled')}</strong><small>{date(event.startsAt, locale)} - {date(event.endsAt, locale)}</small></div><button className="icon-button" onClick={onClose} title={t('surface:connector.closeDetails')} aria-label={t('surface:connector.closeDetails')}><X /></button></header><div className="connector-calendar-facts">{event.location ? <span><MapPin />{event.location}</span> : null}<span><CalendarDays />{event.timeZone || t('surface:connector.localTimeZone')}</span>{event.attendees?.length ? <span><Users />{t('surface:connector.countParticipants', { count: event.attendees.length })}</span> : null}</div><dl><dt>{t('surface:connector.eventId')}</dt><dd>{event.providerEventId}</dd><dt>{t('surface:connector.status')}</dt><dd>{t(connectorStatusKey(event.status || 'confirmed'))}</dd><dt>{t('surface:connector.organizer')}</dt><dd>{event.organizer?.displayName || event.organizer?.address || '--'}</dd><dt>{t('surface:connector.connections')}</dt><dd>{record.connectionId}</dd></dl>{event.attendees?.length ? <div className="connector-calendar-attendees">{event.attendees.map((attendee, index) => <span key={`${attendee.address}:${index}`}><strong>{attendee.displayName || attendee.address}</strong><small>{attendee.address}</small></span>)}</div> : null}<div className="connector-message-body">{event.description || t('surface:connector.noEventDescription')}</div></aside>
}
function WikiSourcesView({ connections, scopes, runs, busy, onSync }: { connections: ConnectorConnection[]; scopes: SyncScope[]; runs: SyncRun[]; busy: string | null; onSync: (connection: ConnectorConnection) => void }) {
  const { locale, t } = useLocale()
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
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : t('surface:connector.failedToLoadDocuments')) }
    finally { setLoadingDocuments(null) }
  }
  const openPreview = async (connectionId: string, documentId: string) => {
    setDocumentError(null)
    try { setPreview(await connectors.document(connectionId, documentId)) }
    catch (reason) { setDocumentError(reason instanceof Error ? reason.message : t('surface:connector.failedToPreviewTheDocument')) }
  }
  return <><section className="connector-table-wrap"><div className="connector-table-head"><span>{t('surface:connector.sourceService')}</span><span>{t('surface:connector.status')}</span><span>{t('surface:connector.documents')}</span><span>{t('surface:connector.actions')}</span></div>{connections.length === 0 ? <Empty icon={<FileText />} title="surface:connector.noDocumentSources" detail="surface:connector.noDocumentSourcesHint" /> : connections.map((connection) => { const scopeIds = new Set(scopes.filter((scope) => scope.connectionId === connection.id).map((scope) => scope.id)); const latestRun = runs.find((run) => scopeIds.has(run.scopeId)); const open = expanded === connection.id; const items = documents[connection.id] ?? []; return <div className="connector-wiki-source" key={connection.id}><div className="connector-table-row"><button type="button" className="connector-primary-cell connector-wiki-toggle" onClick={() => void toggle(connection.id)} aria-expanded={open}>{open ? <ChevronDown /> : <ChevronRight />}<ProviderIdentity provider={connection.provider} detail={`${connection.nangoConnectionId} · ${connection.id.slice(0, 12)}`} /></button><span><i className={`connector-status-dot ${latestRun?.status ?? connection.status}`} />{t(connectorStatusKey(latestRun?.status ?? connection.status))}{latestRun?.error ? ` · ${latestRun.error}` : ''}</span><span>{latestRun ? t('surface:connector.countDocuments', { count: latestRun.processed.toLocaleString(locale) }) : t('surface:connector.notSyncedYet')}<br /><small>{date(latestRun?.finishedAt ?? null, locale)}</small></span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || connection.status !== 'active' || scopeIds.size === 0 || latestRun?.status === 'running'} onClick={() => onSync(connection)} title={t('surface:connector.syncAgain')} aria-label={t('surface:connector.syncAgain')}><RefreshCw /></button></div></div>{open ? <div className="connector-wiki-documents">{loadingDocuments === connection.id ? <span className="connector-wiki-state"><LoaderCircle className="spin" />{t('surface:connector.loadingDocuments')}</span> : items.length === 0 ? <span className="connector-wiki-state"><FileText />{t('surface:connector.noSyncedDocumentsYet')}</span> : items.map((document) => <button type="button" className="connector-wiki-document" key={document.id} onClick={() => void openPreview(connection.id, document.id)}><FileText /><span><strong>{document.title}</strong><small>{document.fileName} · {(document.size / 1024).toFixed(1)} KB · {date(document.modifiedAt, locale)}</small></span><Eye aria-hidden="true" /></button>)}</div> : null}</div> })}</section>{documentError ? <div className="connector-error" role="alert"><AlertTriangle />{documentError}<button className="icon-button" onClick={() => setDocumentError(null)} title={t('surface:connector.close')} aria-label={t('surface:connector.close')}><X /></button></div> : null}{preview ? <MarkdownPreviewDialog preview={{ fileName: preview.title, relativePath: preview.fileName, modifiedAt: preview.modifiedAt, content: preview.content }} onClose={() => setPreview(null)} /> : null}</>
}
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { const { t } = useLocale(); return <div className="connector-empty"><span>{icon}</span><strong>{t(title)}</strong><small>{t(detail)}</small></div> }
