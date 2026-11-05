// @vitest-environment happy-dom
/**
 * 顶栏「收起/展开侧栏」按钮回归测试。
 *
 * 背景：顶栏最右的侧栏按钮一度看起来「点了没反应」——它包在 Radix Tooltip.Trigger(asChild)
 * 里，而 IconButton 是普通函数组件不转发 ref。
 * 本测试锁定：①点击确实切换 store 的 sidebarCollapsed，②按钮语义随状态变化（收起↔展开），
 * ③主页与工作空间标签都渲染侧栏按钮（文件不再有独立标签形态）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TabBar } from '../src/renderer/src/workbench/shell/TabBar'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import { HOME_TAB_ID, workspaceTabId } from '../src/renderer/src/workbench/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function render(component: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(component)
  })
}

function resetStore(activeTabId: string, tabs = [{ id: HOME_TAB_ID, kind: 'home' as const, page: 'recent' as const }]): void {
  useWorkbenchStore.setState({
    booted: true,
    loading: false,
    error: null,
    workspaces: [
      {
        id: 'ws-1',
        name: '连接器项目',
        description: null,
        goals: [],
        path: null,
        kind: 'custom',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastOpenedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    sessions: [],
    tabs,
    activeTabId,
    sidebarCollapsed: false,
    pendingSetupWorkspaceId: null,
  })
}

function findToggle(label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`)
}

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('顶栏侧栏收起按钮', () => {
  it('点击后切换 sidebarCollapsed，并变成「展开侧栏」', async () => {
    resetStore(HOME_TAB_ID)
    await render(<TabBar />)

    const collapse = findToggle('收起侧栏')
    expect(collapse).not.toBeNull()
    expect(collapse?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => { collapse?.click() })
    expect(useWorkbenchStore.getState().sidebarCollapsed).toBe(true)
    expect(findToggle('收起侧栏')).toBeNull()
    expect(findToggle('展开侧栏')?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { findToggle('展开侧栏')?.click() })
    expect(useWorkbenchStore.getState().sidebarCollapsed).toBe(false)
    expect(findToggle('收起侧栏')).not.toBeNull()
  })

  it('工作空间标签也有侧栏按钮', async () => {
    resetStore(workspaceTabId('ws-1'), [
      { id: HOME_TAB_ID, kind: 'home', page: 'recent' },
      { id: workspaceTabId('ws-1'), kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'overview' } },
    ])
    await render(<TabBar />)
    expect(findToggle('收起侧栏')).not.toBeNull()
  })

  it('不再有文件标签形态：标签栏只渲染主页与工作空间标签', async () => {
    resetStore(workspaceTabId('ws-1'), [
      { id: HOME_TAB_ID, kind: 'home', page: 'recent' },
      { id: workspaceTabId('ws-1'), kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'overview' } },
    ])
    await render(<TabBar />)
    // 所有窗口标签（主页 + 工作空间）都有侧栏：按钮恒在，没有「点了没反应」的死槽。
    expect(findToggle('收起侧栏')).not.toBeNull()
    // 搜索按钮仍然在，顶栏右侧动作没有整体消失。
    expect(findToggle('搜索')).not.toBeNull()
    // 标签列表只含工作空间标签（主页是独立的固定按钮）。
    const tabNames = Array.from(container.querySelectorAll('.wb-tab-name')).map((node) => node.textContent)
    expect(tabNames).toEqual(['主页', '连接器项目'])
  })
})
