import type {
  AgentSession,
  AgentWorkspace,
  CreateAgentWorkspaceInput,
  UpdateAgentWorkspaceInput,
} from '@nxcore/agent-contract'
import { useMemo } from 'react'
import { create } from 'zustand'

import type { OfficeFile } from '@/office-proto/data'

import { workbenchApi } from '../api'
import {
  DEFAULT_WORKSPACE_VIEW,
  HOME_TAB,
  HOME_TAB_ID,
  type HomePageKey,
  type WorkspacePageKey,
  type WorkspaceTab,
  type WorkspaceTabView,
  type WindowTab,
  fileTabId,
  readPersistedTabs,
  sessionsOfWorkspace,
  workspaceTabId,
  writePersistedTabs,
} from '../types'

/** 网关不可用时也能渲染侧栏骨架；等真实数据回来后覆盖。 */
const FALLBACK_DEFAULT_WORKSPACE: AgentWorkspace = {
  id: 'default',
  name: '默认工作区',
  path: null,
  kind: 'default',
  description: null,
  goals: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lastOpenedAt: new Date(0).toISOString(),
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function defaultWorkspaceOf(workspaces: readonly AgentWorkspace[]): AgentWorkspace {
  return workspaces.find((workspace) => workspace.kind === 'default')
    ?? workspaces.find((workspace) => workspace.id === 'default')
    ?? workspaces[0]
    ?? FALLBACK_DEFAULT_WORKSPACE
}

/** 标签页脏关闭守卫注册表：工作空间标签里的气泡窗/编辑器在卸载前先过主进程的保存对话框。 */
const tabClosers = new Map<string, () => Promise<boolean>>()

/** 注册一个标签的关闭守卫；返回注销函数。 */
export function registerTabCloser(tabId: string, closer: () => Promise<boolean>): () => void {
  tabClosers.set(tabId, closer)
  return () => {
    if (tabClosers.get(tabId) === closer) tabClosers.delete(tabId)
  }
}

/** 关闭文件标签/气泡文件前先过编辑器脏关闭守卫（保存对话框里取消 → 保留标签）。 */
export async function closeOfficeFile(file: OfficeFile): Promise<boolean> {
  const closing = file.realCatalog
    ? window.nxcore?.office?.closeInstance(file.realCatalog.id)
    : window.desktop?.office.close(file.id)
  try {
    const closed = await closing
    return closed !== false
  } catch {
    return false
  }
}

/** 主页标签始终在最左；工作空间/文件标签按打开顺序跟在后面。 */
function normalizeTabs(tabs: readonly WindowTab[]): WindowTab[] {
  const home = tabs.find((tab): tab is typeof HOME_TAB => tab.kind === 'home') ?? HOME_TAB
  return [home, ...tabs.filter((tab) => tab.kind !== 'home')]
}

/** 当前激活标签被关掉后，挑相邻标签（优先右边，其次左边，最后主页）。 */
function pickNextTabId(tabs: readonly WindowTab[], closingId: string): string {
  const index = tabs.findIndex((tab) => tab.id === closingId)
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next?.id ?? HOME_TAB_ID
}

/** 校验恢复出来的视图：会话不存在时回落到概览，避免标签渲染出空会话。 */
function sanitizeWorkspaceView(view: WorkspaceTabView, sessions: readonly AgentSession[]): WorkspaceTabView {
  if (view.kind !== 'session') return view
  return sessions.some((session) => session.id === view.sessionId) ? view : DEFAULT_WORKSPACE_VIEW
}

/** 从持久化数据恢复标签：只恢复仍然存在的工作空间；激活标签不存在则回主页。 */
function restoreTabs(workspaces: readonly AgentWorkspace[], sessions: readonly AgentSession[]): {
  tabs: WindowTab[]
  activeTabId: string
} {
  const persisted = readPersistedTabs()
  const tabs: WindowTab[] = [HOME_TAB]
  for (const workspaceId of persisted.workspaceIds) {
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) continue
    if (tabs.some((tab) => tab.kind === 'workspace' && tab.workspaceId === workspaceId)) continue
    tabs.push({
      id: workspaceTabId(workspaceId),
      kind: 'workspace',
      workspaceId,
      view: DEFAULT_WORKSPACE_VIEW,
    })
  }
  const validIds = new Set(tabs.map((tab) => tab.id))
  const activeTabId = persisted.activeTabId && validIds.has(persisted.activeTabId)
    ? persisted.activeTabId
    : HOME_TAB_ID
  void sessions
  return { tabs, activeTabId }
}

