import type { AgentEvent, AgentSessionSnapshot } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../context-room/RoomDocumentsProvider', () => ({
  useRoomDocumentsState: () => ({ documentsByRoom: {}, eventsByDocument: {} }),
}))

import { buildLinkedAgentRunState } from './useLinkedAgentRun'

function event(seq: number, type: AgentEvent['type'], payload: unknown = {}): AgentEvent {
  return {
    id: `event-${seq}`,
    sessionId: 'source-session',
    runId: 'source-run',
    seq,
    type,
    occurredAt: new Date(seq * 1_000).toISOString(),
    payload,
  }
}

const snapshot: AgentSessionSnapshot = {
  session: {
    id: 'source-session',
    roomId: null,
    pageLabel: 'Documents',
    runtimeId: 'runtime-1',
    title: 'Create a document',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
  },
  activeRun: {
    id: 'source-run',
    sessionId: 'source-session',
    status: 'running',
    prompt: 'Create a document',
    lastEventSeq: 3,
    error: null,
    startedAt: new Date(1_000).toISOString(),
    completedAt: null,
    createdAt: new Date(0).toISOString(),
  },
  messages: [],
  lastEventSeq: 3,
}

describe('linked Agent run state', () => {
  it('rebuilds live progress and protects the terminal tool state', () => {
    const state = buildLinkedAgentRunState(snapshot, 'source-run', [
      event(1, 'run.started'),
      event(2, 'reasoning.delta', { delta: 'Reviewing context' }),
      event(3, 'tool.started', { toolCallId: 'write-1', name: 'write_document', args: {} }),
      event(4, 'message.started'),
      event(5, 'message.delta', { delta: 'Drafting' }),
      event(6, 'run.failed', { message: 'Editor unavailable' }),
    ])

    expect(state.status).toBe('failed')
    expect(state.reasoning).toBe('Reviewing context')
    expect(state.tools[0]?.status).toBe('error')
    expect(state.messages[0]).toMatchObject({ content: 'Drafting', streaming: false })
    expect(state.error).toBe('Editor unavailable')
    expect(state.completedAt).toBe(event(6, 'run.failed').occurredAt)
  })

  it('waits for the linked document presentation before showing completion', () => {
    const completedSnapshot: AgentSessionSnapshot = {
      ...snapshot,
      activeRun: null,
      messages: [{
        id: 'assistant-1',
        sessionId: 'source-session',
        runId: 'source-run',
        role: 'assistant',
        content: 'Document created.',
        createdAt: new Date(7_000).toISOString(),
      }],
    }
    const events = [
      event(1, 'run.started'),
      event(2, 'tool.started', { toolCallId: 'write-1', name: 'write_document', args: {} }),
      event(3, 'tool.completed', { toolCallId: 'write-1', name: 'write_document', result: {} }),
      event(4, 'message.started'),
      event(5, 'message.delta', { delta: 'Document created.' }),
      event(6, 'message.completed'),
      event(7, 'run.completed'),
    ]

    const pending = buildLinkedAgentRunState(completedSnapshot, 'source-run', events, true)
    expect(pending.status).toBe('running')
    expect(pending.messages).toEqual([])
    expect(pending.completedAt).toBeUndefined()
    expect(pending.documentPending).toBe(true)

    const completed = buildLinkedAgentRunState(completedSnapshot, 'source-run', events)
    expect(completed.status).toBe('completed')
    expect(completed.messages[0]?.content).toBe('Document created.')
    expect(completed.completedAt).toBe(event(7, 'run.completed').occurredAt)
    expect(completed.documentPending).toBe(false)
  })
})
