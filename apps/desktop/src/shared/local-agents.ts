import type { LocalAgentAcpAdapterInfo } from '@nxcore/agent-contract'

export type {
  LocalAgentCard,
  LocalAgentInstallation,
  LocalAgentHistoryConversation,
  LocalAgentHistoryImportResult,
  LocalAgentHistoryMessage,
  LocalAgentAcpAdapterInfo,
  LocalAgentProvider,
  LocalAgentStatus,
} from '@nxcore/agent-contract'

/** 一键安装 ACP 适配器的结果（主进程安装 → 渲染端向导展示）。 */
export interface LocalAgentAdapterInstallResult {
  agentId: string
  ok: boolean
  status: 'installed' | 'not_needed' | 'failed'
  adapter: LocalAgentAcpAdapterInfo
  error?: string
  log?: string
}

export interface LocalAgentWorkspaceBinding {
  token: string
  agentId: string
  sessionId: string
  rootPath: string
  permissionProfile: 'workspace_write'
}

export type LocalAgentDispatchStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export interface LocalAgentDispatchMaterialDetail {
  id: string
  kind: 'selection' | 'attachment' | 'active_document' | 'transcript' | 'note' | 'agent_output'
  title: string
  chars: number
  truncated: boolean
  agentOutput: boolean
  sourceDispatchId: string | null
}

export interface LocalAgentDispatchDetail {
  id: string
  sessionId: string
  parentRunId: string
  agentId: string
  displayName: string
  provider: string
  assignment: string
  sharedGoal: string | null
  constraints: string[]
  materials: LocalAgentDispatchMaterialDetail[]
  packageVersion: number
  packageDigest: string
  status: LocalAgentDispatchStatus
  resultText: string | null
  errorCode: string | null
  errorMessage: string | null
  subRunId: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}