function persistTabs(tabs: readonly WindowTab[], activeTabId: string): void {
  writePersistedTabs({
    workspaceIds: tabs
      .filter((tab): tab is WorkspaceTab => tab.kind === 'workspace')
      .map((tab) => tab.workspaceId),
    activeTabId,
  })
}

/**
 * 标签页版工作台状态。
 *
 * 数据（workspaces / sessions）仍然来自网关；视图状态收敛成「窗口标签数组 + 激活标签」：
 * 主页标签固定存在，每个工作空间最多一个标签，文件标签按需打开。侧栏形态由激活标签决定。
 */
interface WorkbenchStore {
  booted: boolean
  loading: boolean
  error: string | null
  workspaces: AgentWorkspace[]
  sessions: AgentSession[]
  tabs: WindowTab[]
  activeTabId: string
  sidebarCollapsed: boolean
  /** 刚创建、还没走完三步引导的工作空间 id（引导弹窗由工作空间标签渲染）。 */
  pendingSetupWorkspaceId: string | null

  boot(): Promise<void>
  refresh(): Promise<void>
  refreshSessions(): Promise<void>
  setError(error: string | null): void

  openHome(page?: HomePageKey): void
  setHomePage(page: HomePageKey): void
  openWorkspaceTab(workspaceId: string, view?: WorkspaceTabView): void
  openFileTab(file: OfficeFile): void
  activateTab(tabId: string): void
  setWorkspaceView(tabId: string, view: WorkspaceTabView): void
  /** 关标签：先跑注册的脏关闭守卫；守卫取消则保留标签。返回是否真的关掉。 */
  requestCloseTab(tabId: string): Promise<boolean>
  setActiveWorkspacePage(workspaceId: string, page: WorkspacePageKey): void

  createWorkspace(input: CreateAgentWorkspaceInput): Promise<AgentWorkspace | null>
  /** 关闭三步引导（完成/全部跳过）。 */
  finishWorkspaceSetup(): void
  updateWorkspaceMeta(id: string, input: UpdateAgentWorkspaceInput): Promise<boolean>
  renameWorkspace(id: string, name: string): Promise<boolean>
  deleteWorkspace(id: string): Promise<boolean>

  createSession(workspaceId?: string | null): Promise<AgentSession | null>
  syncTabSession(tabId: string, session: AgentSession | null): void
  renameSession(id: string, title: string): Promise<boolean>
  deleteSession(id: string): Promise<boolean>

  toggleSidebar(): void
}

let sessionsRefreshInFlight = false

