import { describe, expect, it } from 'vitest'
import { parseClaudeHistoryJsonl, parseCodexHistoryJsonl } from './history'

describe('parseCodexHistoryJsonl', () => {
  it('imports user messages and final answers while excluding injected context and commentary', () => {
    const lines = [
      { timestamp: '2026-08-26T01:00:00.000Z', type: 'session_meta', payload: { session_id: 'thread-1' } },
      { timestamp: '2026-08-26T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>secret</environment_context>' }] } },
      { timestamp: '2026-08-26T01:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Implement discovery' }] } },
      { timestamp: '2026-08-26T01:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] } },
      { timestamp: '2026-08-26T01:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Implemented' }] } },
    ]
    expect(parseCodexHistoryJsonl(lines.map((line) => JSON.stringify(line)).join('\n'))).toEqual({
      sessionId: 'thread-1',
      title: 'Implement discovery',
      messages: [
        { role: 'user', content: 'Implement discovery', timestamp: '2026-08-26T01:00:02.000Z' },
        { role: 'assistant', content: 'Implemented', timestamp: '2026-08-26T01:00:04.000Z' },
      ],
    })
  })

  it('skips malformed lines and sessions without messages', () => {
    expect(parseCodexHistoryJsonl('not-json\n{"type":"session_meta","payload":{"session_id":"empty"}}')).toBeNull()
  })

  it('rejects native session ids that could be interpreted as CLI options', () => {
    const lines = [
      { type: 'session_meta', payload: { session_id: '--dangerous-option' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
    ]
    expect(parseCodexHistoryJsonl(lines.map((line) => JSON.stringify(line)).join('\n'))).toBeNull()
  })
})

describe('parseClaudeHistoryJsonl', () => {
  it('imports visible turns, uses the provider summary, and excludes tool and command records', () => {
    const lines = [
      { type: 'user', sessionId: 'claude-session', uuid: 'u1', timestamp: '2026-08-26T02:00:00.000Z', message: { role: 'user', content: '<command-message>compact</command-message>' } },
      { type: 'user', sessionId: 'claude-session', uuid: 'u2', timestamp: '2026-08-26T02:00:01.000Z', message: { role: 'user', content: 'Review the migration' } },
      { type: 'assistant', sessionId: 'claude-session', uuid: 'a1', timestamp: '2026-08-26T02:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'The migration is sound.' }, { type: 'tool_use', name: 'Read' }] } },
      { type: 'user', sessionId: 'claude-session', uuid: 'tool', timestamp: '2026-08-26T02:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'secret output' }] } },
      { type: 'assistant', sessionId: 'claude-session', isSidechain: true, uuid: 'side', timestamp: '2026-08-26T02:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent output' }] } },
      { type: 'summary', sessionId: 'claude-session', summary: 'Migration review' },
    ]
    expect(parseClaudeHistoryJsonl(lines.map((line) => JSON.stringify(line)).join('\n'))).toEqual({
      sessionId: 'claude-session',
      title: 'Migration review',
      messages: [
        { role: 'user', content: 'Review the migration', timestamp: '2026-08-26T02:00:01.000Z' },
        { role: 'assistant', content: 'The migration is sound.', timestamp: '2026-08-26T02:00:02.000Z' },
      ],
    })
  })
})
