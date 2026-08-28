import type { DiaryDayDetails, DiaryRun, DiarySettings } from '../../shared/sources'
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

export class DiaryGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  settings(): Promise<DiarySettings> {
    return this.request('/v1/diary/settings')
  }

  updateSettings(input: Partial<Pick<DiarySettings, 'enabled' | 'localTime' | 'timezone'>> & { configVersion: number }): Promise<DiarySettings> {
    return this.request('/v1/diary/settings', { method: 'PATCH', body: JSON.stringify(input) })
  }

  generate(date: string): Promise<{ runId: string }> {
    return this.request(`/v1/diary/days/${encodeURIComponent(date)}/generate`, { method: 'POST' })
  }

  // 运行记录可能随网关数据重置而消失；返回 null 让前端停止轮询并恢复按钮，
  // 否则会每 2 秒重试 404，把 activeRun 永久卡在“生成中”。
  run(id: string): Promise<DiaryRun | null> {
    return this.requestMaybe<DiaryRun>(`/v1/diary/runs/${encodeURIComponent(id)}`, undefined, true)
  }

  activeRun(): Promise<DiaryRun | null> {
    return this.request('/v1/diary/runs/active')
  }

  days(start: string, end: string): Promise<DiaryDayDetails['day'][]> {
    return this.request(`/v1/diary/days?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
  }

  day(date: string): Promise<DiaryDayDetails | null> {
    return this.requestMaybe(`/v1/diary/days/${encodeURIComponent(date)}`, undefined, true)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return this.requestMaybe<T>(path, init, false) as Promise<T>
  }

  private async requestMaybe<T>(path: string, init: RequestInit | undefined, allowNotFound: boolean): Promise<T | null> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path, init, allowNotFound)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recoveredConnection = await this.supervisor.recoverConnection(connection)
      return this.requestWithConnection<T>(recoveredConnection, path, init, allowNotFound)
    }
  }

  private async requestWithConnection<T>(
    connection: GatewayConnection,
    path: string,
    init: RequestInit | undefined,
    allowNotFound: boolean,
  ): Promise<T | null> {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    if (allowNotFound && response.status === 404) return null
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      throw new Error(typeof body?.message === 'string' ? body.message
        : typeof body?.error === 'string' ? body.error : `日记请求失败（${String(response.status)}）`)
    }
    return response.json() as Promise<T>
  }
}
