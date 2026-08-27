import type { AxiosRequestConfig } from 'axios'
import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../shared/sources'
import type { SaasRuntimeConfig } from '../cloud/saas-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { createLoggedHttpClient } from '../network/http-client'
import { redactDesktopText, registerDesktopSecret } from '../security/secret-redaction'

const http = createLoggedHttpClient('gateway-runtime-config')

export type { RuntimeConfigTestResult }

export interface RuntimeMemoryConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  serviceId: string
  teamId: string
  agentId: string
  userId: string
  recallLimit: number
  charBudget: number
  timeoutMs?: number
}

export class RuntimeConfigBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  get(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config') }
  /** 仅供主进程：未脱敏 snapshot（派生托管子进程 env 需要真密钥）。不得转发给渲染层。 */
  getSecrets(): Promise<RuntimeConfigSnapshot> { return this.request('/v1/runtime-config/secrets') }
  saveUser(config: unknown): Promise<RuntimeConfigSnapshot> {
    const key = (config as { webSearch?: { apiKey?: unknown } } | null)?.webSearch?.apiKey
    if (typeof key === 'object' && key && 'operation' in key && key.operation === 'set' && 'value' in key && typeof key.value === 'string') {
      registerDesktopSecret(key.value)
    }
    return this.request('/v1/runtime-config/user', { method: 'PUT', data: config })
  }
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

  injectMemory(config: RuntimeMemoryConfig): Promise<{ enabled: boolean }> {
    return this.request('/v1/memory/config', { method: 'PUT', data: config })
  }

  disableMemory(): Promise<{ enabled: boolean }> {
    return this.request('/v1/memory/config', { method: 'DELETE' })
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
    if (response.status >= 400) throw new Error(redactDesktopText((response.data as { message?: string } | undefined)?.message ?? `运行时配置请求失败（${response.status}）`))
    return response.data
  }
}
