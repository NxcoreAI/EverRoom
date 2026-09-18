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

function installKnowledgeBridge(responses: PagesResponse[], sourceCount = 2) {
  let call = 0
  const knowledge = {
    listWikiPages: vi.fn(() => {
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      return Promise.resolve(response)
    }),
    listRoomFiles: vi.fn(() => Promise.resolve({
      items: Array.from({ length: sourceCount }, (_, index) => ({ id: `file-${index}` })),
    })),
    retryWikiBuild: vi.fn(() => Promise.resolve({ ok: true })),
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

describe('Wiki 板块：构建进度步骤条（原型 cr-wiki-progress 对照）', () => {
  it('构建中显示步骤条：资料沉淀份数 + 生成页面真实页数，且自动轮询', async () => {
    const knowledge = installKnowledgeBridge([
      { status: 'processing', items: [], pageCount: 3 },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    const text = textOf(renderer!)
    expect(text).toContain('资料沉淀')
    expect(text).toContain('2 份资料')
    expect(text).toContain('生成页面')
    expect(text).toContain('已生成 3 页')
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(2)
  })

  it('构建完成自动切换为目录树，进度条消失', async () => {
    installKnowledgeBridge([
      { status: 'processing', items: [], pageCount: 0 },
      { status: 'ready', items: [pageDto('视觉/动效.md', '动效规范')], pageCount: 1 },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    expect(textOf(renderer!)).toContain('生成页面')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    const text = textOf(renderer!)
    expect(text).toContain('动效规范')
    expect(text).not.toContain('资料沉淀')
  })

  it('构建失败：失败步骤 + 真重试（调网关重建接口并刷新）', async () => {
    const knowledge = installKnowledgeBridge([
      { status: 'failed', items: [], pageCount: null },
    ])
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderWikiPane()
    })
    expect(textOf(renderer!)).toContain('生成页面')
    expect(renderer!.root.findAllByProps({ className: 'context-room-wp-step is-failed' })).toHaveLength(1)

    const retry = renderer!.root.findAllByType('button').find((node) => node.children.includes('重试'))
    expect(retry).toBeTruthy()
    await act(async () => {
      retry!.props.onClick()
    })
    expect(knowledge.retryWikiBuild).toHaveBeenCalledTimes(1)
    expect(knowledge.listWikiPages).toHaveBeenCalledTimes(2)
  })
})
