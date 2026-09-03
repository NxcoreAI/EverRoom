import { randomUUID } from 'node:crypto'
import type {
  AgentAuthEnvironmentStatus,
  AgentAuthEventFrame,
  AgentAuthStartInput,
  DesktopAgentAuthChallenge,
} from '../../shared/agent-auth'
import { extractVerificationUrl, LarkAuthRunner } from './lark-auth-runner'

/**
 * Agent 授权引导控制器（本地、内存态）。飞书两阶段（应用初始化 → 用户 OAuth）
 * 都由本控制器驱动 CLI 子进程并在本地完成 device code 轮询；应用重启后未完成
 * 的 challenge 过期作废，不复用旧 verification URL / device code（方案 §7.4）。
 * challenge 状态不落 Gateway 数据库；device code 不过 IPC。
 */

const CHALLENGE_TTL_MS = 30 * 60_000

export interface AgentAuthEnvironment {
  environment?: NodeJS.ProcessEnv
  onEvent?: (frame: AgentAuthEventFrame) => void
}

export class AgentAuthController {
  private readonly listeners = new Set<(frame: AgentAuthEventFrame) => void>()
  private challenge: DesktopAgentAuthChallenge | null = null
  private deviceCode: string | null = null
  private activeRequestId: string | null = null
  private environmentCache: AgentAuthEnvironmentStatus['feishu'] | null = null

  constructor(
    private readonly runner: LarkAuthRunner,
    private readonly options: AgentAuthEnvironment = {},
  ) {}

