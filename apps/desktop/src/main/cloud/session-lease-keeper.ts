import { SaasRequestError, type SaasClient } from './saas-client'

const LEASE_INTERVAL_MS = 30_000

/**
 * 在线租约续期：登录成功后每 30 秒 PUT /app/session/lease，保持桌面在设备
 * 在线额度中的席位。约定：
 * - 禁止重叠：单个 in-flight promise + pending 标记，续租完成后再排下一轮。
 * - 401 由 SaasClient.request 内部自动刷新重试，这里只处理刷新后仍失败的情况。
 * - 409 DEVICE_LIMIT_REACHED：额度已被占满，停止 timer 并通知上层进入设备
 *   准入流程，不静默覆盖当前状态。
 * - 404：旧版 SaaS 未部署该路由，指数退避后重试（对齐 AgentStatusReporter）。
 */
export class SessionLeaseKeeper {
  private timer: NodeJS.Timeout | null = null
  private renewInFlight: Promise<void> | null = null
  private renewPending = false
  private endpointUnavailable = false
  private endpointRetryAt = 0

  constructor(
    private readonly client: SaasClient,
    private readonly onAdmissionRequired: () => void = () => undefined,
  ) {}

  /** 登录成功或会话恢复后启动；重复调用安全。 */
  start(): void {
    if (this.timer) return
    void this.renew()
    this.timer = setInterval(() => void this.renew(), LEASE_INTERVAL_MS)
  }

  /** 退出登录、应用停机或账号切换前停止。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.endpointUnavailable = false
    this.endpointRetryAt = 0
  }

  /** 账号切换后重置内部状态（复用同一个 keeper 实例）。 */
  reset(): void {
    this.stop()
    this.start()
  }

  renewNow(): Promise<void> {
    return this.renew()
  }

  private renew(): Promise<void> {
    if (this.endpointUnavailable && Date.now() < this.endpointRetryAt) return Promise.resolve()
    if (this.endpointUnavailable) this.endpointUnavailable = false
    if (this.renewInFlight) {
      this.renewPending = true
      return this.renewInFlight
    }
    const attempt = async () => {
      await this.client.renewSessionLease()
    }
    this.renewInFlight = attempt().then(() => undefined).catch((error: unknown) => {
      if (error instanceof SaasRequestError) {
        if (error.status === 404) {
          this.endpointUnavailable = true
          this.endpointRetryAt = Date.now() + 60_000
        } else if (error.status === 409) {
          // 设备额度被占满：停止续租，交给设备准入 UI。
          this.stop()
          this.onAdmissionRequired()
        } else if (error.status !== 401 && error.status !== 403) {
          console.warn(`[desktop/session-lease] renewal rejected | status=${String(error.status)} message=${error.message}`)
        }
      }
    }).finally(() => {
      this.renewInFlight = null
      if (this.renewPending) {
        this.renewPending = false
        queueMicrotask(() => void this.renew())
      }
    })
    return this.renewInFlight
  }
}
