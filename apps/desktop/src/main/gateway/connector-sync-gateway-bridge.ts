import type {
  ConnectorAccount,
  ConnectorDataPage,
  ConnectorDataQuery,
  ConnectorDataRecord,
  ConnectorIngestResult,
  ConnectorPromptProfile,
  ConnectorQuarantinedRecord,
  ConnectorSyncJob,
  ConnectorSyncJobInput,
  ConnectorSyncRun,
  ConnectorSyncStatus,
} from '../../shared/connector-sync'
import type { GatewaySupervisor } from './gateway-supervisor'

export class CliConnectorSyncGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  status(): Promise<ConnectorSyncStatus> { return this.request('/v1/cli-connectors/sync/status') }
  accounts(): Promise<ConnectorAccount[]> { return this.request('/v1/cli-connectors/accounts') }
  promptProfiles(): Promise<ConnectorPromptProfile[]> { return this.request('/v1/cli-connectors/prompt-profiles') }
  jobs(): Promise<ConnectorSyncJob[]> { return this.request('/v1/cli-connectors/sync/jobs') }
  createJob(input: ConnectorSyncJobInput): Promise<ConnectorSyncJob> {
    return this.request('/v1/cli-connectors/sync/jobs', { method: 'POST', body: JSON.stringify(input) })
  }
  updateJob(id: string, input: Partial<ConnectorSyncJobInput> & { configVersion: number }): Promise<ConnectorSyncJob> {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  }
  runJob(id: string): Promise<ConnectorSyncJob> {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' })
  }
  setJobPaused(id: string, paused: boolean, configVersion: number): Promise<ConnectorSyncJob> {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, {
      method: 'POST', body: JSON.stringify({ configVersion }),
    })
  }
  archiveJob(id: string, configVersion: number): Promise<ConnectorSyncJob> {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: JSON.stringify({ configVersion }),
    })
  }
  runs(jobId: string): Promise<ConnectorSyncRun[]> {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(jobId)}/runs`)
  }
  quarantine(runId: string): Promise<ConnectorQuarantinedRecord[]> {
    return this.request(`/v1/cli-connectors/sync/runs/${encodeURIComponent(runId)}/quarantine`)
  }
  data(query: ConnectorDataQuery): Promise<ConnectorDataPage> {
    const params = new URLSearchParams()
    if (query.service) params.set('service', query.service)
    if (query.dataset) params.set('dataset', query.dataset)
    if (query.query) params.set('query', query.query)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.offset !== undefined) params.set('offset', String(query.offset))
    if (query.includeExpired !== undefined) params.set('includeExpired', String(query.includeExpired))
    return this.request(`/v1/cli-connectors/data?${params}`)
  }
  record(id: string): Promise<ConnectorDataRecord> {
    return this.request(`/v1/cli-connectors/data/${encodeURIComponent(id)}`)
  }
  ingestRecords(recordIds: string[]): Promise<ConnectorIngestResult> {
    return this.request('/v1/cli-connectors/data/ingest', {
      method: 'POST', body: JSON.stringify({ recordIds }),
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body !== undefined && init.body !== null ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const message = typeof body?.message === 'string' ? body.message : `连接器请求失败（${response.status}）`
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }
}
