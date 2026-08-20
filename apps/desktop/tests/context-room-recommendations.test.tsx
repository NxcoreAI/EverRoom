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

function entity(id: string, evidenceScore: number) {
  return {
    id,
    name: `推荐 ${id}`,
    kind: '主题',
    status: 'ready',
    roomId: null,
    evidenceScore,
    sourceCount: 2,
    promoteScore: 2,
    promoteSources: 2,
    firstEvidence: '推荐依据',
    lastLinkedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
  }
}

function installKnowledgeApi(items: ReturnType<typeof entity>[]) {
  const listEntities = vi.fn().mockResolvedValue({ items })
  const listUnmatched = vi.fn().mockResolvedValue({
    items: [{ decisionId: 'unmatched-1', title: '未识别资料' }],
  })
  const listRecentDecisions = vi.fn().mockResolvedValue({
    items: [{ decisionId: 'recent-1', title: '最近归类资料', roomTitle: '已有 Room' }],
  })
  const clearInterval = vi.fn()

  vi.stubGlobal('window', {
    nxcore: {
      knowledge: {
        listEntities,
        listUnmatched,
        listRecentDecisions,
      },
    },
    setInterval: vi.fn(() => 1),
    clearInterval,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })

  return { clearInterval, listEntities, listRecentDecisions, listUnmatched }
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

    expect(api.listEntities).toHaveBeenCalledTimes(3)
    expect(api.listEntities).toHaveBeenCalledWith('ready')
    expect(api.listUnmatched).toHaveBeenCalledOnce()
    expect(api.listRecentDecisions).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByProps({ className: 'context-room-knowledge-empty' })).toHaveLength(1)
    expect(JSON.stringify(renderer!.toJSON())).toContain('最近归类资料')
    expect(JSON.stringify(renderer!.toJSON())).toContain('未识别资料')
  })

  it('renders only ready recommendations as creation cards', async () => {
    installKnowledgeApi([entity('room-a', 2), entity('room-b', 3)])

    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel />)
    })

    const cards = renderer!.root.findAllByProps({ 'data-state': 'recommended' })
    expect(cards).toHaveLength(2)
    expect(cards[0].findByType('strong').children).toContain('推荐 room-b')
    expect(renderer!.root.findAllByProps({ className: 'context-room-knowledge-empty' })).toHaveLength(0)
  })
})
