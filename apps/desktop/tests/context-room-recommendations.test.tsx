import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { KnowledgePendingPanel } from '../src/renderer/src/components/context-room/ported/components/KnowledgePendingPanel'

function entity(id: string, evidenceScore: number, existingRoomMatch: {
  roomId: string
  roomTitle: string
  entityId: string
  confidence: 'high' | 'medium'
  score: number
  reasons: string[]
} | null = null) {
  return {
    id,
    name: `推荐 ${id}`,
    kind: '主题',
    status: 'ready',
    roomId: null,
    evidenceScore,
    sourceCount: 2,
    eligibleSourceCount: 2,
    trustedSourceCount: 2,
    strongSourceCount: 2,
    readinessPath: 'strong' as const,
    sourceKinds: ['file'],
    excludedSourceCount: 0,
    promoteScore: 2.4,
    promoteSources: 3,
    firstEvidence: '推荐依据',
    lastLinkedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    existingRoomMatch,
  }
}

function installKnowledgeApi(items: ReturnType<typeof entity>[]) {
  const listEntities = vi.fn().mockResolvedValue({ items })
  const listRecentDecisions = vi.fn().mockResolvedValue({
    items: [{ decisionId: 'recent-1', title: '最近归类资料', roomTitle: '已有 Room' }],
  })
  const clearInterval = vi.fn()
  const mergeEntity = vi.fn().mockResolvedValue({ ok: true })

  vi.stubGlobal('window', {
    nxcore: {
      knowledge: {
        listEntities,
        listRecentDecisions,
        mergeEntity,
      },
    },
    setInterval: vi.fn(() => 1),
    clearInterval,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })

  return { clearInterval, listEntities, listRecentDecisions, mergeEntity }
}

describe('Context Room recommendations', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.unstubAllGlobals()
  })

  it('shows the empty state when no Room is actually available to create', async () => {
    const api = installKnowledgeApi([])

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel />)
    })

    expect(api.listEntities.mock.calls.map(([status]) => status)).toEqual([
      'ready', 'promoting', 'room', 'suppressed',
    ])
    expect(api.listRecentDecisions).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByProps({ className: 'context-room-knowledge-empty' })).toHaveLength(1)
    expect(JSON.stringify(renderer!.toJSON())).toContain('最近归类资料')
  })

  it('renders only ready recommendations as creation cards', async () => {
    const lowerStrongRecommendation = entity('room-a', 2)
    const higherStandardRecommendation = {
      ...entity('room-b', 3),
      strongSourceCount: 0,
      readinessPath: 'standard' as const,
    }
    installKnowledgeApi([lowerStrongRecommendation, higherStandardRecommendation])

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel />)
    })

    const cards = renderer!.root.findAllByProps({ 'data-state': 'recommended' })
    expect(cards).toHaveLength(2)
    expect(cards[0].findByType('strong').children).toContain('推荐 room-b')
    expect(renderer!.root.findAllByProps({ className: 'context-room-knowledge-empty' })).toHaveLength(0)
  })

  it('shows only the three highest-scoring Room creation recommendations', async () => {
    installKnowledgeApi([
      entity('score-1', 1),
      entity('score-5', 5),
      entity('score-2', 2),
      entity('score-4', 4),
      entity('score-3', 3),
    ])

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel onFocusAgent={() => {}} />)
    })

    const cards = renderer!.root.findAllByProps({ 'data-state': 'recommended' })
    expect(cards).toHaveLength(3)
    expect(cards.map((card) => card.findByType('strong').children[0])).toEqual([
      '推荐 score-5',
      '推荐 score-4',
      '推荐 score-3',
    ])
    expect(renderer!.root.findAllByProps({ className: 'context-room-knowledge-showmore' })).toHaveLength(0)
  })

  it('requires an explicit reuse action for a high-confidence existing Room match', async () => {
    const matched = entity('candidate', 3, {
      roomId: 'room-existing',
      roomTitle: '校园生活',
      entityId: 'entity-existing',
      confidence: 'high',
      score: 1,
      reasons: ['exact_name_or_alias'],
    })
    const api = installKnowledgeApi([matched])

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel onFocusAgent={() => {}} />)
    })

    expect(JSON.stringify(renderer!.toJSON())).toContain('加入已有 Room')
    expect(renderer!.root.findAllByProps({ 'aria-label': '选择 推荐 candidate' })).toHaveLength(0)
    const reuseButton = renderer!.root.findByProps({ 'aria-label': '加入已有 Room' })
    await act(async () => {
      reuseButton!.props.onClick()
    })
    expect(api.mergeEntity).toHaveBeenCalledWith('candidate', 'entity-existing')
  })
})
