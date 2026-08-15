import type { AxiosRequestConfig } from 'axios'

import type { AsrJob, CreateAsrJobInput } from '../../shared/sources'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'

const http = createLoggedHttpClient('gateway-asr')

export class AsrGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  createJob(input: Omit<CreateAsrJobInput,'mode'|'recordingId'|'durationMs'>): Promise<AsrJob> {
    return this.request('/v1/asr/jobs', { method: 'POST', data: input })
  }

  getJob(id: string): Promise<AsrJob> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效的转写任务标识。')
    return this.request(`/v1/asr/jobs/${encodeURIComponent(id)}`)
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await http.request<T & { message?: string }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      throw new Error(response.data?.message ?? `转写服务请求失败（${response.status}）`)
    }
    return response.data
  }
}
