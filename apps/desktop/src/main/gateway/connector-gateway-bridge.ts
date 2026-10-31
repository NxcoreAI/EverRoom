import type { AxiosRequestConfig } from 'axios'
import type {
  ConnectorAuthorizationAttempt,
  ConnectorProvidersResponse,
  ConnectorRemoteAccount,
  ConnectorStatus,
} from '@nxcore/connector-contract'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'

const http = createLoggedHttpClient('gateway-connectors')
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/

/**
 * 连接器的桌面桥（统一后的一版）：
 *   - 连接列表/状态实时读 oo（Gateway 代理）
 *   - 只保留授权、断开、远端旧账号探测
 *   - 同步 / scope / run / 邮件 / 文档 / 记录相关方法已随同步链路删除
 */
export class NangoConnectorGatewayBridge {
  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly openExternal: (url: string) => Promise<void> = async () => {
      throw new Error('无法打开授权页面。')
    },
  ) {}

  async status(): Promise<ConnectorStatus> {
    return this.request<ConnectorStatus>('/v1/nango-connectors/status')
  }

  providers(): Promise<ConnectorProvidersResponse> {
    return this.request('/v1/nango-connectors/providers')
  }

  /**
   * SaaS 侧已配置 OAuth 的 provider 名单（「待连接」网格只显示这些）。
   * 仅 saas 连接层有实现；local 模式返回 null，渲染层回落注册表。
   */
  configuredProviders(): Promise<string[] | null> {
    return Promise.resolve(null)
  }

  /**
   * 同上，但带 SaaS 下发的应用元数据（provider → displayName/iconUrl）。
   * local 模式无 SaaS 目录，同样返回 null。
   */
  configuredProvidersDetailed(): Promise<Array<{ provider: string; displayName: string | null; iconUrl: string | null }> | null> {
    return Promise.resolve(null)
  }

  /**
   * oo 会话热推送（登录换取/登出拆除）：gateway 原地 patch 连接配置。
   */
  applyConnectorSession(session: { baseUrl: string; runtimeToken?: string } | null): Promise<{ configured: boolean; baseUrl: string }> {
    return session
      ? this.request('/v1/connector-session', {
        method: 'PUT',
        data: { baseUrl: session.baseUrl, ...(session.runtimeToken ? { runtimeToken: session.runtimeToken } : {}) },
      })
      : this.request('/v1/connector-session', { method: 'DELETE' })
  }

  async startAuthorization(provider: string): Promise<ConnectorAuthorizationAttempt> {
    if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error('不支持的连接提供方。')
    const result = await this.request<ConnectorAuthorizationAttempt & { authorizationUrl: string }>(
      '/v1/nango-connectors/authorizations',
      { method: 'POST', data: { provider } },
    )
    const authorizationUrl = new URL(result.authorizationUrl)
    if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
      throw new Error('返回了不安全的授权地址。')
    }
    await this.openExternal(authorizationUrl.toString())
    return {
      id: result.id,
      provider: result.provider,
      status: result.status,
      expiresAt: result.expiresAt,
      connection: result.connection,
      error: result.error,
    }
  }

  authorizationStatus(id: string): Promise<ConnectorAuthorizationAttempt> {
    return this.request(`/v1/nango-connectors/authorizations/${this.id(id)}`)
  }

  /** 远端 oo 租户旧授权探测：仅 saas 连接层实现（直连 oo 数据面）；local 模式无远端租户。 */
  remoteAccount(_provider: string): Promise<ConnectorRemoteAccount | null> {
    return Promise.resolve(null)
  }

  async purgeConnection(id: string): Promise<void> {
    await this.request(`/v1/nango-connectors/connections/${this.id(id)}`, { method: 'DELETE' })
  }

  /**
   * 重新开启：移除本地墓碑（oo 凭据一直在），连接回到可见/可查询状态。
   * 「开启开关」的实现——与 oo 侧 token 的存在性解耦。
   */
  async reconnectConnection(id: string): Promise<void> {
    await this.request(`/v1/nango-connectors/connections/${this.id(id)}/reconnect`, { method: 'POST' })
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await http.request<T & { message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: { Authorization: `Bearer ${connection.token}`, ...config.headers },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      const message = typeof response.data?.message === 'string' ? response.data.message : `连接器请求失败（${response.status}）`
      throw new Error(message.slice(0, 500))
    }
    return response.data
  }

  private id(value: string): string {
    if (!ID_PATTERN.test(value)) throw new Error('无效的连接器标识。')
    return encodeURIComponent(value)
  }
}

// Compatibility export for the legacy IPC router name used by older builds.
export { NangoConnectorGatewayBridge as ConnectorGatewayBridge }
