export type {
  LocalAgentCard,
  LocalAgentInstallation,
  LocalAgentHistoryConversation,
  LocalAgentHistoryImportResult,
  LocalAgentHistoryMessage,
  LocalAgentProvider,
  LocalAgentStatus,
} from '@nxcore/agent-contract'

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
