import { describe, expect, it } from 'vitest'

import type { AgentSessionLink } from '@nxcore/agent-contract'

import {
  agentSessionLinkDestination,
  parseAgentNavigationTarget,
  resolveAgentSessionLinkRoute,
} from './agentNavigation'

const link: AgentSessionLink = {
  id: 'link-1',
  sourceSessionId: 'source-session',
  targetSessionId: 'target-session',
  sourceRunId: 'run-1',
  sourcePageId: 'docs',
  sourcePageLabel: '文档',
  sourceRoomId: null,
  target: {
    pageId: 'rooms',
    title: 'Release notes',
    action: 'created',
    roomId: 'room-1',
    objectId: 'document-1',
    objectType: 'document',
  },
  createdAt: '2026-08-16T00:00:00.000Z',
  returnedAt: null,
}

describe('agent navigation target', () => {
  it('accepts navigation metadata only from a valid tool result', () => {
    expect(parseAgentNavigationTarget({
      details: {
        navigation: {
          pageId: 'rooms',
          title: 'Release notes',
          action: 'created',
          roomId: 'room-1',
          objectId: 'document-1',
          objectType: 'document',
        },
      },
    })).toMatchObject({ pageId: 'rooms', roomId: 'room-1', objectId: 'document-1' })

    expect(parseAgentNavigationTarget({
      details: {
        navigation: {
          pageId: 'rooms',
          title: 'Campus Life',
          action: 'created',
          roomId: 'room-campus-life',
          objectId: 'room-campus-life',
          objectType: 'room',
        },
      },
    })).toMatchObject({
      pageId: 'rooms',
      title: 'Campus Life',
      roomId: 'room-campus-life',
      objectType: 'room',
    })

    expect(parseAgentNavigationTarget({ details: { navigation: { pageId: 'rooms', title: 'Missing room', action: 'created' } } })).toBeNull()
    expect(parseAgentNavigationTarget({ details: { navigation: { pageId: 'settings', title: 'Unsupported', action: 'opened' } } })).toBeNull()
    expect(parseAgentNavigationTarget({ content: 'created room-1' })).toBeNull()
  })

  it('routes a persisted link in both directions without creating another link', () => {
    expect(agentSessionLinkDestination(link, 'target-session')).toBe('source')
    expect(agentSessionLinkDestination(link, 'source-session')).toBe('target')
    expect(agentSessionLinkDestination(link, 'unrelated-session')).toBeNull()

    expect(resolveAgentSessionLinkRoute(link, 'source')).toMatchObject({
      pageId: 'docs',
      roomId: null,
      sessionId: 'source-session',
      documentId: null,
    })
    expect(resolveAgentSessionLinkRoute(link, 'target')).toMatchObject({
      pageId: 'rooms',
      roomId: 'room-1',
      sessionId: 'target-session',
      documentId: 'document-1',
    })
  })
})
