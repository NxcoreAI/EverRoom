// @vitest-environment happy-dom
/**
 * 标签页工作台状态机的回归测试。
 *
 * 覆盖：
 * 1) 主页标签恒在最左，且不可关闭；
 * 2) 同一工作空间只开一个标签，重复打开只更新视图并激活；
 * 3) 文件标签可多开、可关闭，关闭后激活相邻标签；
 * 4) 删除工作空间会移除它的标签与会话；
 * 5) 标签持久化 + 启动恢复（只恢复仍存在的工作空间）；
 * 6) 标签标题/状态映射等纯函数。
 */
import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'
import {
  HOME_TAB_ID,
  fileTabId,
  relativeTimeLabel,
  sessionDisplayTitle,
  sortWorkbenchSessions,
  tabTitle,
  workSessionStatus,
  workspaceTabId,
} from '../src/renderer/src/workbench/types'

function workspace(over: Partial<AgentWorkspace> & { id: string }): AgentWorkspace {
  return {
    name: over.id,
    description: null,
    goals: [],
    path: null,
    kind: 'custom',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastOpenedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function session(over: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    workspaceId: 'ws-1',
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'rt-main',
    title: over.id,
    status: 'idle',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function officeFile(id: string, name = `${id}.docx`): OfficeFile {
  return {
    id,
    name,
    kind: 'docx',
    roomId: null,
    updatedLabel: '刚刚',
    sizeLabel: '1 KB',
    memoryCount: 0,
    content: { type: 'md', source: '' },
  }
}

const WS1 = workspace({ id: 'ws-1', name: '连接器项目' })
const WS2 = workspace({ id: 'ws-2', name: 'Q4 采购' })

function resetStore(): void {
  useWorkbenchStore.setState({
    booted: true,
    loading: false,
    error: null,
    workspaces: [WS1, WS2],
    sessions: [session({ id: 's-1' }), session({ id: 's-2', workspaceId: 'ws-2' })],
    tabs: [{ id: HOME_TAB_ID, kind: 'home', page: 'recent' }],
    activeTabId: HOME_TAB_ID,
    sidebarCollapsed: false,
    pendingSetupWorkspaceId: null,
  })
}

beforeEach(() => {
  localStorage.clear()
  resetStore()
})

describe('标签页状态机', () => {
  it('主页标签恒在最左且不可关闭', async () => {
    useWorkbenchStore.getState().openWorkspaceTab('ws-1')
    const tabs = useWorkbenchStore.getState().tabs
    expect(tabs[0].id).toBe(HOME_TAB_ID)
    expect(tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, workspaceTabId('ws-1')])

    const closed = await useWorkbenchStore.getState().requestCloseTab(HOME_TAB_ID)
    expect(closed).toBe(false)
    expect(useWorkbenchStore.getState().tabs[0].id).toBe(HOME_TAB_ID)
  })

  it('同一工作空间只开一个标签，重复打开只更新视图并激活', () => {
    const store = useWorkbenchStore.getState()
    store.openWorkspaceTab('ws-1')
    store.openWorkspaceTab('ws-1', { kind: 'session', sessionId: 's-1' })
    const state = useWorkbenchStore.getState()
    const workspaceTabs = state.tabs.filter((tab) => tab.kind === 'workspace')
    expect(workspaceTabs).toHaveLength(1)
    expect(workspaceTabs[0]).toMatchObject({ workspaceId: 'ws-1', view: { kind: 'session', sessionId: 's-1' } })
    expect(state.activeTabId).toBe(workspaceTabId('ws-1'))
  })

  it('文件标签可多开，关闭后激活相邻标签', async () => {
    const store = useWorkbenchStore.getState()
    store.openFileTab(officeFile('f1'))
    store.openFileTab(officeFile('f2'))
    let state = useWorkbenchStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, fileTabId('f1'), fileTabId('f2')])
    expect(state.activeTabId).toBe(fileTabId('f2'))

    const closed = await state.requestCloseTab(fileTabId('f2'))
    expect(closed).toBe(true)
    state = useWorkbenchStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, fileTabId('f1')])
    expect(state.activeTabId).toBe(fileTabId('f1'))
  })

  it('删除工作空间会移除它的标签和名下会话', async () => {
    ;(window as unknown as { nxcore: unknown }).nxcore = {
      workspace: {
        remove: vi.fn(async () => undefined),
      },
    }
    useWorkbenchStore.getState().openWorkspaceTab('ws-1', { kind: 'session', sessionId: 's-1' })
    const ok = await useWorkbenchStore.getState().deleteWorkspace('ws-1')
    expect(ok).toBe(true)
    const state = useWorkbenchStore.getState()
    expect(state.workspaces.some((item) => item.id === 'ws-1')).toBe(false)
    expect(state.sessions.some((item) => item.workspaceId === 'ws-1')).toBe(false)
    expect(state.tabs.some((tab) => tab.kind === 'workspace' && tab.workspaceId === 'ws-1')).toBe(false)
    expect(state.activeTabId).toBe(HOME_TAB_ID)
    delete (window as unknown as { nxcore?: unknown }).nxcore
  })

  it('启动时按持久化恢复工作空间标签，并忽略已删除的空间', async () => {
    localStorage.setItem('everroom:workbench:tabs:v1', JSON.stringify({
      workspaceIds: ['ws-1', 'ws-gone'],
      activeTabId: workspaceTabId('ws-1'),
    }))
    ;(window as unknown as { nxcore: unknown }).nxcore = {
      workspace: { list: vi.fn(async () => [WS1, WS2]) },
      agent: { listSessions: vi.fn(async () => [session({ id: 's-1' })]) },
    }
    useWorkbenchStore.setState({ booted: false, loading: false, workspaces: [], sessions: [], tabs: [], activeTabId: HOME_TAB_ID })
    await useWorkbenchStore.getState().boot()
    const state = useWorkbenchStore.getState()
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, workspaceTabId('ws-1')])
    expect(state.activeTabId).toBe(workspaceTabId('ws-1'))
    delete (window as unknown as { nxcore?: unknown }).nxcore
  })
})

