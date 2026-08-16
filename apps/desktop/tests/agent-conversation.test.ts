import type { AgentMessage } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { mergePendingAgentMessages } from '../src/renderer/src/components/agent/useAgentSession'

function message(id: string, content: string): AgentMessage {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    role: 'user',
    content,
    createdAt: '2026-08-15T00:00:00.000Z',
  }
}

describe('Agent conversation display', () => {
  it('keeps an optimistic user message when a new session snapshot is loaded', () => {
    const stored = message('stored', '上一条消息')
    const pending = { ...message('pending', '刚发送的消息'), sessionId: 'pending', runId: 'pending' }

    expect(mergePendingAgentMessages([stored], [pending])).toEqual([stored, pending])
  })

  it('does not duplicate an optimistic message already present in the snapshot', () => {
    const pending = message('pending', '刚发送的消息')

    expect(mergePendingAgentMessages([pending], [pending])).toEqual([pending])
  })
})
