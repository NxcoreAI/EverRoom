import { describe, expect, it } from 'vitest'
import type { ExternalConversationSummary, LocalAgentInstallation } from '@nxcore/agent-contract'
import { localAgentForImportedConversation } from './localAgentConversation'

const installation = (provider: 'codex' | 'claude' | 'openclaw', id = `${provider}:/usr/local/bin/${provider}`) => ({
  id,
  provider,
  displayName: provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'OpenClaw',
  executablePath: `/usr/local/bin/${provider}`,
  version: '1.0.0',
  status: 'verified',
  callable: true,
  invocationSupported: true,
  historyAvailable: true,
  historyPaths: [],
  card: {
    name: provider,
    description: provider,
    version: '1.0.0',
    supportedInterfaces: [],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  },
  lastSeenAt: '2026-08-26T00:00:00.000Z',
}) satisfies LocalAgentInstallation

const conversation = (provider: ExternalConversationSummary['provider'], agentId: string | null) => ({
  id: 'external-thread',
  provider,
  sourceId: 'source',
  title: 'Imported task',
  agentId,
  externalSessionId: 'native-thread',
  messageCount: 2,
  lastMessageAt: '2026-08-26T00:00:00.000Z',
  lastMessageExcerpt: 'Done',
  available: true,
}) satisfies ExternalConversationSummary

describe('localAgentForImportedConversation', () => {
  it('prefers the exact installation and falls back to the imported provider', () => {
    const agents = [installation('codex', 'codex:other'), installation('codex', 'codex:exact')]
    expect(localAgentForImportedConversation(agents, conversation('codex', 'codex:exact'))?.id).toBe('codex:exact')
    expect(localAgentForImportedConversation(agents, conversation('codex', null))?.id).toBe('codex:other')
  })

  it('matches imported OpenClaw history to a callable OpenClaw installation', () => {
    expect(localAgentForImportedConversation(
      [installation('claude'), installation('openclaw')],
      conversation('openclaw', null),
    )?.provider).toBe('openclaw')
  })
})