export const useWorkbenchStore = create<WorkbenchStore>()((set, get) => ({
  booted: false,
  loading: false,
  error: null,
  workspaces: [],
  sessions: [],
  tabs: normalizeTabs([HOME_TAB]),
  activeTabId: HOME_TAB_ID,
  sidebarCollapsed: false,
  pendingSetupWorkspaceId: null,

  setError(error) {
    set({ error })
  },

  async boot() {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const [workspaces, sessions] = await Promise.all([
        workbenchApi.listWorkspaces(),
        // 会话清单失败不阻塞外壳启动：工作区是骨架，会话可稍后轮询回来。
        workbenchApi.listSessions().catch(() => [] as AgentSession[]),
      ])
      const resolved = workspaces.length ? workspaces : [FALLBACK_DEFAULT_WORKSPACE]
      const { tabs, activeTabId } = restoreTabs(resolved, sessions)
      set({
        booted: true,
        loading: false,
        workspaces: resolved,
        sessions,
        tabs,
        activeTabId,
      })
      persistTabs(tabs, activeTabId)
    } catch (error) {
      set({ loading: false, booted: true, error: errorMessage(error, '工作台初始化失败') })
    }
  },

  async refresh() {
    const [workspacesResult, sessionsResult] = await Promise.allSettled([
      workbenchApi.listWorkspaces(),
      workbenchApi.listSessions(),
    ])
    const patch: Partial<WorkbenchStore> = {}
    if (workspacesResult.status === 'fulfilled') {
      const resolved = workspacesResult.value.length ? workspacesResult.value : [FALLBACK_DEFAULT_WORKSPACE]
      patch.workspaces = resolved
      // 工作区被删后，它的标签页也要消失；当前激活标签没了就退回主页。
      const state = get()
      const existing = new Set(resolved.map((workspace) => workspace.id))
      const tabs = state.tabs.filter((tab) => tab.kind !== 'workspace' || existing.has(tab.workspaceId))
      const activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : HOME_TAB_ID
      patch.tabs = tabs
      patch.activeTabId = activeTabId
      persistTabs(tabs, activeTabId)
    }
    if (sessionsResult.status === 'fulfilled') {
      patch.sessions = sessionsResult.value
      const sessions = sessionsResult.value
      // 会话被删/不存在时，标签里的会话视图回落到概览。
      patch.tabs = (patch.tabs ?? get().tabs).map((tab) =>
        tab.kind === 'workspace' ? { ...tab, view: sanitizeWorkspaceView(tab.view, sessions) } : tab)
    }
    if (Object.keys(patch).length) set(patch)
    if (workspacesResult.status === 'rejected' && sessionsResult.status === 'rejected') {
      set({ error: errorMessage(workspacesResult.reason, '工作台数据加载失败') })
    }
  },

  async refreshSessions() {
    if (sessionsRefreshInFlight) return
    sessionsRefreshInFlight = true
    try {
      const sessions = await workbenchApi.listSessions()
      set((state) => ({
        sessions,
        tabs: state.tabs.map((tab) =>
          tab.kind === 'workspace' ? { ...tab, view: sanitizeWorkspaceView(tab.view, sessions) } : tab),
      }))
    } catch {
      // 轮询失败保持旧快照，不闪错误。
    } finally {
      sessionsRefreshInFlight = false
    }
  },

  openHome(page) {
    set((state) => {
      const tabs = state.tabs.map((tab) =>
        tab.kind === 'home' ? { ...tab, page: page ?? tab.page } : tab)
      return { tabs: normalizeTabs(tabs), activeTabId: HOME_TAB_ID, error: null }
    })
    persistTabs(get().tabs, HOME_TAB_ID)
  },

  setHomePage(page) {
    get().openHome(page)
  },

  openWorkspaceTab(workspaceId, view) {
    const workspace = get().workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    const id = workspaceTabId(workspaceId)
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === id)
      const tabs = existing
        ? state.tabs.map((tab) =>
          tab.id === id && tab.kind === 'workspace'
            ? { ...tab, view: view ?? tab.view }
            : tab)
        : normalizeTabs([...state.tabs, {
          id,
          kind: 'workspace' as const,
          workspaceId,
          view: view ?? DEFAULT_WORKSPACE_VIEW,
        }])
      return { tabs, activeTabId: id, error: null }
    })
    persistTabs(get().tabs, id)
    // 记录最近打开：失败不影响交互。
    void workbenchApi.updateWorkspace(workspaceId, { lastOpenedAt: new Date().toISOString() }).catch(() => undefined)
  },

  openFileTab(file) {
    const id = fileTabId(file.id)
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === id)
      const tabs = existing
        ? state.tabs.map((tab) => (tab.id === id ? { ...tab, kind: 'file' as const, file } : tab))
        : normalizeTabs([...state.tabs, { id, kind: 'file' as const, file }])
      return { tabs, activeTabId: id, error: null }
    })
    persistTabs(get().tabs, id)
  },

  activateTab(tabId) {
    if (!get().tabs.some((tab) => tab.id === tabId)) return
    set({ activeTabId: tabId, error: null })
    persistTabs(get().tabs, tabId)
  },

  setWorkspaceView(tabId, view) {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.kind === 'workspace' ? { ...tab, view } : tab),
      activeTabId: tabId,
    }))
    persistTabs(get().tabs, tabId)
  },

  setActiveWorkspacePage(workspaceId, page) {
    get().openWorkspaceTab(workspaceId, { kind: 'page', page })
  },

  async requestCloseTab(tabId) {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab || tab.kind === 'home') return false
    if (tab.kind === 'file') {
      const closed = await closeOfficeFile(tab.file)
      if (!closed) return false
    } else {
      const closer = tabClosers.get(tabId)
      if (closer) {
        try {
          const closed = await closer()
          if (!closed) return false
        } catch {
          return false
        }
      }
    }
    const nextState = get()
    if (!nextState.tabs.some((item) => item.id === tabId)) return true
    const nextActive = nextState.activeTabId === tabId
      ? pickNextTabId(nextState.tabs, tabId)
      : nextState.activeTabId
    set({
      tabs: nextState.tabs.filter((item) => item.id !== tabId),
      activeTabId: nextActive,
      error: null,
    })
    tabClosers.delete(tabId)
    persistTabs(get().tabs, nextActive)
    return true
  },

  async createWorkspace(input) {
    try {
      const created = await workbenchApi.createWorkspace(input)
      set((state) => ({
        workspaces: [...state.workspaces.filter((workspace) => workspace.id !== created.id), created],
        error: null,
        pendingSetupWorkspaceId: created.id,
      }))
      get().openWorkspaceTab(created.id)
      return created
    } catch (error) {
      set({ error: errorMessage(error, '创建工作空间失败') })
      return null
    }
  },

  finishWorkspaceSetup() {
    set({ pendingSetupWorkspaceId: null })
  },

  async updateWorkspaceMeta(id, input) {
    try {
      const updated = await workbenchApi.updateWorkspace(id, input)
      set((state) => ({
        workspaces: state.workspaces.map((workspace) => (workspace.id === id ? updated : workspace)),
        error: null,
      }))
      return true
    } catch (error) {
      set({ error: errorMessage(error, '更新工作空间失败') })
      return false
    }
  },

  async renameWorkspace(id, name) {
    return get().updateWorkspaceMeta(id, { name })
  },

  async deleteWorkspace(id) {
    const target = get().workspaces.find((workspace) => workspace.id === id)
    if (!target || target.kind === 'default') return false
    try {
      await workbenchApi.deleteWorkspace(id)
      const workspaces = get().workspaces.filter((workspace) => workspace.id !== id)
      const removedSessionIds = new Set(
        get().sessions.filter((session) => session.workspaceId === id).map((session) => session.id),
      )
      const remainingTabs = get().tabs.filter((tab) => tab.kind !== 'workspace' || tab.workspaceId !== id)
      const activeTabId = remainingTabs.some((tab) => tab.id === get().activeTabId)
        ? get().activeTabId
        : HOME_TAB_ID
      set({
        workspaces,
        sessions: get().sessions.filter((session) => !removedSessionIds.has(session.id)),
        tabs: remainingTabs,
        activeTabId,
        error: null,
      })
      persistTabs(remainingTabs, activeTabId)
      // 网关删除空间时会把名下会话回落到默认空间，本地先移除再对账一次，
      // 避免轮询后这些会话「突然复活」在别的空间下却与本地状态不一致。
      void get().refresh()
      return true
    } catch (error) {
      set({ error: errorMessage(error, '删除工作空间失败') })
      return false
    }
  },

  async createSession(workspaceId) {
    const targetWorkspace = workspaceId ?? activeWorkspaceIdOf(get())
    if (!targetWorkspace) return null
    try {
      const session = await workbenchApi.createSession({
        pageLabel: 'Agent',
        roomId: null,
        workspaceId: targetWorkspace,
      })
      set((state) => ({
        sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
        error: null,
      }))
      get().openWorkspaceTab(targetWorkspace, { kind: 'session', sessionId: session.id })
      return session
    } catch (error) {
      set({ error: errorMessage(error, '新建工作失败') })
      return null
    }
  },

  syncTabSession(tabId, session) {
    if (!session) return
    set((state) => ({
      sessions: state.sessions.some((item) => item.id === session.id)
        ? state.sessions.map((item) => (item.id === session.id ? { ...item, ...session } : item))
        : [session, ...state.sessions],
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'workspace') return tab
        if (tab.view.kind === 'draft' || (tab.view.kind === 'session' && tab.view.sessionId === session.id)) {
          return { ...tab, view: { kind: 'session', sessionId: session.id } }
        }
        return tab
      }),
    }))
  },

  async renameSession(id, title) {
    const trimmed = title.trim()
    if (!trimmed) return false
    try {
      const updated = await workbenchApi.updateSession(id, { title: trimmed })
      set((state) => ({
        sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...updated } : session)),
        error: null,
      }))
      return true
    } catch (error) {
      set({ error: errorMessage(error, '重命名工作失败') })
      return false
    }
  },

  async deleteSession(id) {
    const target = get().sessions.find((session) => session.id === id)
    if (!target) return false
    if (target.status === 'running') {
      set({ error: '工作正在运行，先停止再删除' })
      return false
    }
    try {
      await workbenchApi.deleteSession(id)
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        tabs: state.tabs.map((tab) =>
          tab.kind === 'workspace' && tab.view.kind === 'session' && tab.view.sessionId === id
            ? { ...tab, view: DEFAULT_WORKSPACE_VIEW }
            : tab),
        error: null,
      }))
      return true
    } catch (error) {
      set({ error: errorMessage(error, '删除工作失败') })
      return false
    }
  },

  toggleSidebar() {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },
}))

