import type { IngestEventDto } from '../../shared/ingest'
import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 统一理解引擎的台账读取面（unified-ingest-plan §9，导入记录页数据源）。
 * 策略不在桌面端管理：defaults 在 gateway 代码注册表，覆盖走部署期配置文件
 * （<dataDir>/ingest-policies.json），REST 只有只读展示。
 */
export class IngestGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  listEvents(query: {
    limit?: number
    offset?: number
    sourceKind?: string
    sourceId?: string
  }): Promise<{ items: IngestEventDto[]; total: number }> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.offset !== undefined) params.set('offset', String(query.offset))
    if (query.sourceKind) params.set('sourceKind', query.sourceKind)
    if (query.sourceId) params.set('sourceId', query.sourceId)
    const suffix = params.size > 0 ? `?${params}` : ''
    return this.request(`/v1/ingest${suffix}`)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
      const message = typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' ? body.error : `理解引擎请求失败（${response.status}）`
      throw new Error(message)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
