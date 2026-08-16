import type { AxiosRequestConfig } from 'axios'
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorStatus,
  MailMessage,
  SyncMode,
  SyncRun,
  SyncScope,
} from '@nxcore/connector-contract'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'

const http = createLoggedHttpClient('gateway-connectors')
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const FAULT_POINTS = new Set(['before_page_commit', 'after_page_commit_before_cursor_cas', 'rate_limited', 'cursor_expired'])

export interface ConnectorConnectionInput {
  provider: 'gmail' | 'outlook'
  nangoConfigKey: string
  nangoConnectionId: string
  filters?: Record<string, unknown>
}

export interface ConnectorMailQuery {
  connectionId?: string
  scopeId?: string
  search?: string
  limit?: number
  cursor?: string
}

export interface ConnectorFailure {
  id: string
  scopeId: string | null
  runId: string | null
  category: string
  message: string
  itemKey: string | null
  createdAt: string
}

export class ConnectorGatewayBridge {
  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly openExternal: (url: string) => Promise<void> = async () => {
      throw new Error('无法打开授权页面。')
    },
  ) {}

  async status(): Promise<ConnectorStatus> {
    const status = await this.request<ConnectorStatus>('/v1/connectors/status')
    return { ...status, scopes: status.scopes.map((scope) => this.sanitizeScope(scope)) }
  }

  registerConnection(input: ConnectorConnectionInput): Promise<ConnectorConnection> {
    if (input.provider !== 'gmail' && input.provider !== 'outlook') throw new Error('不支持的连接提供方。')
    if (!input.nangoConfigKey.trim() || !input.nangoConnectionId.trim()) throw new Error('连接配置不能为空。')
    return this.request('/v1/connectors/connections', { method: 'POST', data: { ...input, nangoConfigKey: input.nangoConfigKey.trim(), nangoConnectionId: input.nangoConnectionId.trim() } })
  }

  async startAuthorization(provider: 'gmail' | 'outlook'): Promise<ConnectorAuthorizationAttempt> {
    if (provider !== 'gmail' && provider !== 'outlook') throw new Error('不支持的连接提供方。')
    const result = await this.request<ConnectorAuthorizationAttempt & { authorizationUrl: string }>(
      '/v1/connectors/authorizations',
      { method: 'POST', data: { provider } },
    )
    const authorizationUrl = new URL(result.authorizationUrl)
    if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
      throw new Error('Nango 返回了不安全的授权地址。')
    }
    await this.openExternal(authorizationUrl.toString())
    return {
      id: result.id,
      provider: result.provider,
      status: result.status,
      expiresAt: result.expiresAt,
      connection: result.connection,
      error: result.error,
    }
  }

  authorizationStatus(id: string): Promise<ConnectorAuthorizationAttempt> {
    return this.request(`/v1/connectors/authorizations/${this.id(id)}`)
  }

  async disableConnection(id: string): Promise<void> {
    await this.request(`/v1/connectors/connections/${this.id(id)}/disable`, { method: 'POST' })
  }

  async purgeConnection(id: string): Promise<void> {
    await this.request(`/v1/connectors/connections/${this.id(id)}`, { method: 'DELETE' })
  }

  triggerSync(id: string, mode: SyncMode): Promise<SyncRun> {
    if (!['full', 'incremental', 'rebuild'].includes(mode)) throw new Error('无效的同步模式。')
    return this.request(`/v1/connectors/scopes/${this.id(id)}/sync`, { method: 'POST', data: { mode } })
  }

  cancelRun(id: string): Promise<SyncRun> {
    return this.request(`/v1/connectors/runs/${this.id(id)}/cancel`, { method: 'POST' })
  }

  async scopes(connectionId?: string): Promise<SyncScope[]> {
    const scopes = await this.request<SyncScope[]>('/v1/connectors/scopes', { params: connectionId ? { connectionId: this.id(connectionId) } : undefined })
    return scopes.map((scope) => this.sanitizeScope(scope))
  }

  runs(connectionId?: string): Promise<SyncRun[]> {
    return this.request('/v1/connectors/runs', { params: connectionId ? { connectionId: this.id(connectionId) } : undefined })
  }

  async mail(query: ConnectorMailQuery = {}): Promise<MailMessage[]> {
    const connectionIds = query.connectionId
      ? [this.id(query.connectionId)]
      : (await this.status()).connections.map((item) => this.id(item.id))
    const pages = await Promise.all(connectionIds.map((id) => this.request<MailMessage[]>(`/v1/connectors/connections/${id}/messages`)))
    const search = query.search?.trim().toLocaleLowerCase()
    const messages = pages.flat().filter((item) => !search || `${item.subject ?? ''} ${item.snippet ?? ''}`.toLocaleLowerCase().includes(search))
    return messages.slice(0, Math.min(200, Math.max(1, query.limit ?? 100)))
  }

  failures(query: { connectionId?: string; runId?: string; limit?: number } = {}): Promise<ConnectorFailure[]> {
    return this.request('/v1/connectors/failures', { params: query })
  }

  armFault(point: string): Promise<void> {
    if (!FAULT_POINTS.has(point)) throw new Error('无效的故障注入点。')
    return this.request('/v1/connectors/debug/faults', { method: 'POST', data: { point } })
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await http.request<T & { message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: { Authorization: `Bearer ${connection.token}`, ...config.headers },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      const message = typeof response.data?.message === 'string' ? response.data.message : `连接器请求失败（${response.status}）`
      throw new Error(message.slice(0, 500))
    }
    return response.data
  }

  private id(value: string): string {
    if (!ID_PATTERN.test(value)) throw new Error('无效的连接器标识。')
    return encodeURIComponent(value)
  }

  private sanitizeScope(scope: SyncScope): SyncScope {
    return { ...scope, sourceCursor: null }
  }
}