function activeWorkspaceIdOf(state: { tabs: WindowTab[]; activeTabId: string }): string | null {
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  return tab?.kind === 'workspace' ? tab.workspaceId : null
}

/* ───────────────── 选择器 hooks ───────────────── */

export function useActiveTab(): WindowTab {
  return useWorkbenchStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId) ?? HOME_TAB)
}

export function useHomeTab(): typeof HOME_TAB {
  return useWorkbenchStore((state) =>
    (state.tabs.find((tab) => tab.kind === 'home') as typeof HOME_TAB | undefined) ?? HOME_TAB)
}

export function useActiveWorkspaceTab(): WorkspaceTab | null {
  return useWorkbenchStore((state) => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId)
    return tab?.kind === 'workspace' ? tab : null
  })
}

/** 某个工作空间下的会话（排序后）。 */
export function useWorkspaceSessions(workspaceId: string | null): AgentSession[] {
  const sessions = useWorkbenchStore((state) => state.sessions)
  return useMemo(() => sessionsOfWorkspace(sessions, workspaceId), [sessions, workspaceId])
}

/** 某个工作空间对象。 */
export function useWorkspace(workspaceId: string | null): AgentWorkspace | null {
  return useWorkbenchStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null)
}

/** 侧栏/inline 简单提示：直接读 store.error。 */
export function useWorkbenchError(): string | null {
  return useWorkbenchStore((state) => state.error)
}
