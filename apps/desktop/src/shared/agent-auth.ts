/**
 * Agent 授权引导（飞书 lark-cli / Notion）的桌面端共享类型。
 * 约束（feishu-notion-document-export-plan.md §7）：device code、app secret、
 * access token 只留在主进程与 CLI 自己的系统安全存储，永不过 IPC 进入渲染层。
 */

export type AgentAuthProvider = 'feishu' | 'notion'

export type AgentAuthPhase = 'app_setup' | 'user_auth'

export type AgentAuthFlowStatus =
  | 'pending'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'cancelled'

export interface AgentAuthStepView {
  id: string
  title: string
  description: string | null
  action: 'open_url' | 'show_qr' | 'wait_local_result' | 'run_cli_check' | 'user_confirm' | 'open_connector_console'
  url?: string
  completed: boolean
}

export interface DesktopAgentAuthChallenge {
  id: string
  provider: AgentAuthProvider
  phase: AgentAuthPhase
  status: AgentAuthFlowStatus
  reason: string
  title: string
  verificationUrl: string | null
  steps: AgentAuthStepView[]
  /** 关联的 Agent 导出任务（恢复原操作时重新发起导出）。 */
  exportRunId: string | null
  message: string | null
  startedAt: string
  expiresAt: string | null
}

export interface AgentAuthEnvironmentStatus {
  feishu: {
    cliState: 'ready' | 'missing' | 'error' | 'unknown'
    cliPath: string
    appConfigured: boolean | null
    userAuthorized: boolean | null
    userName: string | null
    message: string | null
  }
  activeChallenge: DesktopAgentAuthChallenge | null
}

export interface AgentAuthStartInput {
  provider: AgentAuthProvider
  phase: AgentAuthPhase
  exportRunId?: string
}

export type AgentAuthEventFrame =
  | { type: 'challenge.updated'; challenge: DesktopAgentAuthChallenge }
  | { type: 'challenge.removed'; challengeId: string }
  | { type: 'environment.changed'; status: AgentAuthEnvironmentStatus }
