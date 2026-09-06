import { randomUUID } from 'node:crypto'

import type { ConnectorAuthorizationAttempt } from '@nxcore/connector-contract'

import { ConnectorGatewayBridge } from './connector-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'

/** SaaS 连接层授权依赖（由主进程注入当前登录态与 oo 会话的读取器）。 */
export interface SaasConnectorBridgeDeps {
  /** SaaS 代发起授权：POST /app/connectors/authorizations → { authorizationUrl }。 */
  startAuthorization: (service: string) => Promise<{ authorizationUrl: string }>
  /** 当前 oo 会话；未登录或会话未就绪时为 null。 */
  ooSession: () => { baseUrl: string; token: string } | null
}

const AUTHORIZATION_TTL_MS = 15 * 60_000
const PROBE_TIMEOUT_MS = 5_000

interface PendingAttempt {
  provider: string
  expiresAt: string
}

/**
 * saas 连接层的授权面桥：客户端不持有 oo admin token，gateway 无法代发起授权，
 * startAuthorization 改经 SaaS 调 oo admin 面代发起（redirect_uri 指向 oo 公网
 * 回调，state 锁定用户租户，凭证由 oo 直落用户租户）；授权结果也不轮询
 * gateway，而是持用户 token 直查 oo 数据面
 * （GET /v1/apps/services/:service）等连接落地。其余数据面通道（连接/范围/
 * 同步/邮件/文档/记录）全部委托 gateway 桥，行为不变。
 */
export class SaasConnectorBridge extends ConnectorGatewayBridge {
  private readonly pending = new Map<string, PendingAttempt>()
  private readonly completed = new Map<string, ConnectorAuthorizationAttempt>()
  private readonly registering = new Set<string>()
  private readonly openAuthorizationPage: (url: string) => Promise<void>

  constructor(
    supervisor: GatewaySupervisor,
    openExternal: (url: string) => Promise<void>,
    private readonly deps: SaasConnectorBridgeDeps,
  ) {
    super(supervisor, openExternal)
    this.openAuthorizationPage = openExternal
  }

  async startAuthorization(provider: string): Promise<ConnectorAuthorizationAttempt> {
    if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error('不支持的连接提供方。')
    const { authorizationUrl } = await this.deps.startAuthorization(provider)
    const url = new URL(authorizationUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('SaaS 返回了不安全的授权地址。')
    }
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString()
    this.pending.set(id, { provider, expiresAt })
    await this.openAuthorizationPage(url.toString())
    return { id, provider, status: 'pending', expiresAt, connection: null, error: null }
  }

  async authorizationStatus(id: string): Promise<ConnectorAuthorizationAttempt> {
    const completed = this.completed.get(id)
    if (completed) return completed
    const attempt = this.pending.get(id)
    if (!attempt) return super.authorizationStatus(id)
    const base: ConnectorAuthorizationAttempt = {
      id,
      provider: attempt.provider,
      status: 'pending',
      expiresAt: attempt.expiresAt,
      connection: null,
      error: null,
    }
    if (Date.now() > Date.parse(attempt.expiresAt)) {
      this.pending.delete(id)
      return { ...base, status: 'expired', error: '授权超时，请重新连接。' }
    }
    const session = this.deps.ooSession()
    if (!session) return base
    try {
      const response = await fetch(
        `${session.baseUrl}/v1/apps/services/${encodeURIComponent(attempt.provider)}`,
        { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      )
      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as { data?: unknown } | null
        if (Array.isArray(payload?.data) && payload.data.length > 0) {
          // 连接已落在 oo 租户，但 gateway 的连接注册表（连接器列表/scope/同步
          // 的数据源）只在 manager.register 时建立——与 Seam4 授权完成路径对齐，
          // 此处显式补注册；失败则留在 pending 由下一轮轮询重试。
          if (this.registering.has(id)) return base
          this.registering.add(id)
          try {
            const connection = await this.registerConnection({
              provider: attempt.provider,
              service: attempt.provider,
              connectionName: 'default',
            })
            this.pending.delete(id)
            const result: ConnectorAuthorizationAttempt = { ...base, status: 'connected', connection }
            this.completed.set(id, result)
            return result
          } catch {
            // gateway 暂不可达/注册失败：恢复 pending，下轮重试。
            return base
          } finally {
            this.registering.delete(id)
          }
        }
      }
    } catch {
      // oo 暂不可达：保持 pending，由渲染层轮询兜底。
    }
    return base
  }
}
