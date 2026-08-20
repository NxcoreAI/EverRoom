import { describe, expect, it } from 'vitest'

import { parseAgentDocumentIntentResult } from './agentDocumentIntent'
import { parseAgentRoomSelectionResult } from './agentRoomSelection'

const pendingIntent = {
  id: 'intent-1',
  sessionId: 'session-1',
  sourceRunId: 'run-1',
  originalPrompt: '创建一份原型设计文档',
  targetCapability: 'document.create',
  allowedRoomIds: ['room-1'],
  allowedDocumentIds: [],
  expiresAt: '2026-08-19T12:00:00.000Z',
  consumedAt: null,
  createdAt: '2026-08-19T11:00:00.000Z',
}

describe('Agent pending intent selections', () => {
  it('keeps the original intent with Room and clarification controls', () => {
    expect(parseAgentRoomSelectionResult({
      rooms: [{ id: 'room-1', title: 'PC 原型评审' }],
      selectionRequired: true,
      pendingIntent,
    })).toMatchObject({ pendingIntent, rooms: [{ id: 'room-1' }] })

    expect(parseAgentDocumentIntentResult({
      clarificationRequired: true,
      originalPrompt: pendingIntent.originalPrompt,
      topic: '原型设计',
      pendingIntent,
    })).toMatchObject({ pendingIntent, topic: '原型设计' })

    expect(parseAgentRoomSelectionResult({
      rooms: [{ id: 'room-1', title: 'PC 原型评审' }],
      selectionRequired: true,
    })).toEqual({
      rooms: [{ id: 'room-1', title: 'PC 原型评审' }],
      selectionRequired: true,
    })
  })
})
