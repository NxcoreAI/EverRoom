import { Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
import { workbenchToast } from './toast'
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

  /**
   * Office「AI 修改」浮层转发（Word 选区浮层 / slides 弹层共用通道）：
   * 主进程已按 webContents id 反查出所属工作空间，这里激活该空间标签（没有
   * 对话视图时切到新工作草稿），再把消息放进 store 由对话面板挂载后消费。
   */
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onAgentAsk) return
    return office.onAgentAsk((event) => {
      const workspaceId = event.workspaceId ?? event.roomId ?? null
      if (!workspaceId) {
        workbenchToast('这条批注没有归属工作空间，无法发送给 Agent')
        return
      }
      const state = useWorkbenchStore.getState()
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        workbenchToast('该文件所属的工作空间还没同步到工作台，请稍后重试')
        return
      }
      if (event.mode === 'queue') {
        // 攒批注不抢焦点：用户还在文档里挑下一处，跳标签会打断他。
        // 可见性交给对话输入框上方的批注徽章（NoteQueueChip），这里不再 toast。
        state.addAskDraft({
          id: crypto.randomUUID(),
          workspaceId,
          ...(event.fileId ? { fileId: event.fileId } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.instruction ? { instruction: event.instruction } : {}),
          ...(event.excerpt ? { excerpt: event.excerpt } : {}),
          ...(event.anchor ? { anchor: event.anchor } : {}),
          message: event.message,
          ...(event.displayMessage ? { displayMessage: event.displayMessage } : {}),
          createdAt: new Date().toISOString(),
        })
        return
      }
      const tab = state.tabs.find(
        (item) => item.kind === 'workspace' && item.workspaceId === workspaceId,
      )
      const keepsConversation = tab?.kind === 'workspace'
        && (tab.view.kind === 'session' || tab.view.kind === 'draft')
      // 已有对话视图就保留（不打断正在跑的 run），否则切到新工作草稿。
      state.openWorkspaceTab(workspaceId, keepsConversation ? undefined : { kind: 'draft' })
      state.setPendingAgentAsk({
        id: crypto.randomUUID(),
        workspaceId,
        message: event.message,
        ...(event.displayMessage ? { displayMessage: event.displayMessage } : {}),
      })
    })
  }, [])

  /** 批注队列快照同步：宿主队列（事实）→ 主进程 → 对应文档视图（锚点 + 面板）。 */
  const askDrafts = useWorkbenchStore((state) => state.askDrafts)
  const syncedAskQueues = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.syncAskQueue) return
    const grouped = new Map<string, typeof askDrafts>()
    for (const draft of askDrafts) {
      if (!draft.fileId) continue
      grouped.set(draft.fileId, [...(grouped.get(draft.fileId) ?? []), draft])
    }
    const fileIds = new Set([...grouped.keys(), ...syncedAskQueues.current.keys()])
    for (const fileId of fileIds) {
      const items = (grouped.get(fileId) ?? []).map((draft) => ({
        id: draft.id,
        instruction: draft.instruction ?? draft.displayMessage ?? draft.message,
        ...(draft.excerpt ? { excerpt: draft.excerpt } : {}),
        fromBlockIndex: draft.anchor?.fromBlockIndex ?? 0,
        toBlockIndex: draft.anchor?.toBlockIndex ?? 0,
        kind: draft.anchor?.kind ?? 'text',
      }))
      const signature = JSON.stringify(items)
      if (syncedAskQueues.current.get(fileId) === signature) continue
      syncedAskQueues.current.set(fileId, signature)
      office.syncAskQueue({ fileId, items })
    }
  }, [askDrafts])

  /** 文档内批注面板的动作：移除 / 改写一条 / 全部发送（后者先激活对话标签再触发一次发送）。 */
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onAskQueueAction) return
    return office.onAskQueueAction((event) => {
      const state = useWorkbenchStore.getState()
      if (event.action.kind === 'remove') {
        state.removeAskDraft(event.action.draftId)
        return
      }
      if (event.action.kind === 'update') {
        state.updateAskDraft(event.action.draftId, event.action.instruction)
        return
      }
      const tab = state.tabs.find(
        (item) => item.kind === 'workspace' && item.workspaceId === event.workspaceId,
      )
      const keepsConversation = tab?.kind === 'workspace'
        && (tab.view.kind === 'session' || tab.view.kind === 'draft')
      state.openWorkspaceTab(event.workspaceId, keepsConversation ? undefined : { kind: 'draft' })
      state.requestAskQueueSend()
    })
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