  onEvent(listener: (frame: AgentAuthEventFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  gatewayEnvironment(): Record<string, string> {
    return this.runner.gatewayEnvironment()
  }

  async status(): Promise<AgentAuthEnvironmentStatus> {
    const feishu = await this.feishuEnvironment()
    this.environmentCache = feishu
    return { feishu, activeChallenge: this.currentChallenge() }
  }

  async start(input: AgentAuthStartInput): Promise<DesktopAgentAuthChallenge> {
    if (this.challenge && this.challenge.status === 'pending') {
      throw new Error('已有进行中的授权流程，请先完成或取消。')
    }
    if (input.provider === 'feishu') {
      const version = await this.runner.version()
      if (!version) throw new Error('lark-cli 不可用，请先通过产品更新修复导出环境。')
      return input.phase === 'app_setup'
        ? this.startFeishuAppSetup(input.exportRunId ?? null)
        : this.startFeishuUserAuth(input.exportRunId ?? null)
    }
    // Notion：导出授权 = OpenConnector 连接，由用户在连接器管理界面完成；
    // 这里只生成卡片引导，完成与否由用户重试导出时的只读检查判定。
    return this.beginChallenge({
      provider: 'notion',
      phase: 'user_auth',
      reason: 'not_connected',
      title: 'Notion Agent 导出授权未建立',
      exportRunId: input.exportRunId ?? null,
      steps: [
        {
          id: 'connect',
          title: '打开连接器管理并建立 Notion 连接',
          description: '该授权与导入连接是两套凭据域；如两者都需要，请分别完成。',
          action: 'open_connector_console',
          completed: false,
        },
        {
          id: 'retry',
          title: '回到导出面板重新发起导出',
          description: null,
          action: 'user_confirm',
          completed: false,
        },
      ],
    })
  }

  cancel(challengeId?: string): DesktopAgentAuthChallenge | null {
    if (!this.challenge) return null
    if (challengeId && this.challenge.id !== challengeId) return this.currentChallenge()
    if (this.activeRequestId) this.runner.cancel(this.activeRequestId)
    this.updateChallenge({ status: 'cancelled', message: '用户取消了授权' })
    const removed = this.challenge
    this.challenge = null
    this.deviceCode = null
    this.activeRequestId = null
    this.emit({ type: 'challenge.removed', challengeId: removed.id })
    return null
  }

  /** 重新检查授权状态（授权完成后卡片刷新；对 feishu 走真实 auth status）。 */
  async resume(challengeId: string): Promise<DesktopAgentAuthChallenge | null> {
    if (!this.challenge || this.challenge.id !== challengeId) return this.currentChallenge()
    if (this.challenge.provider === 'feishu') {
      try {
        const status = await this.runner.authStatus()
        if (this.challenge.phase === 'app_setup' && status.appConfigured) {
          this.updateChallenge({
            status: 'authorized',
            message: '飞书应用已配置，继续进行用户授权',
            steps: this.challenge.steps.map((step) => ({ ...step, completed: true })),
          })
          // 应用配置完成后，用户授权是下一个独立阶段。
          return this.startFeishuUserAuth(this.challenge.exportRunId)
        }
        if (this.challenge.phase === 'user_auth' && status.userAuthorized) {
          // 授权完成后卡片保留在会话流中显示"已授权"状态（用户手动关闭或下次
          // 授权开始时才移除），不自动消失。
          this.updateChallenge({
            status: 'authorized',
            message: `已完成授权${status.userName ? `（${status.userName}）` : ''}，可回到导出面板重新发起导出`,
            verificationUrl: null,
            steps: this.challenge.steps.map((step) => ({ ...step, completed: true })),
          })
          this.deviceCode = null
          void this.status().then(() => undefined)
          return this.currentChallenge()
        }
      } catch (error) {
        this.updateChallenge({
          message: `状态检查失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    return this.currentChallenge()
  }

  shutdown(): void {
    this.runner.shutdown()
    this.listeners.clear()
  }

  private startFeishuAppSetup(exportRunId: string | null): DesktopAgentAuthChallenge {
    const requestId = this.runner.newRequestId('lark-config')
    this.activeRequestId = requestId
    const challenge = this.beginChallenge({
      provider: 'feishu',
      phase: 'app_setup',
      reason: 'app_setup_required',
      title: '创建并配置自己的飞书应用',
      exportRunId,
      steps: [
        {
          id: 'open-browser',
          title: '在浏览器中完成应用创建与权限配置',
          description: '点击 CLI 返回的引导链接，按页面提示创建应用',
          action: 'open_url',
          completed: false,
        },
        {
          id: 'wait-local',
          title: '等待本地 CLI 接收配置结果',
          description: '凭据将写入本机系统安全存储，不经过 EverRoom 服务端',
          action: 'wait_local_result',
          completed: false,
        },
      ],
    })
    void this.runner.configInitNew(requestId, (chunk) => {
      const url = extractVerificationUrl(chunk)
      if (url && this.challenge?.id === challenge.id && !this.challenge.verificationUrl) {
        this.updateChallenge({
          verificationUrl: url,
          steps: this.challenge.steps.map((step) => (
            step.id === 'open-browser' ? { ...step, url, completed: true } : step
          )),
        })
      }
    }).then(() => {
      if (this.challenge?.id !== challenge.id) return
      this.activeRequestId = null
      // CLI 成功返回即应用已配置；进入用户授权阶段。
      void this.resume(challenge.id)
    }).catch((error: unknown) => {
      if (this.challenge?.id !== challenge.id) return
      this.activeRequestId = null
      this.updateChallenge({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    })
    return challenge
  }

  private startFeishuUserAuth(exportRunId: string | null): DesktopAgentAuthChallenge {
    const challenge = this.beginChallenge({
      provider: 'feishu',
      phase: 'user_auth',
      reason: 'not_connected',
      title: '授权飞书账号',
      exportRunId,
      steps: [
        {
          id: 'open-browser',
          title: '打开授权页面，扫码或登录并同意最小权限',
          description: '仅申请文档写入所需权限（docs、drive 域）',
          action: 'open_url',
          completed: false,
        },
        {
          id: 'wait-local',
          title: '本地轮询授权结果',
          description: null,
          action: 'wait_local_result',
          completed: false,
        },
      ],
    })
    const noWaitId = this.runner.newRequestId('lark-login')
    this.activeRequestId = noWaitId
    void this.runner.authLoginNoWait(noWaitId)
      .then((result) => {
        if (this.challenge?.id !== challenge.id) return null
        if (!result.deviceCode) {
          this.updateChallenge({
            status: 'failed',
            message: 'lark-cli 未返回 device code，无法继续授权',
          })
          return null
        }
        this.deviceCode = result.deviceCode
        this.updateChallenge({
          verificationUrl: result.verificationUrl,
          steps: this.challenge.steps.map((step) => (
            step.id === 'open-browser' && result.verificationUrl
              ? { ...step, url: result.verificationUrl }
              : step
          )),
        })
        const pollId = this.runner.newRequestId('lark-poll')
        this.activeRequestId = pollId
        return this.runner.authLoginPoll(pollId, result.deviceCode)
      })
      .then((outcome) => {
        if (!outcome || this.challenge?.id !== challenge.id) return
        this.activeRequestId = null
        if (outcome.code === 0) {
          void this.resume(challenge.id)
        } else {
          this.updateChallenge({
            status: 'failed',
            message: outcome.stderr.trim() || '授权未完成（超时或被拒绝）',
          })
        }
      })
      .catch((error: unknown) => {
        if (this.challenge?.id !== challenge.id) return
        this.activeRequestId = null
        this.updateChallenge({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return challenge
  }

  private beginChallenge(input: {
    provider: DesktopAgentAuthChallenge['provider']
    phase: DesktopAgentAuthChallenge['phase']
    reason: string
    title: string
    exportRunId: string | null
    steps: DesktopAgentAuthChallenge['steps']
  }): DesktopAgentAuthChallenge {
    const startedAt = new Date()
    this.challenge = {
      id: `agent-auth-${randomUUID()}`,
      provider: input.provider,
      phase: input.phase,
      status: 'pending',
      reason: input.reason,
      title: input.title,
      verificationUrl: null,
      steps: input.steps,
      exportRunId: input.exportRunId,
      message: null,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
    }
    this.emitChallenge()
    return this.challenge
  }

  private updateChallenge(patch: Partial<DesktopAgentAuthChallenge>): void {
    if (!this.challenge) return
    this.challenge = { ...this.challenge, ...patch }
    this.emitChallenge()
  }

  private currentChallenge(): DesktopAgentAuthChallenge | null {
    if (!this.challenge) return null
    if (this.challenge.expiresAt && Date.now() > Date.parse(this.challenge.expiresAt)
      && this.challenge.status === 'pending') {
      if (this.activeRequestId) this.runner.cancel(this.activeRequestId)
      this.challenge = { ...this.challenge, status: 'expired', message: '授权流程已过期，请重新发起' }
      this.emitChallenge()
    }
    return this.challenge
  }

  private async feishuEnvironment(): Promise<AgentAuthEnvironmentStatus['feishu']> {
    const cliPath = this.runner.gatewayEnvironment().NXCORE_LARK_CLI_PATH ?? 'lark-cli'
    const version = await this.runner.version()
    if (!version) {
      return {
        cliState: 'missing',
        cliPath,
        appConfigured: null,
        userAuthorized: null,
        userName: null,
        message: 'lark-cli 未随产品预装或不可用（导出环境未就绪）',
      }
    }
    try {
      const status = await this.runner.authStatus()
      return {
        cliState: 'ready',
        cliPath,
        appConfigured: status.appConfigured,
        userAuthorized: status.userAuthorized,
        userName: status.userName,
        message: null,
      }
    } catch (error) {
      return {
        cliState: 'error',
        cliPath,
        appConfigured: null,
        userAuthorized: null,
        userName: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private emitChallenge(): void {
    if (this.challenge) this.emit({ type: 'challenge.updated', challenge: this.challenge })
  }

  private emit(frame: AgentAuthEventFrame): void {
    for (const listener of this.listeners) listener(frame)
    this.options.onEvent?.(frame)
  }
}
