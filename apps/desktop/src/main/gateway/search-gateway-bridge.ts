import type {
  SearchMessageContextDto,
  SearchPageDto,
  SearchRequestDto,
  SearchScopeDto,
  SearchItemType,
} from '../../shared/search'
import type { GatewaySupervisor } from './gateway-supervisor'

interface GatewayErrorBody {
  error?: unknown
  message?: unknown
}

export class SearchGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  invoke(request: SearchRequestDto): Promise<SearchPageDto> {
    return this.request('/v1/search', { method: 'POST', body: JSON.stringify(request) })
  }

  status(): Promise<SearchScopeDto> {
    return this.request('/v1/search/status')
  }

  prioritize(itemType: SearchItemType, refId: string): Promise<{ ok: boolean }> {
    return this.request('/v1/search/prioritize', {
      method: 'POST',
      body: JSON.stringify({ itemType, refId }),
    })
  }

  messageContext(
    messageId: string,
    before?: number,
    after?: number,
  ): Promise<SearchMessageContextDto> {
    const params = new URLSearchParams({ messageId, before: String(before ?? 5), after: String(after ?? 5) })
    return this.request(`/v1/search/message-context?${params.toString()}`)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」直接 400。
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as GatewayErrorBody | null
      const message = typeof body?.message === 'string' ? body.message : `搜索请求失败（${response.status}）`
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }
}
