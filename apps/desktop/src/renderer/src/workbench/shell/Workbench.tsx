import { Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { catalogToOfficeFile } from '@/office-proto/data'
import { HomePageHost } from '../home/HomePageHost'
import { useActiveTab, useWorkbenchStore } from '../state/store'
import { cn } from '../ui/cn'
import { ErrorBoundary } from '../ui/error-boundary'
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog'
import { FileTabHost } from './FileTabHost'
import { HomeSidebar } from './HomeSidebar'
import { TabBar } from './TabBar'
import { CommandPalette } from './CommandPalette'
import { Toaster } from './Toaster'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { WorkspaceTabHost } from './WorkspaceTabHost'
import '../ui/ui.css'
import '../styles/workbench.css'

const SESSION_POLL_MS = 4000

/**
 * 标签页工作台外壳：
 *   标签栏（窗口级）
 *   ├─ 侧栏（随激活标签互斥切换：主页侧栏 / 工作空间侧栏 / 文件标签无侧栏）
 *   └─ 内容区（主页标签 / 各工作空间标签 / 文件标签；后两者常驻挂载仅切 display）
 */
export function Workbench() {
  const boot = useWorkbenchStore((state) => state.boot)
  const booted = useWorkbenchStore((state) => state.booted)
  const loading = useWorkbenchStore((state) => state.loading)
  const error = useWorkbenchStore((state) => state.error)
  const setError = useWorkbenchStore((state) => state.setError)
  const tabs = useWorkbenchStore((state) => state.tabs)
  const activeTabId = useWorkbenchStore((state) => state.activeTabId)
  const sidebarCollapsed = useWorkbenchStore((state) => state.sidebarCollapsed)
  const activeTab = useActiveTab()
  const refreshSessions = useWorkbenchStore((state) => state.refreshSessions)
  const refresh = useWorkbenchStore((state) => state.refresh)
  const toggleSidebar = useWorkbenchStore((state) => state.toggleSidebar)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const requestCloseTab = useWorkbenchStore((state) => state.requestCloseTab)

  const [newSpaceOpen, setNewSpaceOpen] = useState(false)

  useEffect(() => { void boot() }, [boot])

  // 会话状态轮询：run 在网关侧继续跑，侧栏/看板只消费最新状态。
  useEffect(() => {
    if (!booted) return
    const timer = window.setInterval(() => { void refreshSessions() }, SESSION_POLL_MS)
    const onFocus = () => {
      void refreshSessions()
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [booted, refresh, refreshSessions])

  // 全局事件：标签栏/页面里没有 store 入口的跨区域动作走事件（新建空间、搜索）。
  useEffect(() => {
    const openNewSpace = () => setNewSpaceOpen(true)
    window.addEventListener('everroom:workbench-new-space', openNewSpace)
    return () => window.removeEventListener('everroom:workbench-new-space', openNewSpace)
  }, [])

  // 主进程主动发起的预览（排版面板 👁 预览模版原文件等）：实例已在主进程建好，
  // 这里开文件标签并激活。不接这条事件，原生视图会一直隐藏（「点了没反应」）。
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onPreviewRequest) return
    let disposed = false
    const unsubscribe = office.onPreviewRequest(async (request) => {
      try {
        const catalog = await window.nxcore?.files?.catalogEntry(request.instanceId)
        const entry = catalog ? catalogToOfficeFile(catalog) : null
        if (disposed) return
        if (entry) {
          useWorkbenchStore.getState().openFileTab(entry.file)
          return
        }
        // 查不到条目（如刚被删除）：至少把已建好的实例关掉，避免泄漏隐藏视图。
        await window.nxcore?.office?.closeInstance(request.instanceId).catch(() => undefined)
      } catch {
        // 预览通知失败不打断用户：静默关掉实例即可。
        await window.nxcore?.office?.closeInstance(request.instanceId).catch(() => undefined)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  // 快捷键：⌘N 新建工作 / ⌘B 侧栏 / ⌘J 气泡窗（由工作空间标签自己响应）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        if (activeTab.kind === 'workspace') setWorkspaceView(activeTab.id, { kind: 'draft' })
        else setNewSpaceOpen(true)
      } else if (key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (key === 'j' && activeTab.kind === 'workspace') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('everroom:workbench-toggle-bubble', { detail: activeTab.id }))
      } else if (key === 'w' && !event.shiftKey && activeTab.kind !== 'home') {
        // ⌘W 关当前标签（保留主页）；默认行为是关窗口，这里只关标签。
        event.preventDefault()
        void requestCloseTab(activeTab.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, requestCloseTab, setWorkspaceView, toggleSidebar])

  if (!booted && loading) {
    return (
      <div className="wb-root">
        <div className="wb-boot">
          <div className="wb-boot-inner">
            <Loader2 size={15} className="ui-spin" aria-hidden="true" />
            正在加载工作台…
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="wb-root" data-sidebar-collapsed={String(sidebarCollapsed)}>
      <TabBar />
      <div className="wb-body">
        {/* 侧栏保持挂载、用 max-width 过渡收起：折叠/展开有明确视觉反馈，组件内部状态也不丢。 */}
        {activeTab.kind !== 'file' ? (
          <div className={cn('wb-sidebar-slot', sidebarCollapsed && 'is-collapsed')} aria-hidden={sidebarCollapsed}>
            {activeTab.kind === 'workspace'
              ? <WorkspaceSidebar tab={activeTab} />
              : <HomeSidebar />}
          </div>
        ) : null}
        <main className="wb-content">
          {error ? (
            <div className="wb-errorbar" role="alert">
              <span>{error}</span>
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setError(null)}>
                <X size={13} /> 知道了
              </button>
            </div>
          ) : null}

          <div className="wb-tabpanes">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId
              if (tab.kind === 'home') {
                return (
                  <div key={tab.id} className={cn('wb-tabpane', active && 'is-active')} aria-hidden={!active}>
                    <ErrorBoundary label="主页" resetKey={`home:${tab.page}`}>
                      <HomePageHost page={tab.page} />
                    </ErrorBoundary>
                  </div>
                )
              }
              if (tab.kind === 'workspace') {
                return (
                  <div key={tab.id} className={cn('wb-tabpane', active && 'is-active')} aria-hidden={!active}>
                    <ErrorBoundary label="工作空间" resetKey={tab.id}>
                      <WorkspaceTabHost tab={tab} active={active} />
                    </ErrorBoundary>
                  </div>
                )
              }
              return (
                <div key={tab.id} className={cn('wb-tabpane', active && 'is-active')} aria-hidden={!active}>
                  {/* 原生编辑器同时只允许一个可见：只有激活的文件标签挂载宿主。 */}
                  {active ? (
                    <ErrorBoundary label="文件" resetKey={tab.id}>
                      <FileTabHost tab={tab} />
                    </ErrorBoundary>
                  ) : null}
                </div>
              )
            })}
          </div>
        </main>
      </div>

      <CreateWorkspaceDialog open={newSpaceOpen} onOpenChange={setNewSpaceOpen} />
      <CommandPalette />
      <Toaster />
    </div>
  )
}
