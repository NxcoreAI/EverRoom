import {
  Archive,
  AlertTriangle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
  ConnectorSyncStatus,
} from '../../../../shared/connector-sync'
import type { OpenConnectorConnectionSummary } from '../../../../shared/open-connector'
import { ConnectorConsolePage } from './ConnectorConsolePage'
import { PageHeader } from './PageHeader'
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

const DATA_PAGE_SIZE = 25

function servicePreset(service: string): Pick<JobDraft, 'resourceType' | 'dataset' | 'goal' | 'allowedActions'> {
  if (service === 'gmail') return {
    resourceType: 'email', dataset: 'emails',
    goal: '同步指定范围内的完整邮件并标准化发件人、主题、正文、标签和时间',
    allowedActions: 'fetch_emails, get_message',
  }
  if (service === 'notion') return {
    resourceType: 'document', dataset: 'documents',
    goal: '同步可访问的 Notion 页面并标准化标题、Markdown 正文、属性、所有者和来源链接',
    allowedActions: 'search, retrieve_page, retrieve_page_markdown',
  }
  if (['googledrive', 'google_drive', 'google_docs', 'gdocs'].includes(service)) return {
    resourceType: 'document', dataset: 'documents',
    goal: '同步可访问的 Google Docs 并保留标题、列表、链接、图片和复杂表格',
    allowedActions: 'files.list, files.export, changes.list, changes.getStartPageToken',
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
    query: '', maxResults: 50,
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

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function statusLabel(status: ConnectorSyncJob['status'], running: boolean): string {
  if (running) return '同步中'
  return { draft: '草稿', active: '正常', paused: '已暂停', archived: '已归档' }[status]
}

function managedJobMode(job: ConnectorSyncJob): 'bootstrap' | 'reconcile' | 'incremental' | null {
  const gmailMode = job.input.everroomSyncMode
  if (gmailMode === 'bootstrap' || gmailMode === 'incremental') return gmailMode
  const documentMode = job.input.everroomDocumentSyncMode
  return documentMode === 'reconcile' || documentMode === 'incremental' ? documentMode : null
}

function scheduleLabel(job: ConnectorSyncJob): string {
  const mode = managedJobMode(job)
  if (mode === 'bootstrap') return '一次性初始化'
  if (mode === 'reconcile') return `全量校准 · 每 ${Math.round(job.intervalMs / 3_600_000)} 小时`
  if (mode === 'incremental') return `增量 · 每 ${Math.round(job.intervalMs / 60_000)} 分钟`
  return job.scheduleType === 'manual' ? '仅手动' : `每 ${Math.round(job.intervalMs / 60_000)} 分钟`
}

function resourceIcon(type: ConnectorResourceType) {
  if (type === 'email') return <Mail aria-hidden="true" />
  if (type === 'document') return <FileText aria-hidden="true" />
  if (type === 'calendar') return <CalendarDays aria-hidden="true" />
  return <Database aria-hidden="true" />
}

export function ConnectorSyncPage() {
  const [tab, setTab] = useState<Tab>('jobs')
  const [connections, setConnections] = useState<OpenConnectorConnectionSummary[]>([])
  const [profiles, setProfiles] = useState<ConnectorPromptProfile[]>([])
  const [jobs, setJobs] = useState<ConnectorSyncJob[]>([])
  const [syncStatus, setSyncStatus] = useState<ConnectorSyncStatus | null>(null)
  const [runs, setRuns] = useState<Array<ConnectorSyncRun & { jobName: string }>>([])
  const [records, setRecords] = useState<ConnectorDataRecord[]>([])
  const [dataTotal, setDataTotal] = useState(0)
  const [dataOffset, setDataOffset] = useState(0)
  const [dataLoading, setDataLoading] = useState(false)
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set())
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [selectedRecord, setSelectedRecord] = useState<ConnectorDataRecord | null>(null)
  const [draft, setDraft] = useState<JobDraft | null>(null)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [dataType, setDataType] = useState<'' | ConnectorResourceType>('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!window.nxcore) return
    setError(null)
    try {
      const [nextStatus, nextJobs, nextProfiles, apps] = await Promise.all([
        window.nxcore.cliConnectorSync.status(),
        window.nxcore.cliConnectorSync.jobs(),
        window.nxcore.cliConnectorSync.promptProfiles(),
        window.nxcore.cliConnector.execute({ requestId: crypto.randomUUID(), command: { kind: 'apps' } }),
      ])
      const nextConnections = Array.isArray(apps.data) ? apps.data as OpenConnectorConnectionSummary[] : []
      setSyncStatus(nextStatus)
      setJobs(nextJobs)
      setProfiles(nextProfiles)
      setConnections(nextConnections)
      const runGroups = await Promise.all(nextJobs.map(async (job) =>
        (await window.nxcore!.cliConnectorSync.runs(job.id)).map((run) => ({ ...run, jobName: job.name }))))
      setRuns(runGroups.flat().sort((left, right) => right.startedAt.localeCompare(left.startedAt)))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取连接器同步配置。')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadData = useCallback(async () => {
    if (!window.nxcore) return
    setDataLoading(true)
    try {
      const dataset = dataType === 'email' ? 'emails'
        : dataType === 'document' ? 'documents'
          : dataType === 'calendar' ? 'calendar_events' : undefined
      const page = await window.nxcore.cliConnectorSync.data({
        dataset,
        query: appliedQuery || undefined,
        limit: DATA_PAGE_SIZE,
        offset: dataOffset,
      })
      if (page.total > 0 && dataOffset >= page.total) {
        setDataOffset(Math.floor((page.total - 1) / DATA_PAGE_SIZE) * DATA_PAGE_SIZE)
        return
      }
      setRecords(page.items)
      setDataTotal(page.total)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取本地数据。')
    } finally {
      setDataLoading(false)
    }
  }, [appliedQuery, dataOffset, dataType])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (tab === 'data') void loadData() }, [loadData, tab])

  const markdownGenerating = Boolean(syncStatus?.markdown
    && (syncStatus.markdown.queued > 0 || syncStatus.markdown.processing > 0))
  const markdownBusy = Boolean(markdownGenerating || syncStatus?.markdown?.ingestPending)
  useEffect(() => {
    if (!window.nxcore) return
    let active = true
    let requesting = false
    const refreshStatus = async () => {
      if (requesting) return
      requesting = true
      try {
        const next = await window.nxcore!.cliConnectorSync.status()
        if (active) setSyncStatus(next)
      } catch {
        // The main reload surface reports connection failures; background polling stays quiet.
      } finally {
        requesting = false
      }
    }
    const timer = window.setInterval(() => void refreshStatus(), markdownBusy ? 2_000 : 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [markdownBusy])

  const services = useMemo(() => [...new Set([
    ...connections.map((item) => item.service), 'gmail', 'notion', 'googledrive', 'google_calendar',
  ])], [connections])

  const saveDraft = async () => {
    if (!draft || !window.nxcore) return
    const allowedActions = draft.allowedActions.split(',').map((item) => item.trim()).filter(Boolean)
    if (!draft.name.trim() || allowedActions.length === 0) {
      setError('请填写任务名称，并至少保留一个只读 Action。')
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
        await window.nxcore.cliConnectorSync.updateJob(draft.id, { ...input, configVersion: draft.configVersion })
      } else {
        await window.nxcore.cliConnectorSync.createJob(input)
      }
      setDraft(null)
      await reload()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存同步任务失败。')
    } finally {
      setBusy(null)
    }
  }

  const runJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try { await window.nxcore.cliConnectorSync.runJob(job.id); await reload() }
    catch (runError) { setError(runError instanceof Error ? runError.message : '同步失败。') }
    finally { setBusy(null) }
  }

  const toggleJob = async (job: ConnectorSyncJob) => {
    if (!window.nxcore) return
    setBusy(job.id)
    try {
      await window.nxcore.cliConnectorSync.setJobPaused(job.id, job.status === 'active', job.configVersion)
      await reload()
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : '更新任务状态失败。') }
    finally { setBusy(null) }
  }

  const changeDataType = (type: '' | ConnectorResourceType) => {
    setDataType(type)
    setDataOffset(0)
    setSelectedRecordIds(new Set())
    setImportSummary(null)
  }

  const toggleRecordSelection = (recordId: string) => {
    setSelectedRecordIds((current) => {
      const next = new Set(current)
      if (next.has(recordId)) next.delete(recordId)
      else next.add(recordId)
      return next
    })
  }

  const importSelectedRecords = async () => {
    if (!window.nxcore || selectedRecordIds.size === 0) return
    setBusy('ingest-records')
    setError(null)
    setImportSummary(null)
    try {
      const recordIds = [...selectedRecordIds]
      let imported = 0
      let deduped = 0
      const failedItems: Array<{ recordId: string; error: string | null }> = []
      for (let index = 0; index < recordIds.length; index += 100) {
        const result = await window.nxcore.cliConnectorSync.ingestRecords(recordIds.slice(index, index + 100))
        imported += result.imported
        deduped += result.deduped
        failedItems.push(...result.items.filter((item) => item.error).map((item) => ({
          recordId: item.recordId,
          error: item.error,
        })))
      }
      setImportSummary(`已导入 ${imported} 条，跳过重复 ${deduped} 条，失败 ${failedItems.length} 条。`)
      setSelectedRecordIds(new Set(failedItems.map((item) => item.recordId)))
      if (failedItems.length > 0) setError(`部分记录未能进入 Wiki：${failedItems[0]!.error ?? '未知错误'}`)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '导入 Wiki 失败。')
    } finally {
      setBusy(null)
    }
  }

  const importableRecords = records.filter((record) => record.resourceType && record.resourceType !== 'generic')
  const allPageSelected = importableRecords.length > 0
    && importableRecords.every((record) => selectedRecordIds.has(record.id))
  const dataRangeStart = dataTotal === 0 ? 0 : dataOffset + 1
  const dataRangeEnd = Math.min(dataOffset + records.length, dataTotal)
  const markdown = syncStatus?.markdown
  const markdownPercent = markdown?.total
    ? Math.min(100, Math.round((markdown.ready / markdown.total) * 100))
    : 0
  const markdownState = !markdown || markdown.total === 0
    ? '等待数据'
    : markdown.failed > 0
      ? '存在失败'
      : markdown.processing > 0
        ? '正在生成'
        : markdown.queued > 0
          ? '等待生成'
          : '已完成'

  return (
    <div className="page connector-sync-page">
      <PageHeader
        title="连接器"
        description="管理授权账号、Agent 同步任务、本地数据与运行状态"
        extraAction={<button type="button" className="secondary-button" onClick={() => void reload()}><RefreshCw />刷新</button>}
      />

      <nav className="connector-sync-tabs" aria-label="连接器视图">
        {TABS.map((item) => <button key={item.id} type="button" data-active={String(tab === item.id)} onClick={() => setTab(item.id)}><item.icon />{item.label}</button>)}
      </nav>

      {!loading && markdown ? (
        <section className="connector-markdown-progress" aria-label="Markdown 生成进度">
          <div className="connector-markdown-progress-main">
            <div className="connector-markdown-progress-heading">
              <span className="connector-markdown-progress-icon" data-state={markdown.failed > 0 ? 'failed' : markdownGenerating ? 'running' : 'complete'}>
                {markdown.failed > 0 ? <AlertTriangle aria-hidden="true" /> : markdownGenerating ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              </span>
              <div><strong>Markdown 处理</strong><span>{markdownState}</span></div>
            </div>
            <div className="connector-markdown-progress-count"><strong>{markdown.ready}</strong><span>/ {markdown.total} 已生成</span></div>
          </div>
          <div className="connector-markdown-progress-track" role="progressbar" aria-label="Markdown 已生成比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={markdownPercent}>
            <div style={{ width: `${markdownPercent}%` }} />
          </div>
          <div className="connector-markdown-progress-details">
            <span>完成 {markdownPercent}%</span>
            <span>排队 {markdown.queued}</span>
            <span>处理中 {markdown.processing}</span>
            <span data-tone={markdown.failed > 0 ? 'danger' : undefined}>失败 {markdown.failed}</span>
            <span>知识导入 {markdown.ingestSucceeded}/{markdown.ready}</span>
            {markdown.ingestPending > 0 ? <span>待导入 {markdown.ingestPending}</span> : null}
            {markdown.ingestFailed > 0 ? <span data-tone="danger">导入失败 {markdown.ingestFailed}</span> : null}
          </div>
        </section>
      ) : null}

      {error ? <div className="connector-sync-alert" role="alert"><span>{error}</span><button type="button" title="关闭" onClick={() => setError(null)}><X /></button></div> : null}
      {loading ? <div className="connector-sync-loading"><LoaderCircle className="spin" />正在读取同步配置</div> : null}

      {!loading && tab === 'accounts' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>已授权账号</h2><p>凭据由 EverRoom 连接器管理，本地数据库只保存连接引用。</p></div><button type="button" className="secondary-button" onClick={() => void window.nxcore?.cliConnector.openConsole()}>管理授权</button></div>
          <div className="connector-account-list">
            {connections.length === 0 ? <div className="connector-sync-empty">还没有已授权账号。</div> : connections.map((connection) => (
              <div className="connector-account-row" key={`${connection.service}:${connection.connectionName ?? 'default'}`}>
                <div className="connector-resource-icon">{resourceIcon(servicePreset(connection.service).resourceType)}</div>
                <div><strong>{connection.displayName || connection.accountLabel || connection.connectionName || connection.service}</strong><span>{connection.service} · {connection.connectionName || '默认连接'}</span></div>
                <span className="connector-status-pill" data-status={connection.status}>{connection.status === 'active' ? '已连接' : connection.status}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'jobs' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>同步任务</h2><p>任务配置保存在本地数据库，Gateway 重启后继续生效。</p></div><button type="button" className="primary-button" onClick={() => setDraft(blankDraft(services[0]))}><Plus />新建任务</button></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>任务</th><th>账号</th><th>计划</th><th>上次结果</th><th>下次运行</th><th aria-label="操作" /></tr></thead><tbody>
            {jobs.filter((job) => job.status !== 'archived').map((job) => (
              <tr key={job.id}>
                <td><button type="button" className="connector-job-name" disabled={managedJobMode(job) !== null} title={managedJobMode(job) ? '系统托管任务' : '编辑任务'} onClick={() => setDraft(draftFromJob(job))}>{resourceIcon(job.resourceType)}<span><strong>{job.name}</strong><small>{statusLabel(job.status, job.running)} · v{job.configVersion}</small></span></button></td>
                <td>{job.connectionName || '默认连接'}<small>{job.service}</small></td>
                <td>{scheduleLabel(job)}</td>
                <td>{job.lastError ? <span className="connector-run-error">失败 · {job.lastError}</span> : formatTime(job.lastSuccessAt)}</td>
                <td>{formatTime(job.nextRunAt)}</td>
                <td><div className="connector-row-actions"><button type="button" className="connector-run-now" title="立即同步" disabled={Boolean(busy) || job.running} onClick={() => void runJob(job)}>{busy === job.id ? <LoaderCircle className="spin" /> : <Play />}<span>立即同步</span></button>{managedJobMode(job) !== 'bootstrap' ? <button type="button" title={job.status === 'active' ? '暂停' : '恢复'} disabled={Boolean(busy)} onClick={() => void toggleJob(job)}>{job.status === 'active' ? <Pause /> : <RefreshCw />}</button> : null}</div></td>
              </tr>
            ))}
          </tbody></table>{jobs.filter((job) => job.status !== 'archived').length === 0 ? <div className="connector-sync-empty">还没有同步任务，创建一个任务开始同步。</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'runs' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>运行记录</h2><p>每次运行都固定任务版本、Prompt 版本、指标和检查点。</p></div></div>
          <div className="connector-table-wrap"><table className="connector-sync-table"><thead><tr><th>任务</th><th>状态</th><th>开始时间</th><th>发现</th><th>新增</th><th>更新</th><th>未变化</th><th>隔离</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{run.jobName}<small>{run.agentModel || 'direct'}</small></td><td><span className="connector-status-pill" data-status={run.status}>{run.status}</span>{run.errorMessage ? <small className="connector-run-error">{run.errorMessage}</small> : null}</td><td>{formatTime(run.startedAt)}</td><td>{run.discovered}</td><td>{run.inserted}</td><td>{run.updated}</td><td>{run.unchanged}</td><td>{run.quarantined}</td></tr>)}</tbody></table>{runs.length === 0 ? <div className="connector-sync-empty">暂无运行记录。</div> : null}</div>
        </section>
      ) : null}

      {!loading && tab === 'data' ? (
        <section className="connector-sync-section">
          <div className="connector-section-heading"><div><h2>本地数据</h2><p>选择同步记录后转为规范 Markdown，并送入 Room 与 Wiki 路由。</p></div><button type="button" className="primary-button" disabled={selectedRecordIds.size === 0 || busy === 'ingest-records'} onClick={() => void importSelectedRecords()}>{busy === 'ingest-records' ? <LoaderCircle className="spin" /> : <BookOpen />}导入 Wiki{selectedRecordIds.size > 0 ? ` (${selectedRecordIds.size})` : ''}</button></div>
          <div className="connector-data-toolbar"><div className="connector-segmented"><button type="button" data-active={String(dataType === '')} onClick={() => changeDataType('')}>全部</button><button type="button" data-active={String(dataType === 'email')} onClick={() => changeDataType('email')}>邮件</button><button type="button" data-active={String(dataType === 'document')} onClick={() => changeDataType('document')}>文档</button><button type="button" data-active={String(dataType === 'calendar')} onClick={() => changeDataType('calendar')}>日程</button></div><form onSubmit={(event) => { event.preventDefault(); setDataOffset(0); setSelectedRecordIds(new Set()); setImportSummary(null); setAppliedQuery(query.trim()) }}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文、发件人或地点" /><button type="submit" className="secondary-button">搜索</button></form></div>
          <div className="connector-data-selection"><label><input type="checkbox" checked={allPageSelected} disabled={importableRecords.length === 0} onChange={() => setSelectedRecordIds((current) => { const next = new Set(current); for (const record of importableRecords) { if (allPageSelected) next.delete(record.id); else next.add(record.id) } return next })} /><span>选择当前页</span></label><span>{dataTotal} 条记录{selectedRecordIds.size > 0 ? ` · 已选 ${selectedRecordIds.size} 条` : ''}</span></div>
          {importSummary ? <div className="connector-import-summary" role="status">{importSummary}</div> : null}
          <div className="connector-data-list" aria-busy={dataLoading}>{records.map((record) => <div className="connector-data-row" key={record.id}><input type="checkbox" aria-label={`选择 ${record.title || record.sourceRecordId}`} checked={selectedRecordIds.has(record.id)} disabled={!record.resourceType || record.resourceType === 'generic'} onChange={() => toggleRecordSelection(record.id)} /><button type="button" className="connector-data-open" onClick={async () => setSelectedRecord(await window.nxcore!.cliConnectorSync.record(record.id))}><span className="connector-resource-icon">{resourceIcon(record.resourceType ?? 'generic')}</span><span><strong>{record.title || record.sourceRecordId}</strong><small>{record.snippet || record.service}</small></span><time>{formatTime(record.syncedAt)}</time></button></div>)}{dataLoading && records.length === 0 ? <div className="connector-sync-empty"><LoaderCircle className="spin" />正在读取数据</div> : null}{!dataLoading && records.length === 0 ? <div className="connector-sync-empty">没有匹配的本地数据。</div> : null}</div>
          <footer className="connector-data-pagination"><span>显示 {dataRangeStart}-{dataRangeEnd}，共 {dataTotal} 条</span><div><button type="button" title="上一页" disabled={dataOffset === 0 || dataLoading} onClick={() => setDataOffset(Math.max(0, dataOffset - DATA_PAGE_SIZE))}><ChevronLeft /></button><span>第 {dataTotal === 0 ? 0 : Math.floor(dataOffset / DATA_PAGE_SIZE) + 1} / {Math.ceil(dataTotal / DATA_PAGE_SIZE)} 页</span><button type="button" title="下一页" disabled={dataOffset + DATA_PAGE_SIZE >= dataTotal || dataLoading} onClick={() => setDataOffset(dataOffset + DATA_PAGE_SIZE)}><ChevronRight /></button></div></footer>
        </section>
      ) : null}

      {tab === 'developer' ? <ConnectorConsolePage embedded /> : null}

      {draft ? (
        <div className="connector-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null) }}>
          <section className="connector-job-dialog" role="dialog" aria-modal="true" aria-label={draft.id ? '编辑同步任务' : '新建同步任务'}>
            <header><div><Settings2 /><span><strong>{draft.id ? '编辑同步任务' : '新建同步任务'}</strong><small>结构化配置会保存到本地数据库</small></span></div><button type="button" title="关闭" onClick={() => setDraft(null)}><X /></button></header>
            <div className="connector-job-form">
              <label><span>任务名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：Gmail 最近一天邮件" /></label>
              <div className="connector-form-grid"><label><span>连接器</span><select value={draft.service} onChange={(event) => { const service = event.target.value; setDraft({ ...draft, service, connectionName: '', ...servicePreset(service), promptProfileId: '' }) }}>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label><label><span>授权账号</span><select value={draft.connectionName} onChange={(event) => setDraft({ ...draft, connectionName: event.target.value })}><option value="">默认连接</option>{connections.filter((item) => item.service === draft.service && item.connectionName).map((item) => <option key={item.connectionName!} value={item.connectionName!}>{item.displayName || item.connectionName}</option>)}</select></label></div>
              <div className="connector-form-grid"><label><span>数据类型</span><select value={draft.resourceType} onChange={(event) => setDraft({ ...draft, resourceType: event.target.value as ConnectorResourceType })}><option value="email">邮件</option><option value="document">文档</option><option value="calendar">日程</option><option value="generic">通用</option></select></label><label><span>数据集</span><input value={draft.dataset} onChange={(event) => setDraft({ ...draft, dataset: event.target.value })} /></label></div>
              <div className="connector-form-grid"><label><span>查询范围</span><input value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} placeholder="例如 newer_than:1d" /></label><label><span>单次上限</span><input type="number" min={1} max={500} value={draft.maxResults} onChange={(event) => setDraft({ ...draft, maxResults: Number(event.target.value) })} /></label></div>
              <label><span>同步目标</span><textarea value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
              <div className="connector-form-grid"><label><span>Prompt Profile</span><select value={draft.promptProfileId} onChange={(event) => setDraft({ ...draft, promptProfileId: event.target.value })}><option value="">自动选择已发布模板</option>{profiles.filter((profile) => profile.service === draft.service && profile.resourceType === draft.resourceType).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.version}</option>)}</select></label><label><span>只读 Action</span><input value={draft.allowedActions} onChange={(event) => setDraft({ ...draft, allowedActions: event.target.value })} /></label></div>
              <label><span>清洗偏好（可选）</span><textarea value={draft.promptOverride} onChange={(event) => setDraft({ ...draft, promptOverride: event.target.value })} placeholder="只能补充清洗偏好，不能改变权限边界" /></label>
              <div className="connector-form-grid"><label><span>运行方式</span><div className="connector-segmented"><button type="button" data-active={String(draft.scheduleType === 'manual')} onClick={() => setDraft({ ...draft, scheduleType: 'manual' })}>仅手动</button><button type="button" data-active={String(draft.scheduleType === 'interval')} onClick={() => setDraft({ ...draft, scheduleType: 'interval' })}>固定间隔</button></div></label><label><span>间隔分钟</span><input type="number" min={1} max={525600} disabled={draft.scheduleType === 'manual'} value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label></div>
              <label className="connector-toggle-label"><input type="checkbox" checked={draft.status === 'active'} onChange={(event) => setDraft({ ...draft, status: event.target.checked ? 'active' : 'draft' })} /><span>保存后启用任务</span></label>
            </div>
            <footer>{draft.id ? <button type="button" className="danger-button" onClick={async () => { if (!window.nxcore || !draft.id || !draft.configVersion) return; await window.nxcore.cliConnectorSync.archiveJob(draft.id, draft.configVersion); setDraft(null); await reload() }}><Archive />归档</button> : <span />}<div><button type="button" className="secondary-button" onClick={() => setDraft(null)}>取消</button><button type="button" className="primary-button" disabled={busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? <LoaderCircle className="spin" /> : null}保存任务</button></div></footer>
          </section>
        </div>
      ) : null}

      {selectedRecord ? <aside className="connector-record-drawer"><header><strong>{selectedRecord.title || selectedRecord.sourceRecordId}</strong><button type="button" title="关闭" onClick={() => setSelectedRecord(null)}><X /></button></header><pre>{JSON.stringify(selectedRecord, null, 2)}</pre></aside> : null}
    </div>
  )
}
