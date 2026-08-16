import type { AgentMessage } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { parseAgentRoomSelectionResult } from '../src/renderer/src/components/agent/agentRoomSelection'
import {
  buildAgentRunContext,
  mergePendingAgentMessages,
} from '../src/renderer/src/components/agent/useAgentSession'

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

  it('includes the latest Room snapshot and explicit selection in every run context', () => {
    expect(buildAgentRunContext(
      [{ id: 'room-1', title: '项目 A', kind: '项目' }],
      '  选中文本  ',
      ' room-1 ',
    )).toEqual({
      rooms: [{ id: 'room-1', title: '项目 A', kind: '项目' }],
      selectedText: '选中文本',
      selectedRoomId: 'room-1',
    })
  })

  it('reads a Room selection request from completed tool details', () => {
    expect(parseAgentRoomSelectionResult({
      content: [{ type: 'text', text: '{"rooms":[]}' }],
      details: {
        rooms: [
          { id: 'room-1', title: '项目 A', kind: '项目' },
          { id: '', title: '无效 Room' },
        ],
        selectionRequired: true,
      },
    })).toEqual({
      rooms: [{ id: 'room-1', title: '项目 A', kind: '项目' }],
      selectionRequired: true,
    })
  })

  it('does not show a selector when the tool says selection is unnecessary', () => {
    expect(parseAgentRoomSelectionResult({
      structuredContent: {
        rooms: [{ id: 'room-1', title: '项目 A' }],
        selectionRequired: false,
      },
    })).toBeNull()
  })
})
