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
  { id: 'accounts', label: '连接账号', icon: Unplug },
  { id: 'jobs', label: '同步任务', icon: RefreshCw },
  { id: 'runs', label: '运行记录', icon: History },
  { id: 'data', label: '本地数据', icon: Database },
  { id: 'developer', label: '开发工具', icon: Wrench },
]

function servicePreset(service: string): Pick<JobDraft, 'resourceType' | 'dataset' | 'goal' | 'allowedActions'> {
  if (service === 'gmail') return {
    resourceType: 'email', dataset: 'emails',
    goal: '同步指定范围内的完整邮件并标准化发件人、主题、正文、标签和时间',
    allowedActions: 'fetch_emails, get_message',
  }
  if (service === 'notion') return {
    resourceType: 'document', dataset: 'documents',
    goal: '同步可访问的文档并标准化标题、正文、所有者和来源链接',
    allowedActions: 'search_pages, get_page',
  }
  if (service === 'google_calendar') return {
    resourceType: 'calendar', dataset: 'calendar_events',
    goal: '同步指定时间窗口内的日程并标准化参与者、起止时间、地点和状态',
    allowedActions: 'list_events, get_event',
  }
  return {
    resourceType: 'generic', dataset: 'records', goal: '同步已授权连接器中的数据到本地数据库',
    allowedActions: '',
  }
}

function blankDraft(service = 'gmail'): JobDraft {
  const preset = servicePreset(service)
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
  if (running) return t('同步中')
  return t({ draft: '草稿', active: '正常', paused: '已暂停', archived: '已归档' }[status])
}

