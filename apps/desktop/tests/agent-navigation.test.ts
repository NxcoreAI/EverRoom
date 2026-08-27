import { describe, expect, it } from 'vitest'

import {
  navigationRequiresSessionHandoff,
  replayNavigationMode,
  type AgentNavigationRequest,
  type AgentReplayNavigationMode,
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

describe('agent replay navigation mode', () => {
  const roomTarget = {
    pageId: 'rooms' as const,
    title: '发布会筹备',
    action: 'created' as const,
    roomId: 'room-1',
  }
  const pageTarget = {
    pageId: 'docs' as const,
    title: '项目文档',
    action: 'opened' as const,
  }
  const roomIds = new Set(['room-1', 'room-2'])

  it('treats tool calls from the active run as live navigation', () => {
    const mode: AgentReplayNavigationMode = replayNavigationMode({
      toolRunId: 'run-1',
      activeRunId: 'run-1',
      target: roomTarget,
      roomIds,
    })
    expect(mode).toBe('live')
  })

  it('restores only the room tab for replayed room navigation after restart', () => {
    // 重启后 activeRunId 为空：历史工具调用不得再自动跳转打断用户。
    const mode: AgentReplayNavigationMode = replayNavigationMode({
      toolRunId: 'run-1',
      activeRunId: null,
      target: roomTarget,
      roomIds,
    })
    expect(mode).toBe('restore-tab')
  })

  it('defers tab restore until the target room has loaded', () => {
    // 标签页会被 syncContextRoomTabs 按 rooms 过滤，Room 未加载前先等待。
    const mode: AgentReplayNavigationMode = replayNavigationMode({
      toolRunId: 'run-1',
      activeRunId: null,
      target: { ...roomTarget, roomId: 'room-pending' },
      roomIds,
    })
    expect(mode).toBe('defer')
  })

  it('skips replayed navigation that does not target a room', () => {
    const mode: AgentReplayNavigationMode = replayNavigationMode({
      toolRunId: 'run-1',
      activeRunId: null,
      target: pageTarget,
      roomIds,
    })
    expect(mode).toBe('skip')
  })
})
