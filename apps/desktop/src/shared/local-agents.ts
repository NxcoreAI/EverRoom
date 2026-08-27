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