function runStatusLabel(status: ConnectorSyncRun['status'], t: Translate): string {
  return t({
    running: '运行中',
    success: '成功',
    failed: '失败',
    blocked_runtime: '运行环境受阻',
    needs_connection: '需要连接账号',
  }[status])
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
      setError(loadError instanceof Error ? loadError.message : t('无法读取连接器同步配置。'))
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
      setError(loadError instanceof Error ? loadError.message : t('无法读取本地数据。'))
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
      setError(t('请填写任务名称，并至少保留一个只读 Action。'))
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
      setError(saveError instanceof Error ? saveError.message : t('保存同步任务失败。'))
    } finally {
      setBusy(null)
    }
  }

  const runJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try { await window.nxcore.connectorSync.runJob(job.id); await reload() }
    catch (runError) { setError(runError instanceof Error ? runError.message : t('同步失败。')) }
    finally { setBusy(null) }
  }

  const toggleJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try {
      await window.nxcore.connectorSync.setJobPaused(job.id, job.status === 'active', job.configVersion)
      await reload()
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : t('更新任务状态失败。')) }
    finally { setBusy(null) }
  }

  return (
    <div className="page connector-sync-page">
      <PageHeader
        title={t('连接器')}
        description={t('管理授权账号、Agent 同步任务、本地数据与运行状态')}
        extraAction={<button type="button" className="secondary-button" onClick={() => void reload()}><RefreshCw />{t('刷新')}</button>}
      />

      <nav className="connector-sync-tabs" aria-label={t('连接器视图')}>
        {TABS.map((item) => <button key={item.id} type="button" data-active={String(tab === item.id)} onClick={() => setTab(item.id)}><item.icon />{t(item.label)}</button>)}
      </nav>

      {error ? <div className="connector-sync-alert" role="alert"><span>{error}</span><button type="button" title={t('关闭')} onClick={() => setError(null)}><X /></button></div> : null}
      {loading ? <div className="connector-sync-loading"><LoaderCircle className="spin" />{t('正在读取同步配置')}</div> : null}

      {!loading && tab === 'accounts' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('已授权账号')}</h2><p>{t('凭据由 OpenConnector 管理，本地数据库只保存连接引用。')}</p></div><button type="button" className="secondary-button" onClick={() => void window.nxcore?.openConnector.openConsole()}>{t('管理授权')}</button></div>
          <div className="connector-account-list">
            {connections.length === 0 ? <div className="connector-sync-empty">{t('还没有已授权账号。')}</div> : connections.map((connection) => (
              <div className="connector-account-row" key={`${connection.service}:${connection.connectionName ?? 'default'}`}>
                <div className="connector-resource-icon">{resourceIcon(servicePreset(connection.service).resourceType)}</div>
                <div><strong>{connection.displayName || connection.accountLabel || connection.connectionName || connection.service}</strong><span>{connection.service} · {connection.connectionName || t('默认连接')}</span></div>
                <span className="connector-status-pill" data-status={connection.status}>{t(connection.status === 'active' ? '已连接' : connection.status)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'jobs' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('同步任务')}</h2><p>{t('任务配置保存在本地数据库，Gateway 重启后继续生效。')}</p></div><button type="button" className="primary-button" onClick={() => setDraft(blankDraft(services[0]))}><Plus />{t('新建任务')}</button></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>{t('任务')}</th><th>{t('账号')}</th><th>{t('计划')}</th><th>{t('上次结果')}</th><th>{t('下次运行')}</th><th aria-label={t('操作')} /></tr></thead><tbody>
            {jobs.filter((job) => job.status !== 'archived').map((job) => (
              <tr key={job.id}>
                <td><button type="button" className="connector-job-name" onClick={() => setDraft(draftFromJob(job))}>{resourceIcon(job.resourceType)}<span><strong>{job.name}</strong><small>{statusLabel(job.status, job.running, t)} · v{job.configVersion}</small></span></button></td>
                <td>{job.connectionName || t('默认连接')}<small>{job.service}</small></td>
                <td>{job.scheduleType === 'manual' ? t('仅手动') : t('每 {minutes} 分钟', { minutes: Math.round(job.intervalMs / 60_000) })}</td>
                <td>{job.lastError ? <span className="connector-run-error">{t('失败')} · {job.lastError}</span> : formatTime(job.lastSuccessAt, locale)}</td>
                <td>{formatTime(job.nextRunAt, locale)}</td>
                <td><div className="connector-row-actions"><button type="button" className="connector-run-now" title={t('立即同步')} disabled={Boolean(busy) || job.running} onClick={() => void runJob(job)}>{busy === job.id ? <LoaderCircle className="spin" /> : <Play />}<span>{t('立即同步')}</span></button><button type="button" title={t(job.status === 'active' ? '暂停' : '恢复')} disabled={Boolean(busy)} onClick={() => void toggleJob(job)}>{job.status === 'active' ? <Pause /> : <RefreshCw />}</button></div></td>
              </tr>
            ))}
          </tbody></table>{jobs.filter((job) => job.status !== 'archived').length === 0 ? <div className="connector-sync-empty">{t('还没有同步任务，创建一个任务开始同步。')}</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'runs' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('运行记录')}</h2><p>{t('每次运行都固定任务版本、Prompt 版本、指标和检查点。')}</p></div></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>{t('任务')}</th><th>{t('状态')}</th><th>{t('开始时间')}</th><th>{t('发现')}</th><th>{t('新增')}</th><th>{t('更新')}</th><th>{t('未变化')}</th><th>{t('隔离')}</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{run.jobName}<small>{run.agentModel || 'direct'}</small></td><td><span className="connector-status-pill" data-status={run.status}>{runStatusLabel(run.status, t)}</span>{run.errorMessage ? <small className="connector-run-error">{run.errorMessage}</small> : null}</td><td>{formatTime(run.startedAt, locale)}</td><td>{run.discovered}</td><td>{run.inserted}</td><td>{run.updated}</td><td>{run.unchanged}</td><td>{run.quarantined}</td></tr>)}</tbody></table>{runs.length === 0 ? <div className="connector-sync-empty">{t('暂无运行记录。')}</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'data' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>{t('本地数据')}</h2><p>{t('聊天 Agent 与此页面读取同一套 owner 隔离的领域数据。')}</p></div></div>
          <div className="connector-data-toolbar"><div className="connector-segmented"><button type="button" data-active={String(dataType === '')} onClick={() => setDataType('')}>{t('全部')}</button><button type="button" data-active={String(dataType === 'email')} onClick={() => setDataType('email')}>{t('邮件')}</button><button type="button" data-active={String(dataType === 'document')} onClick={() => setDataType('document')}>{t('文档')}</button><button type="button" data-active={String(dataType === 'calendar')} onClick={() => setDataType('calendar')}>{t('日程')}</button></div><form onSubmit={(event) => { event.preventDefault(); void loadData() }}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索标题、正文、发件人或地点')} /><button type="submit" className="secondary-button">{t('搜索')}</button></form></div>
          <div className="connector-data-list">{records.map((record) => <button type="button" key={record.id} onClick={async () => setSelectedRecord(await window.nxcore!.connectorSync.record(record.id))}><span className="connector-resource-icon">{resourceIcon(record.resourceType ?? 'generic')}</span><span><strong>{record.title || record.sourceRecordId}</strong><small>{record.snippet || record.service}</small></span><time>{formatTime(record.syncedAt, locale)}</time></button>)}{records.length === 0 ? <div className="connector-sync-empty">{t('没有匹配的本地数据。')}</div> : null}</div>
        </section>
      ) : null}

      {tab === 'developer' ? <ConnectorConsolePage embedded /> : null}

      {draft ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null) }}>
          <section className="connector-job-dialog" role="dialog" aria-modal="true" aria-label={t(draft.id ? '编辑同步任务' : '新建同步任务')}>
            <header><div><Settings2 /><span><strong>{t(draft.id ? '编辑同步任务' : '新建同步任务')}</strong><small>{t('结构化配置会保存到本地数据库')}</small></span></div><button type="button" title={t('关闭')} onClick={() => setDraft(null)}><X /></button></header>
            <div className="connector-job-form">
              <label><span>{t('任务名称')}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('例如：Gmail 最近一天邮件')} /></label>
              <div className="connector-form-grid"><label><span>{t('连接器')}</span><select value={draft.service} onChange={(event) => { const service = event.target.value; setDraft({ ...draft, service, connectionName: '', ...servicePreset(service), promptProfileId: '' }) }}>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label><label><span>{t('授权账号')}</span><select value={draft.connectionName} onChange={(event) => setDraft({ ...draft, connectionName: event.target.value })}><option value="">{t('默认连接')}</option>{connections.filter((item) => item.service === draft.service && item.connectionName).map((item) => <option key={item.connectionName!} value={item.connectionName!}>{item.displayName || item.connectionName}</option>)}</select></label></div>
              <div className="connector-form-grid"><label><span>{t('数据类型')}</span><select value={draft.resourceType} onChange={(event) => setDraft({ ...draft, resourceType: event.target.value as ConnectorResourceType })}><option value="email">{t('邮件')}</option><option value="document">{t('文档')}</option><option value="calendar">{t('日程')}</option><option value="generic">{t('通用')}</option></select></label><label><span>{t('数据集')}</span><input value={draft.dataset} onChange={(event) => setDraft({ ...draft, dataset: event.target.value })} /></label></div>
              <div className="connector-form-grid"><label><span>{t('查询范围')}</span><input value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} placeholder={t('例如 newer_than:1d')} /></label><label><span>{t('单次上限')}</span><input type="number" min={1} max={500} value={draft.maxResults} onChange={(event) => setDraft({ ...draft, maxResults: Number(event.target.value) })} /></label></div>
              <label><span>{t('同步目标')}</span><textarea value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
              <div className="connector-form-grid"><label><span>Prompt Profile</span><select value={draft.promptProfileId} onChange={(event) => setDraft({ ...draft, promptProfileId: event.target.value })}><option value="">{t('自动选择已发布模板')}</option>{profiles.filter((profile) => profile.service === draft.service && profile.resourceType === draft.resourceType).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version}</option>)}</select></label><label><span>{t('只读 Action')}</span><input value={draft.allowedActions} onChange={(event) => setDraft({ ...draft, allowedActions: event.target.value })} /></label></div>
              <label><span>{t('清洗偏好（可选）')}</span><textarea value={draft.promptOverride} onChange={(event) => setDraft({ ...draft, promptOverride: event.target.value })} placeholder={t('只能补充清洗偏好，不能改变权限边界')} /></label>
              <div className="connector-form-grid"><label><span>{t('运行方式')}</span><div className="connector-segmented"><button type="button" data-active={String(draft.scheduleType === 'manual')} onClick={() => setDraft({ ...draft, scheduleType: 'manual' })}>{t('仅手动')}</button><button type="button" data-active={String(draft.scheduleType === 'interval')} onClick={() => setDraft({ ...draft, scheduleType: 'interval' })}>{t('固定间隔')}</button></div></label><label><span>{t('间隔分钟')}</span><input type="number" min={1} max={525600} disabled={draft.scheduleType === 'manual'} value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label></div>
              <label className="connector-toggle-label"><input type="checkbox" checked={draft.status === 'active'} onChange={(event) => setDraft({ ...draft, status: event.target.checked ? 'active' : 'draft' })} /><span>{t('保存后启用任务')}</span></label>
            </div>
            <footer>{draft.id ? <button type="button" className="danger-button" onClick={async () => { if (!window.nxcore || !draft.id || !draft.configVersion) return; await window.nxcore.connectorSync.archiveJob(draft.id, draft.configVersion); setDraft(null); await reload() }}><Archive />{t('归档')}</button> : <span />}<div><button type="button" className="secondary-button" onClick={() => setDraft(null)}>{t('取消')}</button><button type="button" className="primary-button" disabled={busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? <LoaderCircle className="spin" /> : null}{t('保存任务')}</button></div></footer>
          </section>
        </div>
      ) : null}

      {selectedRecord ? <aside className="connector-record-drawer"><header><strong>{selectedRecord.title || selectedRecord.sourceRecordId}</strong><button type="button" title={t('关闭')} onClick={() => setSelectedRecord(null)}><X /></button></header><pre>{JSON.stringify(selectedRecord, null, 2)}</pre></aside> : null}
    </div>
  )
}
