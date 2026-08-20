import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const localeState = vi.hoisted(() => ({ value: 'zh-CN' as 'zh-CN' | 'en-US' }))

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => (
        actual.translate(localeState.value, message, values)
      ),
    }),
  }
})

import { KnowledgePendingPanel } from '../src/renderer/src/components/context-room/ported/components/KnowledgePendingPanel'

function installKnowledge({ recommended = [], recent = [] }: { recommended?: unknown[]; recent?: unknown[] }) {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    clearInterval: vi.fn(),
    nxcore: {
      knowledge: {
        listEntities: vi.fn((status: string) => Promise.resolve({ items: status === 'ready' ? recommended : [] })),
        listRecentDecisions: vi.fn(() => Promise.resolve({ items: recent })),
        listUnmatched: vi.fn(() => Promise.resolve({ items: [] })),
      },
    },
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
  })
}

describe('KnowledgePendingPanel', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    localeState.value = 'zh-CN'
    vi.unstubAllGlobals()
  })

  it('keeps recent classifications in collapsed history while the recommendation empty state opens Agent', async () => {
    installKnowledge({
      recent: [{
        decisionId: 'decision-1',
        title: '已归类资料',
        roomId: 'room-1',
        roomTitle: '产品 Room',
      }],
    })
    const onFocusAgent = vi.fn()

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel onFocusAgent={onFocusAgent} />)
      await Promise.resolve()
    })

    expect(renderer!.root.findByType('h3').children).toContain('正在理解资料中')
    const history = renderer!.root.findByType('details')
    expect(history.props.open).toBeUndefined()
    expect(history.findByType('summary').findByType('span').children).toContain('历史记录')

    const agentButton = renderer!.root.findAllByType('button')
      .find((button) => button.props.className === 'context-room-knowledge-empty-cta')
    expect(agentButton).toBeDefined()
    act(() => agentButton!.props.onClick())
    expect(onFocusAgent).toHaveBeenCalledTimes(1)
  })

  it('renders recommendation copy in English when the locale changes', async () => {
    localeState.value = 'en-US'
    installKnowledge({
      recommended: [{
        id: 'entity-1',
        name: 'Launch plan',
        kind: '主题',
        status: 'ready',
        roomId: null,
        evidenceScore: 3,
        sourceCount: 2,
        promoteScore: 2,
        promoteSources: 2,
        firstEvidence: 'User-provided evidence',
        lastLinkedAt: null,
        updatedAt: '2026-08-21T00:00:00.000Z',
      }],
    })

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel onFocusAgent={vi.fn()} />)
      await Promise.resolve()
    })

    const output = JSON.stringify(renderer!.toJSON())
    expect(output).toContain('Recommended Rooms')
    expect(output).toContain('Recommended (top 3 by evidence score)')
    expect(output).toContain('Evidence 3.0 · 2 resources · Recommendation threshold reached')
    expect(output).toContain('Topic')
    expect(output).not.toContain('推荐（按证据分排序，前 3）')
  })
})
