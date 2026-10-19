import type { GatewayConnection, GatewaySupervisor } from './gateway-supervisor'
import type {
  AgentAccessCreateInput,
  AgentAccessExampleQueryDto,
  AgentAccessInstallPlanDto,
  AgentAccessSelftestDto,
  AgentAccessUpdateInput,
  AgentConnectionDto,
} from '../../shared/agent-access'

/**
 * 外部 Agent 访问（PRD 0.2.0 第 7 章）的网关桥：连接页 REST（/v1/agent-access/*）
 * 的桌面侧出口。模式同 DiaryGatewayBridge（ensureConnection + bearer + 可恢复连接重试）。
 */

export type {
  AgentAccessCreateInput,
  AgentAccessExampleQueryDto,
  AgentAccessInstallPlanDto,
  AgentAccessSelftestDto,
  AgentAccessUpdateInput,
  AgentConnectionDto,
} from '../../shared/agent-access'

const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

function isRecoverableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && RECOVERABLE_CONNECTION_ERROR_CODES.has(code)) return true
  }
  return error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)
}

export class AgentAccessGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  listConnections(): Promise<{ connections: AgentConnectionDto[] }> {
    return this.request('/v1/agent-access/connections')
  }

  createConnection(input: AgentAccessCreateInput): Promise<{ connection: AgentConnectionDto; token: string }> {
    return this.request('/v1/agent-access/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateConnection(id: string, patch: AgentAccessUpdateInput): Promise<{ connection: AgentConnectionDto }> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  revokeConnection(id: string): Promise<{ connection: AgentConnectionDto }> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  rotateToken(id: string): Promise<{ connection: AgentConnectionDto; token: string }> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}/token`, { method: 'POST' })
  }

  submissions(id: string): Promise<{ submissions: Array<Record<string, unknown>> }> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}/submissions`)
  }

  events(id: string): Promise<{ events: Array<Record<string, unknown>> }> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}/events`)
  }

  selftest(id: string): Promise<AgentAccessSelftestDto> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}/selftest`, { method: 'POST' })
  }

  exampleQuery(id: string, query?: string): Promise<AgentAccessExampleQueryDto> {
    return this.request(`/v1/agent-access/connections/${encodeURIComponent(id)}/example-query`, {
      method: 'POST',
      body: JSON.stringify(query ? { query } : {}),
    })
  }

  install(id: string, target: string, token: string): Promise<{ install: AgentAccessInstallPlanDto }> {
    return this.request(
      `/v1/agent-access/connections/${encodeURIComponent(id)}/install/${encodeURIComponent(target)}`,
      { method: 'POST', body: JSON.stringify({ token }) },
    )
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path, init)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recovered = await this.supervisor.recoverConnection(connection)
      return this.requestWithConnection<T>(recovered, path, init)
    }
  }

  private async requestWithConnection<T>(
    connection: GatewayConnection,
    path: string,
    init: RequestInit | undefined,
  ): Promise<T> {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      throw new Error(typeof body?.message === 'string' ? body.message
        : typeof body?.error === 'string' ? body.error : `Agent 连接请求失败（${String(response.status)}）`)
    }
    return response.json() as Promise<T>
  }
}
