import {
  Archive,
  CalendarDays,
  Database,
  FileText,
  History,
  LoaderCircle,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Unplug,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ConnectorDataRecord,
  ConnectorPromptProfile,
  ConnectorResourceType,
  ConnectorSyncJob,
  ConnectorSyncJobInput,
  ConnectorSyncRun,
} from '../../../../shared/connector-sync'
import type { OpenConnectorConnectionSummary } from '../../../../shared/open-connector'
import { ConnectorConsolePage } from './ConnectorConsolePage'
import { PageHeader } from './PageHeader'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import './ConnectorSyncPage.css'

type Tab = 'accounts' | 'jobs' | 'runs' | 'data' | 'developer'

interface JobDraft {
  id: string | null
  configVersion: number | null
  name: string
  service: string
  connectionName: string
  resourceType: ConnectorResourceType
  dataset: string
  query: string
  maxResults: number
  goal: string
  promptProfileId: string
  promptOverride: string
  allowedActions: string
  scheduleType: 'manual' | 'interval'
  intervalMinutes: number
  status: 'draft' | 'active'
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Database }> = [
  { id: 'accounts', label: 'surface:connectorSync.accounts', icon: Unplug },
  { id: 'jobs', label: 'surface:connectorSync.syncJobs', icon: RefreshCw },
  { id: 'runs', label: 'surface:connectorSync.runHistory', icon: History },
  { id: 'data', label: 'surface:connectorSync.localData', icon: Database },
  { id: 'developer', label: 'surface:connectorSync.developerTools', icon: Wrench },
]

function servicePreset(service: string, t?: Translate): Pick<JobDraft, 'resourceType' | 'dataset' | 'goal' | 'allowedActions'> {
  const goal = (key: string) => t?.(key) ?? key
  if (service === 'gmail') return {
    resourceType: 'email', dataset: 'emails',
    goal: goal('surface:connectorSync.defaultEmailGoal'),
    allowedActions: 'fetch_emails, get_message',
  }
  if (service === 'notion') return {
    resourceType: 'document', dataset: 'documents',
    goal: goal('surface:connectorSync.defaultDocumentGoal'),
    allowedActions: 'search_pages, get_page',
  }
  if (service === 'google_calendar') return {
    resourceType: 'calendar', dataset: 'calendar_events',
    goal: goal('surface:connectorSync.defaultCalendarGoal'),
    allowedActions: 'list_events, get_event',
  }
  return {
    resourceType: 'generic', dataset: 'records', goal: goal('surface:connectorSync.defaultGenericGoal'),
    allowedActions: '',
  }
}

function blankDraft(service = 'gmail', t?: Translate): JobDraft {
  const preset = servicePreset(service, t)
  return {
    id: null, configVersion: null, name: '', service, connectionName: '', ...preset,
    query: service === 'gmail' ? 'newer_than:1d' : '', maxResults: 50,
    promptProfileId: '', promptOverride: '', scheduleType: 'interval', intervalMinutes: 15, status: 'active',
  }
}

function draftFromJob(job: ConnectorSyncJob): JobDraft {
  return {
    id: job.id, configVersion: job.configVersion, name: job.name, service: job.service,
    connectionName: job.connectionName ?? '', resourceType: job.resourceType,
    dataset: job.dataset, query: typeof job.input.query === 'string' ? job.input.query : '',
    maxResults: typeof job.input.maxResults === 'number' ? job.input.maxResults : 50,
    goal: job.goal, promptProfileId: job.promptProfileId ?? '', promptOverride: job.promptOverride ?? '',
    allowedActions: job.allowedActions.join(', '), scheduleType: job.scheduleType,
    intervalMinutes: Math.max(Math.round(job.intervalMs / 60_000), 1),
    status: job.status === 'draft' ? 'draft' : 'active',
  }
}

function formatTime(value: string | null | undefined, locale: AppLocale): string {
  return value ? new Date(value).toLocaleString(locale, { hour12: false }) : '—'
}

