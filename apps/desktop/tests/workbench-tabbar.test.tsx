// @vitest-environment happy-dom
/**
 * 顶栏「收起/展开侧栏」按钮回归测试。
 *
 * 背景：顶栏最右的侧栏按钮一度看起来「点了没反应」——它包在 Radix Tooltip.Trigger(asChild)
 * 里，而 IconButton 是普通函数组件不转发 ref；同时文件标签本来就没有侧栏，按钮留在那里是死按钮。
 * 本测试锁定：①点击确实切换 store 的 sidebarCollapsed，②按钮语义随状态变化（收起↔展开），
 * ③文件标签下不渲染侧栏按钮。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TabBar } from '../src/renderer/src/workbench/shell/TabBar'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import { HOME_TAB_ID, fileTabId, workspaceTabId } from '../src/renderer/src/workbench/types'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function officeFile(id: string): OfficeFile {
  return {
    id,
    name: `${id}.docx`,
    kind: 'docx',
    roomId: null,
    updatedLabel: '刚刚',
    sizeLabel: '1 KB',
    memoryCount: 0,
    content: { type: 'md', source: '' },
  }
}

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

  it('文件标签没有侧栏，不渲染死按钮', async () => {
    resetStore(fileTabId('real:f1'), [
      { id: HOME_TAB_ID, kind: 'home', page: 'recent' },
      { id: fileTabId('real:f1'), kind: 'file', file: officeFile('real:f1') },
    ])
    await render(<TabBar />)
    expect(findToggle('收起侧栏')).toBeNull()
    expect(findToggle('展开侧栏')).toBeNull()
    // 搜索按钮仍然在，顶栏右侧动作没有整体消失。
    expect(findToggle('搜索')).not.toBeNull()
  })
})
