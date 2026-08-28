import type {
  ExternalConversationPage,
  ExternalConversationPreview,
  MigrationProvider,
  MigrationRun,
  MigrationSource,
  MigrationTransport,
} from '@nxcore/agent-contract'
import type { NormalizedMigrationThread } from '../migrations/types'
import type { GatewaySupervisor } from './gateway-supervisor'

export class MigrationsGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  sources(): Promise<MigrationSource[]> { return this.request('/v1/data-migrations/sources') }
  runs(sourceId?: string): Promise<MigrationRun[]> {
    return this.request(`/v1/data-migrations/runs${sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : ''}`)
  }
  begin(input: { provider: MigrationProvider; transport: MigrationTransport; stableSourceKey: string; displayName: string }): Promise<{ source: MigrationSource; run: MigrationRun }> {
    return this.request('/v1/data-migrations/runs', { method: 'POST', body: JSON.stringify(input) })
  }
  progress(runId: string, input: Partial<MigrationRun>): Promise<MigrationRun> {
    return this.request(`/v1/data-migrations/runs/${encodeURIComponent(runId)}/progress`, { method: 'PATCH', body: JSON.stringify(input) })
  }
  threads(runId: string, threads: NormalizedMigrationThread[]): Promise<MigrationRun> {
    return this.request(`/v1/data-migrations/runs/${encodeURIComponent(runId)}/threads`, { method: 'POST', body: JSON.stringify({ threads }) })
  }
  finish(runId: string, fullScan = true): Promise<MigrationRun> {
    return this.request(`/v1/data-migrations/runs/${encodeURIComponent(runId)}/finish`, { method: 'POST', body: JSON.stringify({ fullScan }) })
  }
  fail(runId: string, error: string): Promise<MigrationRun> {
    return this.request(`/v1/data-migrations/runs/${encodeURIComponent(runId)}/fail`, { method: 'POST', body: JSON.stringify({ error }) })
  }
  cancel(runId: string): Promise<MigrationRun> {
    return this.request(`/v1/data-migrations/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  }
  clear(sourceId: string): Promise<void> { return this.request(`/v1/data-migrations/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }) }
  conversations(input: { query?: string; cursor?: string; limit?: number } = {}): Promise<ExternalConversationPage> {
    const query = new URLSearchParams(); if (input.query) query.set('query', input.query); if (input.cursor) query.set('cursor', input.cursor); query.set('limit', String(input.limit ?? 20))
    return this.request(`/v1/data-migrations/conversations?${query}`)
  }
  preview(id: string): Promise<ExternalConversationPreview> { return this.request(`/v1/data-migrations/conversations/${encodeURIComponent(id)}/preview`) }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', ...init.headers } })
    if (response.status === 204) return undefined as T
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string }
    if (!response.ok) throw new Error(body.message ?? body.error ?? `Migration request failed (${response.status})`)
    return body as T
  }
}
