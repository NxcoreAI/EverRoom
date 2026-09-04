// @vitest-environment happy-dom
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// t 的 mock 由 tests/setup.ts 全局提供（稳定引用——每次渲染新建 t 会把
// [api, t] 依赖的加载 effect 打成无限循环）。

import { SourcesPage } from '../src/renderer/src/components/pages/SourcesPage'
import type { DataSourceSummary } from '../src/shared/sources'
import type { IngestEventDto } from '../src/shared/ingest'

function event(index: number): IngestEventDto {
  return {
    id: `evt-${index}`,
    sourceKind: 'file',
    title: `事件 ${index}`,
    filterStatus: 'passed',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  } as IngestEventDto
}

const EVENTS = Array.from({ length: 8 }, (_, index) => event(index))

/** 页面挂载所需的 window.nxcore 最小实现（happy-dom 提供 document/localStorage 等;缺的 API 走可选链兜底）。 */
function mockWindow(sources: DataSourceSummary[] = []) {
  const listEvents = vi.fn(async (query: { limit: number }) => ({ items: EVENTS.slice(0, query.limit), total: EVENTS.length }))
  Object.assign(globalThis.window, {
    nxcore: {
      sources: {
        list: vi.fn(async () => sources),
        onChanged: vi.fn(() => () => {}),
        listFiles: vi.fn(async () => []),
      },
      nangoConnector: {
        status: vi.fn(async () => ({ enabled: true, connections: [], scopes: [], runs: [] })),
      },
      ingest: { listEvents },
      migrations: {
        sources: vi.fn(async () => []),
        runs: vi.fn(async () => []),
        onProgress: vi.fn(() => () => {}),
      },
      obsidian: {
        list: vi.fn(async () => []),
        discover: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
        onDiscoveryChanged: vi.fn(() => () => {}),
      },
    },
  })
  return { listEvents }
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(<SourcesPage />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return renderer!
}

function click(node: { props: { onClick?: () => void } }) {
  act(() => { node.props.onClick?.() })
}

/** 带微任务/宏任务冲刷的点击（触发数据请求后,等 state 落地再断言）。 */
async function clickAsync(node: { props: { onClick?: () => void } }) {
  await act(async () => {
    node.props.onClick?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('SourcesPage second-level pages', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    Reflect.deleteProperty(globalThis.window, 'nxcore')
  })

  it('main page shows at most 6 connect tiles and 5 feed rows, each with a view-all affordance', async () => {
    mockWindow()
    renderer = await mount()

    const grid = renderer.root.findByProps({ className: 'src-connect-grid' })
    const tiles = grid.props.children.filter((child: { props?: { className?: string } }) => child?.props?.className === 'src-connect-tile')
    expect(tiles).toHaveLength(6)
    // 超出 6 项 → 查看全部入口存在
    expect(renderer.root.findAllByProps({ className: 'src-connect-more' })).toHaveLength(1)
    // feed 只显示 5 行
    expect(renderer.root.findAllByProps({ className: 'src-feed-row' })).toHaveLength(5)
    expect(renderer.root.findAllByProps({ className: 'src-feed-more' })).toHaveLength(1)
  })

  it('ingest view-all enters a full-list second-level page and back returns to main', async () => {
    const { listEvents } = mockWindow()
    renderer = await mount()

    click(renderer.root.findByProps({ className: 'src-feed-more' }))

    // 二级页：拉全量（网关上限 200）,不再有查看全部按钮
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const rows = renderer.root.findAllByProps({ className: 'src-feed-row' })
    expect(rows).toHaveLength(EVENTS.length)
    expect(renderer.root.findAllByProps({ className: 'src-feed-more' })).toHaveLength(0)

    // 返回主页 → 恢复 5 行预览
    await clickAsync(renderer.root.findByProps({ className: 'src-back' }))
    expect(renderer.root.findAllByProps({ className: 'src-feed-row' })).toHaveLength(5)
    expect(renderer.root.findAllByProps({ className: 'src-connect-grid' })).toHaveLength(1)
  })

  it('connect view-all enters the grouped full list (includes items beyond the first 6) and back returns', async () => {
    mockWindow()
    renderer = await mount()

    // 主页默认 6 项里没有本地导入组的条目（Claude Code 排在第 9 位）
    const mainGrid = renderer.root.findByProps({ className: 'src-connect-grid' })
    const mainLabels = mainGrid.props.children.map((child: { props?: { children?: unknown[] } }) => String(child?.props?.children?.[1]?.props?.children))
    expect(mainLabels).not.toContain('Claude Code')

    click(renderer.root.findByProps({ className: 'src-connect-more' }))

    // 二级页:分组全量,每组一个 grid
    const groups = renderer.root.findAllByProps({ className: 'src-connect-group' })
    expect(groups).toHaveLength(3)
    const labels = renderer.root.findAllByProps({ className: 'src-connect-tile' }).map((node) => String(node.props.children[1].props.children))
    expect(labels).toContain('Claude Code')
    expect(labels).toContain('OpenClaw')
    expect(renderer.root.findAllByProps({ className: 'src-connect-more' })).toHaveLength(0)

    click(renderer.root.findByProps({ className: 'src-back' }))
    expect(renderer.root.findAllByProps({ className: 'src-connect-grid' })).toHaveLength(1)
  })

  it('clicking a local source card opens the detail drawer (regression: 模态框弹不出)', async () => {
    const source: DataSourceSummary = {
      id: 'src-local-1',
      kind: 'local-folder',
      name: '笔记文件夹',
      rootPath: '/tmp/notes',
      status: 'connected',
      fileCount: 3,
      versionCount: 2,
      totalBytes: 1024,
      lastSyncedAt: '2026-09-01T10:00:00.000Z',
      lastError: null,
      createdAt: '2026-09-01T10:00:00.000Z',
    }
    mockWindow([source])
    renderer = await mount()

    // 卡片在主页渲染,点击后抽屉与遮罩同时出现
    const card = renderer.root.findByProps({ className: 'src-card' })
    await clickAsync(card)
    const drawer = renderer.root.findByProps({ className: 'src-drawer' })
    expect(drawer.props['data-open']).toBe('true')
    expect(renderer.root.findByProps({ className: 'src-scrim' }).props['data-open']).toBe('true')

    // 关闭按钮 → 抽屉卸载
    await clickAsync(renderer.root.findByProps({ className: 'src-drawer-close' }))
    expect(renderer.root.findAllByProps({ className: 'src-drawer' })).toHaveLength(0)
  })
})
