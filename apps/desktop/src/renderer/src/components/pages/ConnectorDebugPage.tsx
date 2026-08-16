import { AlertTriangle, Check, ChevronRight, CirclePause, Database, KeyRound, LoaderCircle, Mail, Play, Plus, RefreshCw, ShieldAlert, Trash2, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConnectorAuthorizationAttempt, ConnectorConnection, ConnectorStatus, MailMessage, SyncMode, SyncRun, SyncScope } from '@nxcore/connector-contract'
import { PageHeader } from './PageHeader'
import './ConnectorDebugPage.css'

type View = 'connections' | 'runs' | 'scopes' | 'mail' | 'failures'
const VIEWS: Array<{ id: View; label: string; icon: typeof Database }> = [
  { id: 'connections', label: 'Connections', icon: Database }, { id: 'runs', label: 'Runs', icon: RefreshCw },
  { id: 'scopes', label: 'Scopes', icon: ChevronRight }, { id: 'mail', label: 'Mail', icon: Mail }, { id: 'failures', label: 'Failures', icon: AlertTriangle },
]
const INITIAL: ConnectorStatus = { enabled: false, connections: [], scopes: [], runs: [] }

function date(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--' }
function api() { return window.nxcore?.connectorDebug }

export function ConnectorDebugPage() {
  const [view, setView] = useState<View>('connections')
  const [status, setStatus] = useState<ConnectorStatus>(INITIAL)
  const [mail, setMail] = useState<MailMessage[]>([])
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
  const startAuthorization = async (provider: 'gmail' | 'outlook') => {
    if (busy) return
    setBusy(`authorize:${provider}`)
    setError(null)
    try { setAuthorization(await debug!.startAuthorization(provider)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开授权页面。') }
    finally { setBusy(null) }
  }

  if (!debug?.enabled) return <div className="page connector-debug-page"><PageHeader title="连接器调试台" description="此开发者工具未启用。" /><div className="connector-callout"><ShieldAlert />请使用本地开发环境变量启用调试台。</div></div>
  return <div className="page connector-debug-page">
    <PageHeader title="连接器调试台" description="Nango Gmail / Outlook 同步运行面板。凭据和原始游标永不进入 renderer。" />
    <div className="connector-toolbar"><div className="connector-tabs" role="tablist">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} data-active={String(view === id)} onClick={() => setView(id)}><Icon aria-hidden="true" />{label}<span>{id === 'connections' ? connections.length : id === 'runs' ? status.runs.length : id === 'scopes' ? status.scopes.length : id === 'failures' ? failures.length : mail.length}</span></button>)}</div><button className="icon-button" onClick={() => void refresh()} disabled={busy !== null} title="刷新" aria-label="刷新"><RefreshCw className={busy === 'refresh' ? 'spin' : undefined} /></button></div>
    {error ? <div className="connector-error" role="alert"><AlertTriangle />{error}<button className="icon-button" onClick={() => setError(null)} title="关闭" aria-label="关闭"><X /></button></div> : null}
    {authorization ? <div className="connector-authorization" data-state={authorization.status} role="status">{authorization.status === 'pending' ? <LoaderCircle className="spin" /> : authorization.status === 'connected' ? <Check /> : <AlertTriangle />}<div><strong>{authorization.provider === 'gmail' ? 'Gmail' : 'Outlook'} 授权</strong><span>{authorization.status === 'pending' ? '请在浏览器中完成授权，EverRoom 正在等待结果。' : authorization.status === 'connected' ? '连接已创建，同步范围正在初始化。' : authorization.error ?? '授权未完成。'}</span></div><button className="icon-button" onClick={() => setAuthorization(null)} title="关闭" aria-label="关闭授权状态"><X /></button></div> : null}
    {loading ? <div className="connector-loading" role="status"><LoaderCircle className="spin" />正在读取连接器状态...</div> : null}
    {!loading && !status.enabled ? <div className="connector-callout"><ShieldAlert />连接器模块未配置。检查本地 Nango URL、密钥和 provider config。</div> : null}
    {view === 'connections' ? <ConnectionsView connections={connections} scopes={status.scopes} selectedId={selectedConnection} onSelect={setSelectedConnection} busy={busy} onAuthorize={(provider) => void startAuthorization(provider)} onSync={triggerConnection} onDisable={(id) => { if (window.confirm('停用后将停止该连接的自动同步。确认继续？')) void run(`disable:${id}`, () => debug.disableConnection(id)) }} onPurge={(id) => { if (window.confirm('确认清理该连接器的本地数据？此操作不可撤销。')) void run(`purge:${id}`, () => debug.purgeConnection(id)) }} /> : null}
    {view === 'runs' ? <RunsView runs={visibleRuns} busy={busy} onCancel={(id) => run(`cancel:${id}`, () => debug.cancelRun(id))} /> : null}
    {view === 'scopes' ? <ScopesView scopes={visibleScopes} busy={busy} onSync={triggerScope} /> : null}
    {view === 'mail' ? <MailView messages={mail} /> : null}
    {view === 'failures' ? <FailuresView failures={failures} /> : null}
    {debug.faultsEnabled ? <FaultBar busy={busy} onArm={(point) => run(`fault:${point}`, () => debug.armFault(point))} /> : null}
    {selected ? <div className="connector-selection"><strong>选中连接</strong><span>{selected.provider} · {selected.nangoConnectionId}</span><button className="icon-button" onClick={() => setSelectedConnection(null)} title="清除选择" aria-label="清除选择"><X /></button></div> : null}
  </div>
}