describe('纯函数', () => {
  it('标签标题按类型取空间名/文件名', () => {
    expect(tabTitle({ id: 'home', kind: 'home', page: 'recent' }, [WS1])).toBe('主页')
    expect(tabTitle({ id: workspaceTabId('ws-1'), kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'overview' } }, [WS1])).toBe('连接器项目')
    expect(tabTitle({ id: 'file:f1', kind: 'file', file: officeFile('f1', '周报.docx') }, [WS1])).toBe('周报.docx')
  })

  it('会话状态归一：running→进行中，closed/interrupted→已结束，其余→待开始', () => {
    expect(workSessionStatus(session({ id: 'a', status: 'running' }))).toBe('running')
    expect(workSessionStatus(session({ id: 'b', status: 'closed' }))).toBe('done')
    expect(workSessionStatus(session({ id: 'c', status: 'interrupted' }))).toBe('done')
    expect(workSessionStatus(session({ id: 'd', status: 'idle' }))).toBe('idle')
  })

  it('会话排序：运行中优先，然后按更新时间倒序', () => {
    const sorted = sortWorkbenchSessions([
      session({ id: 'idle-new', updatedAt: '2026-10-03T00:00:00.000Z' }),
      session({ id: 'running-old', status: 'running', updatedAt: '2026-10-01T00:00:00.000Z' }),
      session({ id: 'idle-old', updatedAt: '2026-10-02T00:00:00.000Z' }),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['running-old', 'idle-new', 'idle-old'])
  })

  it('会话标题空值回落为「新工作」', () => {
    expect(sessionDisplayTitle(session({ id: 'x', title: null }))).toBe('新工作')
    expect(sessionDisplayTitle(session({ id: 'y', title: '  周报  ' }))).toBe('周报')
  })

  it('相对时间标签', () => {
    expect(relativeTimeLabel(new Date().toISOString())).toBe('刚刚')
    expect(relativeTimeLabel(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 分钟前')
    expect(relativeTimeLabel(null)).toBe('')
  })
})
