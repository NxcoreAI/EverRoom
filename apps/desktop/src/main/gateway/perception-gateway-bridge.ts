import type { GatewaySupervisor } from './gateway-supervisor'
import type { PerceptionNode, PerceptionNodeDetail, PerceptionNodeQuery } from '../../shared/sources'

export interface PerceptionSettings {
  captureEnabled: boolean
  captureIntervalSeconds: number
  onlineVlmEnabled: boolean
  configVersion: number
  updatedAt: string
}

export class PerceptionGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  getSettings(): Promise<PerceptionSettings> {
    return this.request('/v1/perception/settings')
  }

  async updateCapture(input: { enabled?: boolean; intervalMs?: number }): Promise<PerceptionSettings> {
    const current = await this.getSettings()
    return this.request('/v1/perception/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        configVersion: current.configVersion,
        ...(input.enabled === undefined ? {} : { captureEnabled: input.enabled }),
        ...(input.intervalMs === undefined ? {} : { captureIntervalSeconds: Math.round(input.intervalMs / 1_000) }),
      }),
    })
  }

  async updateOnlineVlm(enabled: boolean, configVersion: number): Promise<PerceptionSettings> {
    try {
      return await this.request('/v1/perception/settings', {
        method: 'PATCH', body: JSON.stringify({ onlineVlmEnabled: enabled, configVersion }),
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('perception_settings_conflict')) throw error
      const current = await this.getSettings()
      return this.request('/v1/perception/settings', {
        method: 'PATCH', body: JSON.stringify({ onlineVlmEnabled: enabled, configVersion: current.configVersion }),
      })
    }
  }

  listNodes(query: PerceptionNodeQuery = {}): Promise<{ items: PerceptionNode[] }> {
    const params = new URLSearchParams()
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.kind) params.set('kind', query.kind)
    if (query.status) params.set('status', query.status)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return this.request(`/v1/perception/nodes${suffix}`)
  }

  getNode(id: string): Promise<PerceptionNodeDetail> {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}`)
  }

  retryNode(id: string): Promise<{ accepted: boolean }> {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  }

  deleteNode(id: string, deleteAssets = false): Promise<{
    deleted: boolean
    deletedAssets: string[]
    retainedAssets: string[]
  }> {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}?deleteAssets=${String(deleteAssets)}`, {
      method: 'DELETE',
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const code = typeof body?.error === 'string' ? body.error : ''
      throw new Error(code === 'vlm_not_configured' ? '请先配置在线视觉模型后再开启视觉理解。'
        : typeof body?.message === 'string' ? body.message
          : code || `感知设置请求失败（${String(response.status)}）`)
    }
    return response.json() as Promise<T>
  }
}
