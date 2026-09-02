import type {
  WritingStyleCorpusEntryDto,
  WritingStyleProfileDto,
  WritingStyleSettingsDto,
  WritingStyleUserContentDto,
} from '../../shared/writing-style'
import type { GatewayConnection, GatewaySupervisor } from './gateway-supervisor'

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

/** 写作风格 REST（/v1/writing-style*）的桌面主进程桥。 */
export class WritingStyleGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  profile(): Promise<WritingStyleProfileDto> {
    return this.request('/v1/writing-style')
  }

  settings(): Promise<WritingStyleSettingsDto> {
    return this.request('/v1/writing-style/settings')
  }

  updateSettings(input: Partial<Pick<WritingStyleSettingsDto, 'completionEnabled' | 'generationEnabled'>>): Promise<WritingStyleSettingsDto> {
    return this.request('/v1/writing-style/settings', { method: 'PUT', body: JSON.stringify(input) })
  }

  userContent(): Promise<WritingStyleUserContentDto> {
    return this.request('/v1/writing-style/user-content')
  }

  replaceUserContent(content: string): Promise<WritingStyleUserContentDto> {
    return this.request('/v1/writing-style/user-content', { method: 'PUT', body: JSON.stringify({ content }) })
  }

  regenerateUserContent(): Promise<WritingStyleUserContentDto> {
    return this.request('/v1/writing-style/user-content/regenerate', { method: 'POST' })
  }

  recompute(): Promise<{ queuedDocuments: number }> {
    return this.request('/v1/writing-style/recompute', { method: 'POST' })
  }

  backfill(): Promise<{ queuedDocuments: number }> {
    return this.request('/v1/writing-style/backfill', { method: 'POST' })
  }

  corpus(): Promise<{ documents: WritingStyleCorpusEntryDto[] }> {
    return this.request('/v1/writing-style/corpus')
  }

  setExclusion(documentId: string, excluded: boolean): Promise<{ ok: boolean }> {
    return this.request(`/v1/writing-style/documents/${encodeURIComponent(documentId)}/exclusion`, {
      method: 'POST',
      body: JSON.stringify({ excluded }),
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path, init)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recoveredConnection = await this.supervisor.recoverConnection(connection)
      return this.requestWithConnection<T>(recoveredConnection, path, init)
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
        : typeof body?.error === 'string' ? body.error : `写作风格请求失败（${String(response.status)}）`)
    }
    return response.json() as Promise<T>
  }
}
