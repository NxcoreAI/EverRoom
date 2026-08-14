import type { AsrJob, CreateAsrJobInput } from '../../shared/sources'
import type { GatewaySupervisor } from './gateway-supervisor'

export class AsrGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  createJob(input: Omit<CreateAsrJobInput,'mode'|'recordingId'|'durationMs'>): Promise<AsrJob> {
    return this.request('/v1/asr/jobs', { method: 'POST', body: JSON.stringify(input) })
  }

  getJob(id: string): Promise<AsrJob> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的转写任务标识。')
    return this.request(`/v1/asr/jobs/${encodeURIComponent(id)}`)
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    const body = await response.json() as T & { message?: string }
    if (!response.ok) throw new Error(body.message ?? `转写服务请求失败（${response.status}）`)
    return body
  }
}
