import type { ExternalConversationSummary, LocalAgentInstallation } from '@nxcore/agent-contract'

export function localAgentForImportedConversation(
  agents: LocalAgentInstallation[],
  conversation: ExternalConversationSummary,
): LocalAgentInstallation | null {
  if (conversation.provider !== 'codex' && conversation.provider !== 'claude') return null
  const available = agents.filter((agent) => (
    agent.callable
    && agent.invocationSupported
    && agent.provider === conversation.provider
  ))
  return available.find((agent) => agent.id === conversation.agentId) ?? available[0] ?? null
}
