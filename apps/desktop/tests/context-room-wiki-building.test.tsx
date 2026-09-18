import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})
// 图谱画布引 pixi（node 环境无 window），构建态测试不触图谱也 mock 掉整条链
vi.mock('../src/renderer/src/components/context-room/ported/components/WikiGraphCanvas', () => ({
  WikiGraphCanvas: () => null,
}))

import { WikiPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/WikiPane'
import { createContextRoomFixture } from './context-room-fixture'
import type { KnowledgeWikiPageDto } from '../src/shared/knowledge'

function pageDto(path: string, title: string): KnowledgeWikiPageDto {
  return { id: path, title, type: 'topic', path }
}

type PagesResponse = { status: string; items: KnowledgeWikiPageDto[]; pageCount: number | null }

function installKnowledgeBridge(responses: PagesResponse[]) {
  let call = 0
  const knowledge = {
    listWikiPages: vi.fn(() => {
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      return Promise.resolve(response)
    }),
    listRoomFiles: vi.fn(() => Promise.resolve({ items: [] })),
  }
  vi.stubGlobal('window', {
    nxcore: { knowledge },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })
  return knowledge
}

function renderWikiPane() {
  return TestRenderer.create(
    <WikiPane room={createContextRoomFixture()} onOpenPage={() => {}} />,
  )
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON()).replace(/<[^>]*>/g, ' ')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Wiki 板块：构建进度展示', () => {
  it('构建中显示进度块：转圈 + 真实已生成页数，且自动轮询刷新', async () => {
    const knowledge = installKnowledgeBridge([
      { status: 'processing', items: [], pageCount: 3 },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    const text = textOf(renderer!)
    expect(text).toContain('知识库正在构建中')
    expect(text).toContain('已生成 3 页')
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(2)
  })

  it('构建完成自动切换为目录树，无需手动刷新', async () => {
    installKnowledgeBridge([
      { status: 'processing', items: [], pageCount: 0 },
      { status: 'ready', items: [pageDto('视觉/动效.md', '动效规范')], pageCount: 1 },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    expect(textOf(renderer!)).toContain('知识库正在构建中')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(textOf(renderer!)).toContain('动效规范')
    expect(textOf(renderer!)).not.toContain('知识库正在构建中')
  })

  it('构建失败单独报错并提供重试', async () => {
    const knowledge = installKnowledgeBridge([
      { status: 'failed', items: [], pageCount: null },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    expect(textOf(renderer!)).toContain('知识库构建失败')

    const retry = renderer!.root.findAllByType('button').find((node) => node.children.includes('重试'))
    expect(retry).toBeTruthy()
    await act(async () => {
      retry!.props.onClick()
    })
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(2)
  })
})
