import { Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { catalogToOfficeFile } from '@/office-proto/data'
import { HomePageHost } from '../home/HomePageHost'
import { useActiveTab, useWorkbenchStore } from '../state/store'
import { cn } from '../ui/cn'
import { ErrorBoundary } from '../ui/error-boundary'
import { useCreateSpaceFlow } from '../workspace/createSpace'
import { HomeSidebar } from './HomeSidebar'
import { TabBar } from './TabBar'
import { CommandPalette } from './CommandPalette'
import { Toaster } from './Toaster'
import { workbenchToast } from './toast'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { WorkspaceTabHost } from './WorkspaceTabHost'
import { dispatchOpenAgentFile } from './openAgentFile'
import '../ui/ui.css'
import '../styles/workbench.css'

const SESSION_POLL_MS = 4000

/**
 * 标签页工作台外壳：
 *   标签栏（窗口级）
 *   ├─ 侧栏（随激活标签互斥切换：主页侧栏 / 工作空间侧栏）
 *   └─ 内容区（主页标签 / 各工作空间标签；常驻挂载仅切 display。文件不占标签，
 *      一律在归属工作空间的气泡窗里打开）
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

  /** Agent 生成中的产物进度（pptx 脚本执行 phase 事件；done/error 清除）。 */
  const [generationProgress, setGenerationProgress] = useState<{ title: string; phase: string; slide?: number } | null>(null)
  const createSpace = useCreateSpaceFlow()

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
  // 新建空间 = 一步式流程：弹系统目录选择器，选完即建（见 workspace/createSpace.ts）。
  useEffect(() => {
    const openNewSpace = () => { void createSpace() }
    window.addEventListener('everroom:workbench-new-space', openNewSpace)
    return () => window.removeEventListener('everroom:workbench-new-space', openNewSpace)
  }, [createSpace])

  // 主进程主动发起的预览（排版面板 👁 预览模版原文件等）：实例已在主进程建好，
  // 这里在归属工作空间里打开（激活标签 + 气泡窗接管实例）。不接这条事件，
  // 原生视图会一直隐藏（「点了没反应」）。
  useEffect(() => {
    const office = window.nxcore?.office
    if (!office?.onPreviewRequest) return
    let disposed = false
    // 2026-11-06：主进程每次 openOriginal 都会广播一次预览请求，而预览宿主又会
    // openOriginal，构成 IPC 反馈环。同一实例短时间内只处理一次，合并环里的
    // 重复广播；用户手动重新打开（间隔 >800ms）不受影响。
    const lastHandledAt = new Map<string, number>()
    const unsubscribe = office.onPreviewRequest(async (request) => {
      const now = Date.now()
      const previous = lastHandledAt.get(request.instanceId)
      if (previous !== undefined && now - previous < 800) return
      lastHandledAt.set(request.instanceId, now)
      try {
        const catalog = await window.nxcore?.files?.catalogEntry(request.instanceId)
        const entry = catalog ? catalogToOfficeFile(catalog) : null
        if (disposed) return
        if (entry) {
          useWorkbenchStore.getState().openFileInWorkspace(entry.file)
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

  // 主进程 open-edit 广播：Agent 落页/续落时该产物未以可编辑会话打开（用户关了页签
  // 或应用重启后点「重新生成」），按广播以可编辑方式打开，fillPage 的 not_open 自动
  // 打开兜底才能闭环——此前该事件没有任何消费方，续落必报「请先在文件库打开」。
  useEffect(() => {
    const office = window.nxcore?.office
    if (typeof office?.onAgentFile !== 'function') return
    return office.onAgentFile((event) => {
      if (event.type === 'open-edit' && event.fileId) {
        void window.nxcore?.files
          ?.openOriginal(event.fileId, event.originalName ?? event.title, undefined, { editable: true })
          .catch(() => undefined)
        return
      }
      // 生成进度（phase）：正在渲染的产物挂起进度徽标；终态（done/error）清掉。
      if (event.type === 'phase' && event.format === 'pptx') {
        setGenerationProgress({
          title: event.title,
          phase: event.phase ?? 'rendering',
          ...(typeof event.slide === 'number' ? { slide: event.slide } : {}),
        })
        return
      }
      if (event.type === 'done' || event.type === 'error') {
        setGenerationProgress((current) => current?.title === event.title ? null : current)
      }
    })
  }, [])

  /**
   * Agent 产物就绪（office:agent-file done）→ 自动展示结果：
   * 按归属工作空间定位标签，把文件塞进该空间气泡窗（自动展开 + 打开内容）。
   *
   * 边界约定：
   * - 只有产物归属的空间**已开着标签且当前激活**才自动展开——用户正在别的
   *   空间/主页做事时，弹侧栏只会打断他；文件已入库 + 对话区有文件卡，想看
   *   随时能看。后台空间的标签即使挂着也不响应（激活时气泡窗才可见）。
   * - 同一 fileId 只处理一次：pptx 逐页链路可能补发多次 done，重复展开同
   *   一份文件没有信息增量。
   * - 事件缺 workspaceId（旧网关）→ 查 catalog 补齐；查不到就不动。
   */
  useEffect(() => {
    const office = window.nxcore?.office
    const files = window.nxcore?.files
    if (typeof office?.onAgentFile !== 'function' || !files?.catalogEntry) return
    let disposed = false
    const handled = new Set<string>()
    return office.onAgentFile(async (event) => {
      if (event.type !== 'done') return
      const fileId = event.fileId
      if (!fileId || handled.has(fileId)) return
      handled.add(fileId)
      try {
        let workspaceId = event.workspaceId ?? null
        if (!workspaceId) {
          const catalog = await files.catalogEntry!(fileId).catch(() => null)
          workspaceId = catalog?.workspaceId?.trim() || null
        }
        if (disposed || !workspaceId) return
        const state = useWorkbenchStore.getState()
        const tab = state.tabs.find(
          (item) => item.kind === 'workspace' && item.workspaceId === workspaceId,
        )
        // 归属空间没开标签、或不处于激活态：不打扰（见上方边界约定）。
        if (tab?.kind !== 'workspace' || state.activeTabId !== tab.id) return
        const catalog = await files.catalogEntry!(fileId).catch(() => null)
        const entry = catalog ? catalogToOfficeFile(catalog) : null
        if (disposed || !entry) return
        dispatchOpenAgentFile({ tabId: tab.id, workspaceId, file: entry.file })
      } catch {
        // 自动展示失败静默放弃：文件已入库，对话区文件卡仍是可靠入口。
      }
    })
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

  /** 批注队列快照同步：宿主队列（事实）→ 主进程 → 对应编辑器视图（文档内锚点）。 */
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
        ...(draft.anchor ? { anchor: draft.anchor } : {}),
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
        // 主页上 ⌘N = 一步式新建项目空间（选目录即建）；空间内 = 新工作草稿。
        if (activeTab.kind === 'workspace') setWorkspaceView(activeTab.id, { kind: 'draft' })
        else void createSpace()
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
  }, [activeTab, createSpace, requestCloseTab, setWorkspaceView, toggleSidebar])

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
      {generationProgress ? (
        <div className="wb-generation-progress" role="status">
          <span className="wb-generation-progress-dot" aria-hidden="true" />
          <span>
            {generationProgress.phase === 'importing'
              ? `正在入库：${generationProgress.title}`
              : generationProgress.slide
                ? `正在生成：${generationProgress.title} · 第 ${generationProgress.slide} 页`
                : `正在生成：${generationProgress.title}`}
          </span>
        </div>
      ) : null}
      <TabBar />
      <div className="wb-body">
        {/* 侧栏保持挂载、用 max-width 过渡收起：折叠/展开有明确视觉反馈，组件内部状态也不丢。 */}
        <div className={cn('wb-sidebar-slot', sidebarCollapsed && 'is-collapsed')} aria-hidden={sidebarCollapsed}>
          {activeTab.kind === 'workspace'
            ? <WorkspaceSidebar tab={activeTab} />
            : <HomeSidebar />}
        </div>
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
              return null
            })}
          </div>
        </main>
      </div>

      <CommandPalette />
      <Toaster />
    </div>
  )
}
