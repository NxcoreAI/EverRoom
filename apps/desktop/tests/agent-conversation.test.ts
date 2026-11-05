import type { AgentMessage } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { parsePendingAgentIntent } from '../src/renderer/src/components/agent/agentRoomSelection'
import { parseAgentDocumentIntentResult } from '../src/renderer/src/components/agent/agentDocumentIntent'
import {
  mergePendingAgentMessages,
} from '../src/renderer/src/components/agent/useAgentSession'
import { buildAgentRunContext } from '../src/renderer/src/components/agent/agentRunContext'

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

  it('Phase 2i 去 Room：run context 不再携带 rooms/selectedRoomId', () => {
    expect(buildAgentRunContext('  选中文本  ', undefined, ' Agent ')).toEqual({
      pageLabel: 'Agent',
      selectedText: '选中文本',
    })
  })

  it('Phase 2i 去 Room：pending intent 允许空 allowedRoomIds（网关恒发空数组）', () => {
    expect(parsePendingAgentIntent({
      id: 'intent-1',
      sessionId: 'session-1',
      sourceRunId: 'run-1',
      originalPrompt: '创建一份原型设计文档',
      targetCapability: 'document.create',
      allowedRoomIds: [],
      allowedDocumentIds: [],
      expiresAt: '2026-08-19T12:00:00.000Z',
      consumedAt: null,
      createdAt: '2026-08-19T11:00:00.000Z',
    })).toMatchObject({ id: 'intent-1', allowedRoomIds: [] })
  })

  it('rejects malformed pending intent payloads', () => {
    expect(parsePendingAgentIntent({ selectionRequired: true })).toBeNull()
    expect(parsePendingAgentIntent('not-an-intent')).toBeNull()
  })

  it('reads a document-intent clarification from a completed preflight tool', () => {
    expect(parseAgentDocumentIntentResult({
      clarificationRequired: true,
      originalPrompt: '帮我创建一个C语言',
      topic: 'C语言',
    })).toEqual({
      clarificationRequired: true,
      originalPrompt: '帮我创建一个C语言',
      topic: 'C语言',
    })
  })

  it('ignores incomplete document-intent clarification results', () => {
    expect(parseAgentDocumentIntentResult({
      clarificationRequired: true,
      originalPrompt: '帮我创建一个C语言',
    })).toBeNull()
  })
})
