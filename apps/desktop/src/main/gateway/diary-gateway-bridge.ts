import type { DiaryDayDetails, DiaryRun, DiarySettings } from '../../shared/sources'
import type { GatewaySupervisor } from './gateway-supervisor'

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

  run(id: string): Promise<DiaryRun> {
    return this.request(`/v1/diary/runs/${encodeURIComponent(id)}`)
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