function statusLabel(status: ConnectorSyncJob['status'], running: boolean, t: Translate): string {
  if (running) return t('surface:connectorSync.syncing')
  return t({
    draft: 'surface:connectorSync.statusDraft',
    active: 'surface:connectorSync.statusActive',
    paused: 'surface:connectorSync.statusPaused',
    archived: 'surface:connectorSync.statusArchived',
  }[status])
}

function runStatusLabel(status: ConnectorSyncRun['status'], t: Translate): string {
  return t({
    running: 'surface:connectorSync.runRunning',
    success: 'surface:connectorSync.runSuccess',
    failed: 'surface:connectorSync.runFailed',
    blocked_runtime: 'surface:connectorSync.runBlockedRuntime',
    needs_connection: 'surface:connectorSync.runNeedsConnection',
  }[status])
}

const CONNECTION_STATUS_KEYS: Record<string, string> = {
  active: 'surface:connectorSync.connected',
  error: 'surface:connectorSync.connectionError',
  disabled: 'surface:connectorSync.connectionDisabled',
  disconnected: 'surface:connectorSync.disconnected',
  pending: 'surface:connectorSync.connectionPending',
}

function connectionStatusKey(status: string): string {
  return CONNECTION_STATUS_KEYS[status] ?? status
}

function resourceIcon(type: ConnectorResourceType) {
  if (type === 'email') return <Mail aria-hidden="true" />
  if (type === 'document') return <FileText aria-hidden="true" />
  if (type === 'calendar') return <CalendarDays aria-hidden="true" />
  return <Database aria-hidden="true" />
}

