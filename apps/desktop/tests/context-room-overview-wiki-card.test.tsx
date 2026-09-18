import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({ refreshFromBackend: vi.fn().mockResolvedValue(undefined) }),
}))

import type { RoomOverviewProjection } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { OverviewDashboard } from '../src/renderer/src/components/context-room/ported/components/detail-panels/OverviewDashboard'

const emptyProjection: RoomOverviewProjection = {
  roomId: 'room-wiki',
  revision: 1,
  generatedAt: '2026-09-18T08:00:00.000Z',
  stale: false,
  overview: [],
  status: [],
  entities: [],
  appliedCorrectionIds: [],
  timeline: [],
  nextSteps: [],
}

async function renderWithWiki(listWikiPages: ReturnType<typeof vi.fn>, onOpenWikiBoard = vi.fn()) {
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: {
      contextRooms: { overview: vi.fn().mockResolvedValue(emptyProjection) },
      knowledge: { listWikiPages },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <OverviewDashboard
        room={createContextRoomFixture('room-wiki', 'Wiki Room')}
        backendDocuments={[]}
        knowledgeFiles={[]}
        onSelectResource={() => {}}
        onOpenObject={() => {}}
        onOpenWikiBoard={onOpenWikiBoard}
        onToggleTask={() => {}}
      />,
    )
  })
  return { renderer: renderer!, onOpenWikiBoard }
}

function wikiCard(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) =>
    typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('context-room-dashboard-wiki'))
}

function wikiListItems(renderer: TestRenderer.ReactTestRenderer) {
  const card = wikiCard(renderer)[0]
  return card.findByType('ul').findAllByType('li').map((li) =>
    li.children.filter((child) => typeof child === 'string').join(''))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('概览面板：Wiki 概览卡', () => {
  const pages = [
    { id: 'wp-1', title: '连接器统一·现状', type: 'page', path: '连接器统一/现状' },
    { id: 'wp-2', title: '连接器统一·目标架构', type: 'page', path: '连接器统一/目标架构' },
    { id: 'wp-3', title: '设计规范·动效篇', type: 'page', path: '设计规范/动效' },
  ]

  it('有 KS 摘要时卡体显示摘要要点（按句拆分），页脚带页数与更新时间', async () => {
    const { renderer } = await renderWithWiki(vi.fn().mockResolvedValue({
      status: 'ready',
      items: pages,
      pageCount: 3,
      summary: '连接器统一进入映射表收敛阶段，Gmail/日历双链路已并入统一格式层。目标架构以 provider 命名规范为先。',
      updatedAt: '2026-09-18T08:30:00.000Z',
    }))
    expect(wikiListItems(renderer)).toEqual([
      '连接器统一进入映射表收敛阶段，Gmail/日历双链路已并入统一格式层',
      '目标架构以 provider 命名规范为先',
    ])
    const footerText = wikiCard(renderer)[0].findByType('footer').children.join('')
      + wikiCard(renderer)[0].findByType('footer').findAll((node) => node.type === 'span').map((span) => span.children.join('')).join('')
    expect(footerText).toContain('已生成 3 页')
    expect(footerText).toContain('更新')
  })

  it('无摘要时回退页面标题列表', async () => {
    const { renderer } = await renderWithWiki(vi.fn().mockResolvedValue({
      status: 'ready', items: pages, pageCount: 3, summary: null, updatedAt: null,
    }))
    expect(wikiListItems(renderer)).toEqual([
      '连接器统一·现状',
      '连接器统一·目标架构',
      '设计规范·动效篇',
    ])
  })

  it('没有页面时整卡不渲染（无占位）', async () => {
    const { renderer } = await renderWithWiki(vi.fn().mockResolvedValue({
      status: 'failed', items: [], pageCount: 47, summary: null, updatedAt: null,
    }))
    expect(wikiCard(renderer)).toHaveLength(0)
  })

  it('「打开 Wiki」按钮回调 onOpenWikiBoard', async () => {
    const { renderer, onOpenWikiBoard } = await renderWithWiki(
      vi.fn().mockResolvedValue({ status: 'ready', items: pages, pageCount: 3, summary: null, updatedAt: null }),
    )
    await act(async () => {
      wikiCard(renderer)[0].findByType('footer').findByType('button').props.onClick()
    })
    expect(onOpenWikiBoard).toHaveBeenCalledTimes(1)
  })
})
