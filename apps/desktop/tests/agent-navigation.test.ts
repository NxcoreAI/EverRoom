import { describe, expect, it } from 'vitest'

import {
  navigationRequiresSessionHandoff,
  type AgentNavigationRequest,
} from '../src/renderer/src/components/agent/agentNavigation'

function request(sourcePageId: 'home' | 'docs', targetObjectType: 'document' | 'source'): AgentNavigationRequest {
  return {
    key: 'navigation-1',
    source: {
      sessionId: 'session-1',
      pageId: sourcePageId,
      pageLabel: sourcePageId === 'home' ? '首页' : '文档',
      roomId: null,
      runId: 'run-1',
    },
    target: {
      pageId: 'docs',
      title: '目标文档',
      action: 'opened',
      objectId: 'document-1',
      objectType: targetObjectType,
    },
  }
}

describe('Agent navigation session handoff', () => {
  it('reuses the current conversation for document navigation from the home page', () => {
    expect(navigationRequiresSessionHandoff(request('home', 'document'))).toBe(false)
  })

  it('keeps the current conversation when navigation switches pages', () => {
    // Agent conversation state is global and stays selected across pages.
    expect(navigationRequiresSessionHandoff(request('docs', 'source'))).toBe(false)
  })
})
