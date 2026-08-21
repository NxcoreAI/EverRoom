import type { AxiosRequestConfig } from 'axios'
import type { RuntimeConfigSnapshot } from '../../shared/sources'
import type { SaasRuntimeConfig } from '../cloud/saas-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { createLoggedHttpClient } from '../network/http-client'

const http = createLoggedHttpClient('gateway-runtime-config')

export class RuntimeConfigBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  get(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config') }
  saveUser(config: unknown): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/user', { method: 'PUT', data: config }) }
  clearUser(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/user', { method: 'DELETE' }) }
  saveSaas(config: SaasRuntimeConfig['config']): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/saas', { method: 'PUT', data: { schemaVersion: 1, ...config } }) }
  clearSaas(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/saas', { method: 'DELETE' }) }
  selectSource(source: 'user' | 'saas' | 'default'): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/source', { method: 'PUT', data: { source } }) }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    const response = await http.request<T>({ url: `${connection.baseUrl}${path}`, ...config, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', ...config.headers }, validateStatus: () => true })
    if (response.status >= 400) throw new Error((response.data as { message?: string } | undefined)?.message ?? `运行时配置请求失败（${response.status}）`)
    return response.data
  }
}
