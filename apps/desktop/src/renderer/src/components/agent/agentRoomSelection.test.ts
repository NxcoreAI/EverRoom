import { describe, expect, it } from 'vitest'

import { parsePendingAgentIntent } from './agentRoomSelection'

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

describe('Agent pending intent parsing', () => {
  it('Phase 2i 去 Room：不再要求 allowedRoomIds 非空也能解析 pending intent', () => {
    expect(parsePendingAgentIntent(pendingIntent)).toMatchObject({
      id: 'intent-1',
      targetCapability: 'document.create',
    })
    // 网关在 Phase 2i 后恒发空 allowedRoomIds；决策卡仍应能解析。
    expect(parsePendingAgentIntent({ ...pendingIntent, allowedRoomIds: [] })).toMatchObject({
      id: 'intent-1',
      allowedRoomIds: [],
    })
  })

  it('rejects malformed pending intent payloads', () => {
    expect(parsePendingAgentIntent(null)).toBeNull()
    expect(parsePendingAgentIntent({ ...pendingIntent, expiresAt: 123 })).toBeNull()
    expect(parsePendingAgentIntent({ ...pendingIntent, targetCapability: 'room.create' })).toBeNull()
  })
})
