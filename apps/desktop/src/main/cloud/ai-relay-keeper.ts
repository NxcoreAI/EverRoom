import type { AxiosRequestConfig } from 'axios'
import type { GatewaySupervisor } from '../gateway/gateway-supervisor'
import type { RuntimeConfigBridge } from '../gateway/runtime-config-bridge'
import { createLoggedHttpClient } from '../network/http-client'
import { redactDesktopText } from '../security/secret-redaction'
import { SaasRequestError, type SaasClient } from './saas-client'

// TTL 25min − 5min 余量。
const RENEW_INTERVAL_MS = 20 * 60_000
const NETWORK_FAILURE_FALLBACK_THRESHOLD = 3
/** 会话未激活（启动后首推前/会话过期）时的快速重试：10s 起步指数退避、
 *  60s 封顶。会话激活后再失败沿用 20min 周期（网关侧仍有 ~25min TTL）。 */
const INACTIVE_RETRY_BASE_MS = 10_000
const INACTIVE_RETRY_MAX_MS = 60_000

export type AiRelayKeeperEvent =
  | { type: 'quota-exhausted' }
  | { type: 'fallback-user' }
  | { type: 'fallback-restored' }
  | { type: 'session-activated' }

const http = createLoggedHttpClient('ai-relay-keeper')

/**
 * new-api 中转会话保活：SaaS 签发短期令牌后经 gateway 会话端点推入内存，
 * gateway 随即重写 LLM 槽位指向本地 /ai-relay 代理出口。约定：
 * - SaaS 403（无订阅/额度尽）是权威判定：清掉 gateway 会话并通知 renderer，
 *   不计网络失败、绝不回落 user 源（中转 402 同理，只在出口透传给消费方）。
 * - 连续网络失败 ≥3 次且当前为 default 源（中转驱动）时临时切 user 源保
 *   可用，恢复后自动切回 default；user 源不存在则保持现状下轮重试。
 */
export class AiRelayKeeper {
  private timer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryAttempts = 0
  /** 最近一次成功推送的会话到期时刻；0 = 尚未激活（启动后首推前）。 */
  private sessionActiveUntil = 0
  private cycleInFlight: Promise<void> | null = null
  private cyclePending = false
  private consecutiveFailures = 0
  private fellBackToUser = false

  constructor(
    private readonly client: SaasClient,
    private readonly supervisor: GatewaySupervisor,
    private readonly runtimeConfig: RuntimeConfigBridge,
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
    this.consecutiveFailures = 0
    this.retryAttempts = 0
    this.sessionActiveUntil = 0
    this.fellBackToUser = false
    await this.clearGatewaySession().catch(() => undefined)
  }

  renewNow(): Promise<void> {
    return this.cycle()
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
        await this.pushGatewaySession(issued.token, issued.expiresAt, issued.baseUrl)
        this.sessionActiveUntil = Date.parse(issued.expiresAt) || 0
        this.consecutiveFailures = 0
        this.retryAttempts = 0
        if (!wasActive) this.onEvent({ type: 'session-activated' })
        if (this.fellBackToUser) await this.restoreDefaultSource()
      } catch (error) {
        if (error instanceof SaasRequestError && error.status === 403) {
          await this.clearGatewaySession().catch(() => undefined)
          this.onEvent({ type: 'quota-exhausted' })
          return
        }
        this.consecutiveFailures += 1
        console.warn(`[desktop/ai-relay] token renewal failed (${this.consecutiveFailures}) | ${error instanceof Error ? error.message : String(error)}`)
        if (this.consecutiveFailures >= NETWORK_FAILURE_FALLBACK_THRESHOLD && !this.fellBackToUser) {
          await this.fallbackToUserSource()
        }
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

  private async pushGatewaySession(token: string, expiresAt: string, baseUrl: string): Promise<void> {
    const connection = await this.supervisor.ensureConnection()
    await this.gatewayRequest(connection, '/v1/ai-relay/session', {
      method: 'PUT',
      data: { baseUrl, token, expiresAt, proxyOrigin: connection.baseUrl },
    })
  }

  private async clearGatewaySession(): Promise<void> {
    if (!this.supervisor.isRunning()) return
    const connection = this.supervisor.getConnection()
    await this.gatewayRequest(connection, '/v1/ai-relay/session', { method: 'DELETE' })
  }

  private async fallbackToUserSource(): Promise<void> {
    try {
      const snapshot = await this.runtimeConfig.get()
      // 仅在 default 源激活时需要保护；user 源本就不经中转。
      if (snapshot.selectedSource !== 'default') return
      await this.runtimeConfig.selectSource('user')
      this.fellBackToUser = true
      this.onEvent({ type: 'fallback-user' })
    } catch (error) {
      console.warn(`[desktop/ai-relay] user-source fallback skipped | ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async restoreDefaultSource(): Promise<void> {
    this.fellBackToUser = false
    try {
      const snapshot = await this.runtimeConfig.get()
      if (snapshot.selectedSource !== 'user') return
      await this.runtimeConfig.selectSource('default')
      this.onEvent({ type: 'fallback-restored' })
    } catch (error) {
      console.warn(`[desktop/ai-relay] default-source restore failed | ${error instanceof Error ? error.message : String(error)}`)
    }
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