function ConnectionsView({ connections, scopes, selectedId, onSelect, busy, onAuthorize, onSync, onDisable, onPurge }: { connections: ConnectorConnection[]; scopes: SyncScope[]; selectedId: string | null; onSelect: (id: string) => void; busy: string | null; onAuthorize: (provider: 'gmail' | 'outlook') => void; onSync: (connection: ConnectorConnection, mode: SyncMode) => void; onDisable: (id: string) => void; onPurge: (id: string) => void }) {
  return <><div className="connector-section-actions"><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('gmail')}><Plus />连接 Gmail</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => onAuthorize('outlook')}><KeyRound />连接 Outlook</button></div><section className="connector-table-wrap"><div className="connector-table-head"><span>Provider / connection</span><span>Status</span><span>Updated</span><span>Actions</span></div>{connections.length === 0 ? <Empty icon={<Database />} title="尚未连接邮箱" detail="使用上方按钮授权 Gmail 或 Outlook，EverRoom 会自动创建连接。" /> : connections.map((item) => { const hasScopes = scopes.some((scope) => scope.connectionId === item.id); return <div className="connector-table-row" key={item.id} data-selected={String(item.id === selectedId)}><button className="connector-primary-cell" onClick={() => onSelect(item.id)}><strong>{item.provider}</strong><small>{item.nangoConnectionId}</small></button><span><i className={`connector-status-dot ${item.status}`} />{item.status === 'error' ? 'error / reauth' : item.status}</span><span>{date(item.updatedAt)}</span><div className="connector-actions"><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'incremental')} title="运行增量同步" aria-label="运行增量同步"><Play /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'full')} title="运行全量同步" aria-label="运行全量同步"><RefreshCw /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active' || !hasScopes} onClick={() => onSync(item, 'rebuild')} title="重建同步范围" aria-label="重建同步范围"><Wrench /></button><button className="icon-button" disabled={busy !== null || item.status !== 'active'} onClick={() => onDisable(item.id)} title="停用连接" aria-label="停用连接"><CirclePause /></button><button className="icon-button danger" disabled={busy !== null} onClick={() => onPurge(item.id)} title="清理本地数据" aria-label="清理本地数据"><Trash2 /></button></div></div> })}</section></>
}
function RunsView({ runs, busy, onCancel }: { runs: SyncRun[]; busy: string | null; onCancel: (id: string) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head runs"><span>Run / scope</span><span>Mode</span><span>Progress</span><span>Status</span></div>{runs.length === 0 ? <Empty icon={<RefreshCw />} title="暂无同步运行" detail="手动触发或等待调度器创建运行。" /> : runs.map((run) => <div className="connector-table-row runs" key={run.id}><span><strong>{run.id.slice(0, 12)}</strong><small>{run.scopeId}</small></span><span>{run.mode}</span><span>{run.processed.toLocaleString()} processed · {run.failed} failed</span><span className="run-state"><i className={`connector-status-dot ${run.status}`} />{run.status}{run.status === 'running' ? <button className="icon-button" disabled={busy !== null} onClick={() => onCancel(run.id)} title="取消运行" aria-label="取消运行"><CirclePause /></button> : null}</span></div>)}</section> }
function ScopesView({ scopes, busy, onSync }: { scopes: SyncScope[]; busy: string | null; onSync: (scope: SyncScope, mode: SyncMode) => void }) { return <section className="connector-table-wrap"><div className="connector-table-head scopes"><span>Scope</span><span>State</span><span>Checkpoint</span><span>Lease / actions</span></div>{scopes.length === 0 ? <Empty icon={<ChevronRight />} title="暂无同步范围" detail="连接注册后，邮箱或文件夹范围会出现在这里。" /> : scopes.map((scope) => <div className="connector-table-row scopes" key={scope.id}><span><strong>{scope.displayName}</strong><small>{scope.providerScopeId}</small></span><span><i className={`connector-status-dot ${scope.state}`} />{scope.state}</span><span>{scope.deliveryCursor.toLocaleString()} · rev {scope.checkpointRevision}</span><span className="connector-scope-actions"><span>{scope.leaseOwner ? date(scope.leaseExpiresAt) : 'unleased'}</span><button className="icon-button" disabled={busy !== null || scope.state === 'running' || scope.state === 'disabled'} onClick={() => onSync(scope, scope.state === 'resync_required' ? 'rebuild' : 'incremental')} title={scope.state === 'resync_required' ? '重建范围' : '增量同步'} aria-label={scope.state === 'resync_required' ? '重建范围' : '增量同步'}>{scope.state === 'resync_required' ? <Wrench /> : <Play />}</button></span></div>)}</section> }
function MailView({ messages }: { messages: MailMessage[] }) { const [selected, setSelected] = useState<MailMessage | null>(null); return <div className="connector-mail-layout" data-inspector-open={String(Boolean(selected))}><section className="connector-table-wrap"><div className="connector-table-head mail"><span>Subject / summary</span><span>Received</span><span>Flags</span><span>Provider id</span></div>{messages.length === 0 ? <Empty icon={<Mail />} title="没有统一邮件" detail="同步成功后，规范化邮件会显示在这里。" /> : messages.map((message) => <button type="button" className="connector-table-row mail connector-mail-row" key={message.id} onClick={() => setSelected(message)}><span><strong>{message.subject || '(无主题)'}</strong><small>{message.snippet || '无摘要'}</small></span><span>{date(message.receivedAt)}</span><span>{message.isRead ? 'read' : 'unread'} {message.isStarred ? ' · starred' : ''}{message.isDraft ? ' · draft' : ''}</span><span>{message.providerMessageId}</span></button>)}</section>{selected ? <aside className="connector-inspector" aria-label="邮件详情"><header><div><strong>{selected.subject || '(无主题)'}</strong><small>{date(selected.receivedAt)}</small></div><button className="icon-button" onClick={() => setSelected(null)} title="关闭详情" aria-label="关闭详情"><X /></button></header><dl><dt>Provider message</dt><dd>{selected.providerMessageId}</dd><dt>Thread</dt><dd>{selected.providerThreadId || '--'}</dd><dt>State</dt><dd>{selected.isTombstone ? 'tombstone' : selected.isDraft ? 'draft' : 'active'}</dd></dl><div className="connector-message-body">{selected.textBody || selected.snippet || '无可显示正文。'}</div></aside> : null}</div> }
function FailuresView({ failures }: { failures: Array<{ id: string; scopeId: string | null; runId: string | null; category: string; message: string; createdAt: string }> }) { return <section className="connector-table-wrap"><div className="connector-table-head failures"><span>Failure</span><span>Category</span><span>Scope / run</span><span>Created</span></div>{failures.length === 0 ? <Empty icon={<Check />} title="没有失败记录" detail="连接器运行干净。" /> : failures.map((failure) => <div className="connector-table-row failures" key={failure.id}><span><strong>{failure.message}</strong><small>{failure.id}</small></span><span><i className="connector-status-dot error" />{failure.category}</span><span>{failure.scopeId || '--'} / {failure.runId || '--'}</span><span>{date(failure.createdAt)}</span></div>)}</section> }
function FaultBar({ busy, onArm }: { busy: string | null; onArm: (point: string) => void }) { const [point, setPoint] = useState('before_page_commit'); return <div className="connector-faultbar"><Wrench /><label>Mock fault <select value={point} onChange={(event) => setPoint(event.target.value)}>{['before_page_commit', 'after_page_commit_before_cursor_cas', 'rate_limited', 'cursor_expired'].map((item) => <option key={item}>{item}</option>)}</select></label><button className="secondary-button" disabled={busy !== null} onClick={() => onArm(point)}><Wrench />Arm one-shot</button></div> }
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="connector-empty"><span>{icon}</span><strong>{title}</strong><small>{detail}</small></div> }
