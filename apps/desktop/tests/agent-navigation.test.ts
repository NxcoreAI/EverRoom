import { describe, expect, it } from 'vitest'

import {
  navigationRequiresSessionHandoff,
  type AgentNavigationRequest,
} from '../src/renderer/src/components/agent/agentNavigation'

function request(sourceRoomId: string | null, targetRoomId: string | null): AgentNavigationRequest {
  return {
    key: 'navigation-1',
    source: {
      sessionId: 'session-1',
      pageId: sourceRoomId ? 'rooms' : 'home',
      pageLabel: sourceRoomId ? 'Context Room' : '首页',
      roomId: sourceRoomId,
      runId: 'run-1',
    },
    target: {
      pageId: 'rooms',
      title: '目标文档',
      action: 'opened',
      roomId: targetRoomId,
      objectId: 'document-1',
      objectType: 'document',
    },
  }
}

describe('Agent navigation session handoff', () => {
  it('reuses the current conversation for document navigation inside the same Room', () => {
    expect(navigationRequiresSessionHandoff(request('room-1', 'room-1'))).toBe(false)
  })

  it('keeps the current conversation when navigation crosses Rooms', () => {
    // Agent conversation state is global and stays selected across Rooms.
    expect(navigationRequiresSessionHandoff(request('room-1', 'room-2'))).toBe(false)
  })

  it('keeps the current conversation when entering a Room from a global page', () => {
    expect(navigationRequiresSessionHandoff(request(null, 'room-1'))).toBe(false)
  })
})
