import type { AxiosRequestConfig } from 'axios'
import type { GatewaySupervisor } from '../gateway/gateway-supervisor'
import { createLoggedHttpClient } from '../network/http-client'
import { redactDesktopText } from '../security/secret-redaction'
import { SaasRequestError, type AiPlanModels, type SaasClient } from './saas-client'

// TTL 25min − 5min 余量。
const RENEW_INTERVAL_MS = 20 * 60_000
/** 会话未激活（启动后首推前/会话过期）时的快速重试：10s 起步指数退避、
 *  60s 封顶。会话激活后再失败沿用 20min 周期（网关侧仍有 ~25min TTL）。 */
const INACTIVE_RETRY_BASE_MS = 10_000
const INACTIVE_RETRY_MAX_MS = 60_000

export type AiRelayKeeperEvent =
  | { type: 'quota-exhausted' }
  | { type: 'session-activated' }
  | { type: 'models-changed' }

const http = createLoggedHttpClient('ai-relay-keeper')

/**
 * new-api 中转会话保活：SaaS 签发短期令牌后经 gateway 会话端点推入内存，
 * gateway 随即重写官方 LLM 槽位指向本地 /ai-relay 代理出口。约定：
 * - SaaS 403（无订阅）/ 402（周期额度不足）是权威判定：清掉 gateway 会话并
 *   通知 renderer，不计网络失败、绝不回落（中转 402 同理，只在出口透传给
 *   消费方）。
 * - 网络失败只重试，不翻运行时配置源：配置源的切换是用户在设置页的显式
 *   操作，自动翻转会让已保存的自定义配置「看起来被重置」（issue #283）；
 *   网关侧槽位级语义下用户直连槽位本就不经中转，无需整源兜底。
 */
export class AiRelayKeeper {
  private timer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryAttempts = 0
  /** 最近一次成功推送的会话到期时刻；0 = 尚未激活（启动后首推前）。 */
  private sessionActiveUntil = 0
  private cycleInFlight: Promise<void> | null = null
  private cyclePending = false
  /** 最近一次成功推送的场景模型 JSON；续签时检测 SaaS 侧套餐模型变更。 */
  private lastModelsJson: string | null = null
  /** SaaS 已权威判定额度耗尽（402/403）：兑换/周期重置后续签成功才清除。 */
  private quotaExhaustedFlag = false

  constructor(
    private readonly client: SaasClient,
    private readonly supervisor: GatewaySupervisor,
    private readonly onEvent: (event: AiRelayKeeperEvent) => void = () => undefined,
  ) {}

  /** 登录成功或会话恢复后启动；重复调用安全。 */
  start(): void {
    if (this.timer) return
    void this.cycle()
    this.timer = setInterval(() => void this.cycle(), RENEW_INTERVAL_MS)
  }

  /** 退出登录、应用停机或账号切换前停止，并拆除 gateway 会话。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryAttempts = 0
    this.sessionActiveUntil = 0
    this.lastModelsJson = null
    this.quotaExhaustedFlag = false
    await this.clearGatewaySession().catch(() => undefined)
  }

  renewNow(): Promise<void> {
    return this.cycle()
  }

  /** SaaS 权威判定额度耗尽且尚未恢复；keeper 未启动/未判定时为 false。 */
  isQuotaExhausted(): boolean {
    return this.quotaExhaustedFlag
  }

  private cycle(): Promise<void> {
    if (this.cycleInFlight) {
      this.cyclePending = true
      return this.cycleInFlight
    }
    const attempt = async () => {
      try {
        const wasActive = Date.now() < this.sessionActiveUntil
        const issued = await this.client.issueAiGatewayToken()
        await this.pushGatewaySession(issued.token, issued.expiresAt, issued.baseUrl, issued.models ?? null)
        this.sessionActiveUntil = Date.parse(issued.expiresAt) || 0
        this.retryAttempts = 0
        this.quotaExhaustedFlag = false
        if (!wasActive) this.onEvent({ type: 'session-activated' })
        const modelsJson = JSON.stringify(issued.models ?? null)
        if (wasActive && this.lastModelsJson !== null && modelsJson !== this.lastModelsJson) {
          this.onEvent({ type: 'models-changed' })
        }
        this.lastModelsJson = modelsJson
      } catch (error) {
        // 403（无订阅）与 402（周期额度不足，isSaasPermanentError）同为 SaaS
        // 权威判定：清会话、通知 renderer，不计网络失败、绝不回落。
        if (error instanceof SaasRequestError && (error.status === 403 || error.status === 402)) {
          await this.clearGatewaySession().catch(() => undefined)
          this.quotaExhaustedFlag = true
          this.onEvent({ type: 'quota-exhausted' })
          return
        }
        console.warn(`[desktop/ai-relay] token renewal failed | ${error instanceof Error ? error.message : String(error)}`)
        if (Date.now() >= this.sessionActiveUntil) this.scheduleInactiveRetry()
      }
    }
    this.cycleInFlight = attempt().finally(() => {
      this.cycleInFlight = null
      if (this.cyclePending) {
        this.cyclePending = false
        queueMicrotask(() => void this.cycle())
      }
    })
    return this.cycleInFlight
  }

  /** 会话尚未激活时的退避重试：固定 20min 周期会让启动期一次网络抖动把
   *  登录门卡在未就绪状态最长 20 分钟。仅在 keeper 运行中排程（stop 后不再）。 */
  private scheduleInactiveRetry(): void {
    if (this.retryTimer || this.timer === null) return
    const delay = Math.min(INACTIVE_RETRY_BASE_MS * 2 ** this.retryAttempts, INACTIVE_RETRY_MAX_MS)
    this.retryAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.cycle()
    }, delay)
  }

  private async pushGatewaySession(
    token: string,
    expiresAt: string,
    baseUrl: string,
    models: AiPlanModels | null,
  ): Promise<void> {
    const connection = await this.supervisor.ensureConnection()
    await this.gatewayRequest(connection, '/v1/ai-relay/session', {
      method: 'PUT',
      data: { baseUrl, token, expiresAt, proxyOrigin: connection.baseUrl, models: models ?? undefined },
    })
  }

  private async clearGatewaySession(): Promise<void> {
    if (!this.supervisor.isRunning()) return
    const connection = this.supervisor.getConnection()
    await this.gatewayRequest(connection, '/v1/ai-relay/session', { method: 'DELETE' })
  }

  private async gatewayRequest(connection: { baseUrl: string; token: string }, path: string, config: AxiosRequestConfig = {}): Promise<void> {
    const response = await http.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(config.data ? { 'Content-Type': 'application/json' } : {}),
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      throw new Error(redactDesktopText((response.data as { message?: string } | undefined)?.message ?? `AI relay session request failed (${response.status})`))
    }
  }
}
