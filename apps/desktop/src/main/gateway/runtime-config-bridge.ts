import type { AxiosRequestConfig } from 'axios'
import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../shared/sources'
import type { SaasRuntimeConfig } from '../cloud/saas-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { createLoggedHttpClient } from '../network/http-client'

const http = createLoggedHttpClient('gateway-runtime-config')

export type { RuntimeConfigTestResult }

export class RuntimeConfigBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  get(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config') }
  saveUser(config: unknown): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/user', { method: 'PUT', data: config }) }
  clearUser(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/user', { method: 'DELETE' }) }
  saveSaas(config: SaasRuntimeConfig['config']): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/saas', { method: 'PUT', data: { schemaVersion: 1, ...config } }) }
  clearSaas(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/saas', { method: 'DELETE' }) }
  selectSource(source: 'user' | 'saas' | 'default'): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/source', { method: 'PUT', data: { source } }) }
  test(): Promise<RuntimeConfigTestResult> {
    // 带 {} 而不是空 body：axios 对无 data 的 POST 会补
    // application/x-www-form-urlencoded 头，Fastify 5 对不可解析的
    // content-type 直接 415。
    return this.request('/v1/runtime-config/test', { method: 'POST', data: {} })
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    const response = await http.request<T>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」直接
        // 400（FST_ERR_CTP_EMPTY_JSON_BODY），POST test / GET / DELETE 均无 body
        ...(config.data ? { 'Content-Type': 'application/json' } : {}),
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) throw new Error((response.data as { message?: string } | undefined)?.message ?? `运行时配置请求失败（${response.status}）`)
    return response.data
  }
}
