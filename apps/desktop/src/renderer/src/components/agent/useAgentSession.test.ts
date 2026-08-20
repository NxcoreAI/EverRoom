import type { AgentEvent } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { mergeAgentToolEvent, reduceAgentRunEvents, removeAgentRunMessages } from './useAgentSession'

function event(seq: number, type: AgentEvent['type'], payload: unknown = {}): AgentEvent {
  return {
    id: `event-${seq}`,
    sessionId: 'session-1',
    runId: 'run-1',
    seq,
    type,
    occurredAt: new Date(seq * 1_000).toISOString(),
    payload,
  }
}

describe('agent event display state', () => {
  it('removes only the run being regenerated', () => {
    const messages = [
      { id: 'user-1', sessionId: 'session-1', runId: 'run-1', role: 'user' as const, content: 'Earlier', createdAt: '2026-08-20T00:00:00.000Z' },
      { id: 'assistant-1', sessionId: 'session-1', runId: 'run-1', role: 'assistant' as const, content: 'Earlier answer', createdAt: '2026-08-20T00:00:01.000Z' },
      { id: 'user-2', sessionId: 'session-1', runId: 'run-2', role: 'user' as const, content: 'Regenerate this', createdAt: '2026-08-20T00:00:02.000Z' },
      { id: 'assistant-2', sessionId: 'session-1', runId: 'run-2', role: 'assistant' as const, content: 'Old answer', createdAt: '2026-08-20T00:00:03.000Z' },
    ]

    expect(removeAgentRunMessages(messages, 'run-2').map((message) => message.id))
      .toEqual(['user-1', 'assistant-1'])
  })

  it('updates one tool in place and protects its terminal state', () => {
    const started = mergeAgentToolEvent([], event(1, 'tool.started', {
      toolCallId: 'search-1',
      name: 'web_search',
      args: { query: 'EverRoom' },
    }))
    const updated = mergeAgentToolEvent(started, event(2, 'tool.updated', {
      toolCallId: 'search-1',
      partialResult: { results: [1] },
    }))
    const completed = mergeAgentToolEvent(updated, event(3, 'tool.completed', {
      toolCallId: 'search-1',
      result: { results: [1, 2] },
    }))
    const lateUpdate = mergeAgentToolEvent(completed, event(4, 'tool.updated', {
      toolCallId: 'search-1',
      partialResult: { results: [] },
    }))

    expect(updated).toHaveLength(1)
    expect(updated[0]?.status).toBe('running')
    expect(completed[0]?.status).toBe('completed')
    expect(lateUpdate).toBe(completed)
  })

  it('rebuilds reasoning, streaming text, timing, and failed tools from history', () => {
    const reduced = reduceAgentRunEvents([
      event(1, 'run.started'),
      event(2, 'reasoning.delta', { delta: '分析问题。' }),
      event(3, 'tool.started', { toolCallId: 'read-1', name: 'read_file', args: {} }),
      event(4, 'message.started', { role: 'assistant' }),
      event(5, 'message.delta', { delta: '部分回答' }),
      event(6, 'run.failed', { message: '连接中断' }),
    ])

    expect(reduced.reasoning).toBe('分析问题。')
    expect(reduced.streamingContent).toBe('部分回答')
    expect(reduced.tools[0]?.status).toBe('error')
    expect(reduced.startedAt).toBe(event(1, 'run.started').occurredAt)
    expect(reduced.completedAt).toBe(event(6, 'run.failed').occurredAt)
    expect(reduced.lastSequence).toBe(6)
  })
})
