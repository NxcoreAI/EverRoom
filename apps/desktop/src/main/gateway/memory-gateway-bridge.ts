import type {
  MemoryAtomicListOptions,
  MemoryAtomicPageDto,
  MemoryConversationListOptions,
  MemoryConversationPageDto,
  MemoryCoreDto,
  MemoryDocumentRewriteInput,
  MemoryOverviewDto,
  MemoryScenarioContentDto,
  MemoryScenarioEntryDto,
} from '../../shared/memory'
import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 记忆功能的 gateway 错误码。IPC 只能可靠传回 message 字符串，
 * 因此用 `[code] ` 前缀把 gateway 的 error code 带到渲染层，
 * 渲染层据此区分「未启用 / 不可达 / 其他错误」三种降级态。
 */
export type MemoryErrorCode = 'memory_disabled' | 'memory_unreachable' | 'memory_error'

export function parseMemoryErrorCode(message: string): MemoryErrorCode | null {
  const match = /^\[(memory_disabled|memory_unreachable|memory_error)\]/.exec(message)
  return match ? (match[1] as MemoryErrorCode) : null
}

interface GatewayErrorBody {
  error?: unknown
  message?: unknown
}

export class MemoryGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  overview(): Promise<MemoryOverviewDto> {
    return this.request('/v1/memory/overview')
  }

  listAtomic(options: MemoryAtomicListOptions): Promise<MemoryAtomicPageDto> {
    return this.request(`/v1/memory/atomic?${this.query(options)}`)
  }

  searchAtomic(query: string, limit = 10): Promise<{ items: MemoryAtomicPageDto['items'] }> {
    return this.request('/v1/memory/atomic/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    })
  }

  updateAtomic(
    id: string,
    content: string,
    background?: string,
  ): Promise<{ id: string; version: number; updatedAt: string }> {
    return this.request(`/v1/memory/atomic/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content, ...(background !== undefined ? { background } : {}) }),
    })
  }

  deleteAtomic(ids: string[]): Promise<{ deletedCount: number }> {
    return this.request('/v1/memory/atomic', { method: 'DELETE', body: JSON.stringify({ ids }) })
  }

  listScenarios(pathPrefix?: string): Promise<{ entries: MemoryScenarioEntryDto[]; total: number }> {
    const query = pathPrefix ? `?${new URLSearchParams({ pathPrefix })}` : ''
    return this.request(`/v1/memory/scenario${query}`)
  }

  readScenario(path: string): Promise<MemoryScenarioContentDto> {
    return this.request(`/v1/memory/scenario/content?${new URLSearchParams({ path })}`)
  }

  readCore(): Promise<MemoryCoreDto> {
    return this.request('/v1/memory/core')
  }

  writeCore(content: string): Promise<{ version: number; updatedAt: string }> {
    return this.request('/v1/memory/core', { method: 'PUT', body: JSON.stringify({ content }) })
  }

  listConversations(options: MemoryConversationListOptions): Promise<MemoryConversationPageDto> {
    return this.request(`/v1/memory/conversation?${this.query(options)}`)
  }

  searchConversations(
    query: string,
    limit = 10,
    sessionId?: string,
  ): Promise<{ messages: MemoryConversationPageDto['messages'] }> {
    return this.request('/v1/memory/conversation/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit, ...(sessionId ? { sessionId } : {}) }),
    })
  }

  deleteConversations(target: {
    sessionIds?: string[]
    messageIds?: string[]
  }): Promise<{ deletedCount: number }> {
    return this.request('/v1/memory/conversation', { method: 'DELETE', body: JSON.stringify(target) })
  }

  captureDocumentRewrite(input: MemoryDocumentRewriteInput): Promise<{ captured: boolean }> {
    return this.request('/v1/memory/document-rewrite', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  private query(
    options: MemoryAtomicListOptions | MemoryConversationListOptions,
  ): string {
    const params = new URLSearchParams()
    if ('type' in options && options.type) params.set('type', options.type)
    if ('sessionId' in options && options.sessionId) params.set('sessionId', options.sessionId)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.timeStart) params.set('timeStart', options.timeStart)
    if (options.timeEnd) params.set('timeEnd', options.timeEnd)
    return params.toString()
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as GatewayErrorBody | null
      const code = typeof body?.error === 'string' ? body.error : ''
      const message = typeof body?.message === 'string' ? body.message : `记忆请求失败（${response.status}）`
      throw new Error(code ? `[${code}] ${message}` : message)
    }
    return response.json() as Promise<T>
  }
}
