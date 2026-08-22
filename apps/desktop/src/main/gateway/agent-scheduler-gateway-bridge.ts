import type { AgentScheduledTask } from '../../shared/sources'
import type { AxiosRequestConfig } from 'axios'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'

const http = createLoggedHttpClient('gateway-agent-scheduler', undefined, { quiet: true })

export class AgentSchedulerGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}
  list(): Promise<AgentScheduledTask[]> { return this.request('/v1/agent/schedules') }
  create(input: { agentId: string; name: string; description?: string; prompt: string; localTime?: string; timezone?: string; enabled?: boolean }): Promise<AgentScheduledTask> {
    return this.request('/v1/agent/schedules', { method: 'POST', data: input })
  }
  update(id: string, input: Partial<Pick<AgentScheduledTask, 'name' | 'description' | 'prompt' | 'enabled' | 'localTime' | 'timezone'>> & { configVersion: number }): Promise<AgentScheduledTask> {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', data: input })
  }
  runNow(id: string): Promise<{ runId: string }> {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' })
  }
  remove(id: string): Promise<void> {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    const hasBody = config.data !== undefined && config.data !== null
    const data = hasBody && typeof config.data === 'object' && !(config.data instanceof FormData)
      ? JSON.stringify(config.data)
      : config.data
    const response = await http.request<T & { error?: unknown; message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      ...(hasBody ? { data } : {}),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === 'string' ? response.data.message
          : typeof response.data?.error === 'string' ? response.data.error
            : typeof response.data === 'string' ? response.data
            : `Agent 定时任务请求失败（${response.status}）`,
      )
    }
    if (response.status === 204) return undefined as T
    return response.data
  }
}