export function ConnectorSyncPage() {
  const { locale, t } = useLocale()
  const [tab, setTab] = useState<Tab>('jobs')
  const [connections, setConnections] = useState<OpenConnectorConnectionSummary[]>([])
  const [profiles, setProfiles] = useState<ConnectorPromptProfile[]>([])
  const [jobs, setJobs] = useState<ConnectorSyncJob[]>([])
  const [runs, setRuns] = useState<Array<ConnectorSyncRun & { jobName: string }>>([])
  const [records, setRecords] = useState<ConnectorDataRecord[]>([])
  const [selectedRecord, setSelectedRecord] = useState<ConnectorDataRecord | null>(null)
  const [draft, setDraft] = useState<JobDraft | null>(null)
  const [query, setQuery] = useState('')
  const [dataType, setDataType] = useState<'' | ConnectorResourceType>('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!window.nxcore) return
    setError(null)
    try {
      const [nextJobs, nextProfiles, apps] = await Promise.all([
        window.nxcore.connectorSync.jobs(),
        window.nxcore.connectorSync.promptProfiles(),
        window.nxcore.openConnector.execute({ requestId: crypto.randomUUID(), command: { kind: 'apps' } }),
      ])
      const nextConnections = Array.isArray(apps.data) ? apps.data as OpenConnectorConnectionSummary[] : []
      setJobs(nextJobs)
      setProfiles(nextProfiles)
      setConnections(nextConnections)
      const runGroups = await Promise.all(nextJobs.map(async (job) =>
        (await window.nxcore!.connectorSync.runs(job.id)).map((run) => ({ ...run, jobName: job.name }))))
      setRuns(runGroups.flat().sort((left, right) => right.startedAt.localeCompare(left.startedAt)))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('surface:connectorSync.unableToLoadConnectorSyncSettings'))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadData = useCallback(async () => {
    if (!window.nxcore) return
    try {
      const dataset = dataType === 'email' ? 'emails'
        : dataType === 'document' ? 'documents'
          : dataType === 'calendar' ? 'calendar_events' : undefined
      setRecords(await window.nxcore.connectorSync.data({ dataset, query: query.trim() || undefined, limit: 100 }))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('surface:connectorSync.unableToLoadLocalData'))
    }
  }, [dataType, query, t])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (tab === 'data') void loadData() }, [loadData, tab])

  const services = useMemo(() => [...new Set([
    ...connections.map((item) => item.service), 'gmail', 'notion', 'google_calendar',
  ])], [connections])

  const saveDraft = async () => {
    if (!draft || !window.nxcore) return
    const allowedActions = draft.allowedActions.split(',').map((item) => item.trim()).filter(Boolean)
    if (!draft.name.trim() || allowedActions.length === 0) {
      setError(t('surface:connectorSync.enterAJobNameAndKeepAtLeast'))
      return
    }
    const input: ConnectorSyncJobInput = {
      name: draft.name.trim(), service: draft.service, dataset: draft.dataset,
      resourceType: draft.resourceType, connectionName: draft.connectionName || null,
      allowedActions,
      input: {
        ...(draft.query.trim() ? { query: draft.query.trim() } : {}),
        maxResults: draft.maxResults,
        ...(draft.resourceType === 'email' ? { detail: 'full' } : {}),
      },
      goal: draft.goal.trim(), promptProfileId: draft.promptProfileId || null,
      promptOverride: draft.promptOverride.trim() || null,
      scheduleType: draft.scheduleType, intervalMs: draft.intervalMinutes * 60_000,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      retryPolicy: { maxAttempts: 3, baseDelayMs: 30_000 }, status: draft.status,
    }
    setBusy('save')
    setError(null)
    try {
      if (draft.id && draft.configVersion) {
        await window.nxcore.connectorSync.updateJob(draft.id, { ...input, configVersion: draft.configVersion })
      } else {
        await window.nxcore.connectorSync.createJob(input)
      }
      setDraft(null)
      await reload()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('surface:connectorSync.unableToSaveTheSyncJob'))
    } finally {
      setBusy(null)
    }
  }

  const runJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try { await window.nxcore.connectorSync.runJob(job.id); await reload() }
    catch (runError) { setError(runError instanceof Error ? runError.message : t('surface:connectorSync.syncFailed')) }
    finally { setBusy(null) }
  }

  const toggleJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try {
      await window.nxcore.connectorSync.setJobPaused(job.id, job.status === 'active', job.configVersion)
      await reload()
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : t('surface:connectorSync.unableToUpdateJobStatus')) }
    finally { setBusy(null) }
  }

  return (
    <div className="page connector-sync-page">
      <PageHeader
        title={t('surface:connectorSync.connectors')}
        description={t('surface:connectorSync.manageConnectedAccountsAgentSyncJobsLocalData')}
        extraAction={<button type="button" className="secondary-button" onClick={() => void reload()}><RefreshCw />{t('surface:connectorSync.refresh')}</button>}
      />

      <nav className="connector-sync-tabs" aria-label={t('surface:connectorSync.connectorViews')}>
        {TABS.map((item) => <button key={item.id} type="button" data-active={String(tab === item.id)} onClick={() => setTab(item.id)}><item.icon />{t(item.label)}</button>)}
      </nav>

      {error ? <div className="connector-sync-alert" role="alert"><span>{error}</span><button type="button" title={t('surface:connectorSync.close')} onClick={() => setError(null)}><X /></button></div> : null}
      {loading ? <div className="connector-sync-loading"><LoaderCircle className="spin" />{t('surface:connectorSync.loadingSyncConfiguration')}</div> : null}

      {!loading && tab === 'accounts' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('surface:connectorSync.connectedAccounts')}</h2><p>{t('surface:connectorSync.credentialsAreManagedByOpenconnectorTheLocalDatabase')}</p></div><button type="button" className="secondary-button" onClick={() => void window.nxcore?.openConnector.openConsole()}>{t('surface:connectorSync.manageConnections')}</button></div>
          <div className="connector-account-list">
            {connections.length === 0 ? <div className="connector-sync-empty">{t('surface:connectorSync.noConnectedAccountsYet')}</div> : connections.map((connection) => (
              <div className="connector-account-row" key={`${connection.service}:${connection.connectionName ?? 'default'}`}>
                <div className="connector-resource-icon">{resourceIcon(servicePreset(connection.service).resourceType)}</div>
                <div><strong>{connection.displayName || connection.accountLabel || connection.connectionName || connection.service}</strong><span>{connection.service} · {connection.connectionName || t('surface:connectorSync.defaultConnection')}</span></div>
                <span className="connector-status-pill" data-status={connection.status}>{t(connectionStatusKey(connection.status))}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'jobs' ? (
        <section className="connector-sync-section">
              <div className="connector-section-heading"><div><h2>{t('surface:connectorSync.syncJobs')}</h2><p>{t('surface:connectorSync.jobConfigurationIsStoredLocallyAndRemainsActive')}</p></div><button type="button" className="primary-button" onClick={() => setDraft(blankDraft(services[0], t))}><Plus />{t('surface:connectorSync.newTask')}</button></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>{t('surface:connectorSync.tasks')}</th><th>{t('surface:connectorSync.account')}</th><th>{t('surface:connectorSync.schedule')}</th><th>{t('surface:connectorSync.lastResult')}</th><th>{t('surface:connectorSync.nextRun')}</th><th aria-label={t('surface:connectorSync.actions')} /></tr></thead><tbody>
            {jobs.filter((job) => job.status !== 'archived').map((job) => (
              <tr key={job.id}>
                <td><button type="button" className="connector-job-name" onClick={() => setDraft(draftFromJob(job))}>{resourceIcon(job.resourceType)}<span><strong>{job.name}</strong><small>{statusLabel(job.status, job.running, t)} · v{job.configVersion}</small></span></button></td>
                <td>{job.connectionName || t('surface:connectorSync.defaultConnection')}<small>{job.service}</small></td>
                <td>{job.scheduleType === 'manual' ? t('surface:connectorSync.manualOnly') : t('surface:connectorSync.everyMinutesMinutes', { minutes: Math.round(job.intervalMs / 60_000) })}</td>
                <td>{job.lastError ? <span className="connector-run-error">{t('surface:connectorSync.failed')} · {job.lastError}</span> : formatTime(job.lastSuccessAt, locale)}</td>
                <td>{formatTime(job.nextRunAt, locale)}</td>
                <td><div className="connector-row-actions"><button type="button" className="connector-run-now" title={t('surface:connectorSync.syncNow')} disabled={Boolean(busy) || job.running} onClick={() => void runJob(job)}>{busy === job.id ? <LoaderCircle className="spin" /> : <Play />}<span>{t('surface:connectorSync.syncNow')}</span></button><button type="button" title={t(job.status === 'active' ? 'surface:connectorSync.pause' : 'surface:connectorSync.resume')} disabled={Boolean(busy)} onClick={() => void toggleJob(job)}>{job.status === 'active' ? <Pause /> : <RefreshCw />}</button></div></td>
              </tr>
            ))}
          </tbody></table>{jobs.filter((job) => job.status !== 'archived').length === 0 ? <div className="connector-sync-empty">{t('surface:connectorSync.noSyncJobsYetCreateOneToStart')}</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'runs' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('surface:connectorSync.runHistory')}</h2><p>{t('surface:connectorSync.eachRunPinsTheJobVersionPromptVersion')}</p></div></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>{t('surface:connectorSync.tasks')}</th><th>{t('surface:connectorSync.status')}</th><th>{t('surface:connectorSync.started')}</th><th>{t('surface:connectorSync.found')}</th><th>{t('surface:connectorSync.added')}</th><th>{t('surface:connectorSync.updated')}</th><th>{t('surface:connectorSync.unchanged')}</th><th>{t('surface:connectorSync.quarantined')}</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{run.jobName}<small>{run.agentModel || 'direct'}</small></td><td><span className="connector-status-pill" data-status={run.status}>{runStatusLabel(run.status, t)}</span>{run.errorMessage ? <small className="connector-run-error">{run.errorMessage}</small> : null}</td><td>{formatTime(run.startedAt, locale)}</td><td>{run.discovered}</td><td>{run.inserted}</td><td>{run.updated}</td><td>{run.unchanged}</td><td>{run.quarantined}</td></tr>)}</tbody></table>{runs.length === 0 ? <div className="connector-sync-empty">{t('surface:connectorSync.noRunsYet')}</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'data' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('surface:connectorSync.localData')}</h2><p>{t('surface:connectorSync.chatAgentAndThisPageReadTheSame')}</p></div></div>
          <div className="connector-data-toolbar"><div className="connector-segmented"><button type="button" data-active={String(dataType === '')} onClick={() => setDataType('')}>{t('surface:connectorSync.all')}</button><button type="button" data-active={String(dataType === 'email')} onClick={() => setDataType('email')}>{t('surface:connectorSync.email')}</button><button type="button" data-active={String(dataType === 'document')} onClick={() => setDataType('document')}>{t('surface:connectorSync.documents')}</button><button type="button" data-active={String(dataType === 'calendar')} onClick={() => setDataType('calendar')}>{t('surface:connectorSync.calendar')}</button></div><form onSubmit={(event) => { event.preventDefault(); void loadData() }}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('surface:connectorSync.searchTitleBodySenderOrLocation')} /><button type="submit" className="secondary-button">{t('surface:connectorSync.search')}</button></form></div>
          <div className="connector-data-list">{records.map((record) => <button type="button" key={record.id} onClick={async () => setSelectedRecord(await window.nxcore!.connectorSync.record(record.id))}><span className="connector-resource-icon">{resourceIcon(record.resourceType ?? 'generic')}</span><span><strong>{record.title || record.sourceRecordId}</strong><small>{record.snippet || record.service}</small></span><time>{formatTime(record.syncedAt, locale)}</time></button>)}{records.length === 0 ? <div className="connector-sync-empty">{t('surface:connectorSync.noMatchingLocalData')}</div> : null}</div>
        </section>
      ) : null}

      {tab === 'developer' ? <ConnectorConsolePage embedded /> : null}

      {draft ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null) }}>
          <section className="connector-job-dialog" role="dialog" aria-modal="true" aria-label={t(draft.id ? 'surface:connectorSync.editSyncJob' : 'surface:connectorSync.newSyncJob')}>
            <header><div><Settings2 /><span><strong>{t(draft.id ? 'surface:connectorSync.editSyncJob' : 'surface:connectorSync.newSyncJob')}</strong><small>{t('surface:connectorSync.structuredSettingsAreSavedToTheLocalDatabase')}</small></span></div><button type="button" title={t('surface:connectorSync.close')} onClick={() => setDraft(null)}><X /></button></header>
            <div className="connector-job-form">
              <label><span>{t('surface:connectorSync.jobName')}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('surface:connectorSync.forExampleGmailMailFromTheLastDay')} /></label>
              <div className="connector-form-grid"><label><span>{t('surface:connectorSync.connectors')}</span><select value={draft.service} onChange={(event) => { const service = event.target.value; setDraft({ ...draft, service, connectionName: '', ...servicePreset(service, t), promptProfileId: '' }) }}>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label><label><span>{t('surface:connectorSync.authorizedAccount')}</span><select value={draft.connectionName} onChange={(event) => setDraft({ ...draft, connectionName: event.target.value })}><option value="">{t('surface:connectorSync.defaultConnection')}</option>{connections.filter((item) => item.service === draft.service && item.connectionName).map((item) => <option key={item.connectionName!} value={item.connectionName!}>{item.displayName || item.connectionName}</option>)}</select></label></div>
              <div className="connector-form-grid"><label><span>{t('surface:connectorSync.dataType')}</span><select value={draft.resourceType} onChange={(event) => setDraft({ ...draft, resourceType: event.target.value as ConnectorResourceType })}><option value="email">{t('surface:connectorSync.email')}</option><option value="document">{t('surface:connectorSync.documents')}</option><option value="calendar">{t('surface:connectorSync.calendar')}</option><option value="generic">{t('surface:connectorSync.general')}</option></select></label><label><span>{t('surface:connectorSync.dataset')}</span><input value={draft.dataset} onChange={(event) => setDraft({ ...draft, dataset: event.target.value })} /></label></div>
              <div className="connector-form-grid"><label><span>{t('surface:connectorSync.queryScope')}</span><input value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} placeholder={t('surface:connectorSync.forExampleNewerThan1d')} /></label><label><span>{t('surface:connectorSync.perRunLimit')}</span><input type="number" min={1} max={500} value={draft.maxResults} onChange={(event) => setDraft({ ...draft, maxResults: Number(event.target.value) })} /></label></div>
              <label><span>{t('surface:connectorSync.syncGoal')}</span><textarea value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
              <div className="connector-form-grid"><label><span>{t('surface:connectorSync.promptProfile')}</span><select value={draft.promptProfileId} onChange={(event) => setDraft({ ...draft, promptProfileId: event.target.value })}><option value="">{t('surface:connectorSync.automaticallyChooseAPublishedTemplate')}</option>{profiles.filter((profile) => profile.service === draft.service && profile.resourceType === draft.resourceType).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version}</option>)}</select></label><label><span>{t('surface:connectorSync.readOnlyActions')}</span><input value={draft.allowedActions} onChange={(event) => setDraft({ ...draft, allowedActions: event.target.value })} /></label></div>
              <label><span>{t('surface:connectorSync.cleanupPreferencesOptional')}</span><textarea value={draft.promptOverride} onChange={(event) => setDraft({ ...draft, promptOverride: event.target.value })} placeholder={t('surface:connectorSync.addCleanupPreferencesOnlyPermissionBoundariesCannotBe')} /></label>
              <div className="connector-form-grid"><label><span>{t('surface:connectorSync.scheduleMode')}</span><div className="connector-segmented"><button type="button" data-active={String(draft.scheduleType === 'manual')} onClick={() => setDraft({ ...draft, scheduleType: 'manual' })}>{t('surface:connectorSync.manualOnly')}</button><button type="button" data-active={String(draft.scheduleType === 'interval')} onClick={() => setDraft({ ...draft, scheduleType: 'interval' })}>{t('surface:connectorSync.fixedInterval')}</button></div></label><label><span>{t('surface:connectorSync.intervalInMinutes')}</span><input type="number" min={1} max={525600} disabled={draft.scheduleType === 'manual'} value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label></div>
              <label className="connector-toggle-label"><input type="checkbox" checked={draft.status === 'active'} onChange={(event) => setDraft({ ...draft, status: event.target.checked ? 'active' : 'draft' })} /><span>{t('surface:connectorSync.enableJobAfterSaving')}</span></label>
            </div>
            <footer>{draft.id ? <button type="button" className="danger-button" onClick={async () => { if (!window.nxcore || !draft.id || !draft.configVersion) return; await window.nxcore.connectorSync.archiveJob(draft.id, draft.configVersion); setDraft(null); await reload() }}><Archive />{t('surface:connectorSync.archive')}</button> : <span />}<div><button type="button" className="secondary-button" onClick={() => setDraft(null)}>{t('surface:connectorSync.cancel')}</button><button type="button" className="primary-button" disabled={busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? <LoaderCircle className="spin" /> : null}{t('surface:connectorSync.saveJob')}</button></div></footer>
          </section>
        </div>
      ) : null}

      {selectedRecord ? <aside className="connector-record-drawer"><header><strong>{selectedRecord.title || selectedRecord.sourceRecordId}</strong><button type="button" title={t('surface:connectorSync.close')} onClick={() => setSelectedRecord(null)}><X /></button></header><pre>{JSON.stringify(selectedRecord, null, 2)}</pre></aside> : null}
    </div>
  )
}
