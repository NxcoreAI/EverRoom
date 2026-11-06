import { FolderOpen } from 'lucide-react'
import { useEffect } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import type { OfficeFile } from '@/office-proto/data'

import { ConversationPane } from '../conversation/ConversationPane'
import { useWorkbenchStore, useWorkspaceSessions, useWorkspace } from '../state/store'
import { cn } from '../ui/cn'
import {
  type WorkspacePageKey,
  type WorkspaceTab,
  sessionDisplayTitle,
} from '../types'
import { Hint, IconButton } from '../ui/primitives'
import { SetupWizard } from '../workspace/SetupWizard'
import { BubbleWindow } from '../workspace/BubbleWindow'
import { LibraryPage } from '../workspace/LibraryPage'
import { OverviewPage } from '../workspace/OverviewPage'
import { OutputsPage } from '../workspace/OutputsPage'
import { PlanPage } from '../workspace/PlanPage'
import { useWorkspaceBubble } from '../workspace/useBubble'
import type { WorkspacePageProps } from '../workspace/contracts'
import { workbenchToast } from '../shell/toast'
import { isWorkspaceBubbleTarget, OPEN_AGENT_FILE_EVENT, type OpenAgentFileDetail } from '../shell/openAgentFile'
import '../workspace/workspace.css'

/**
 * 工作空间标签的内容宿主：
 * - 功能页（概览/资料库/产物/计划）与工作会话二选一显示；
 * - 会话只在该标签激活时挂载（网关同一时刻只维护一个 agent 订阅），切标签会重新拉快照；
 * - 右侧文件气泡窗由本组件持有，跨页面切换保留。
 */
export function WorkspaceTabHost({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const workspace = useWorkspace(tab.workspaceId)
  const sessions = useWorkspaceSessions(tab.workspaceId)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const pendingSetupWorkspaceId = useWorkbenchStore((state) => state.pendingSetupWorkspaceId)
  const finishWorkspaceSetup = useWorkbenchStore((state) => state.finishWorkspaceSetup)
  const bubble = useWorkspaceBubble(tab.id)

  // ⌘J：面板收起时打开「资料与文件」浏览（没有文件也能开），已展开时收起。
  useEffect(() => {
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      if (detail !== tab.id || !active) return
      if (bubble.visible) bubble.minimize()
      else bubble.openBrowser()
    }
    window.addEventListener('everroom:workbench-toggle-bubble', onToggle)
    return () => window.removeEventListener('everroom:workbench-toggle-bubble', onToggle)
  }, [active, bubble, tab.id])

  // Agent 产物就绪（Workbench 按 workspaceId 定向派发）：气泡窗自动展开并打开
  // 该文件——任务完成的「结果展示」一步到位，用户不必自己去产物库找。
  // 非激活标签只收事件不展开（激活时气泡窗才可见），避免后台空间互相打扰。
  useEffect(() => {
    const onOpenAgentFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenAgentFileDetail>).detail
      if (!isWorkspaceBubbleTarget(detail, tab.id) || !active) return
      bubble.openFile(detail.file)
    }
    window.addEventListener(OPEN_AGENT_FILE_EVENT, onOpenAgentFile)
    return () => window.removeEventListener(OPEN_AGENT_FILE_EVENT, onOpenAgentFile)
  }, [active, bubble, tab.id])

  // 「在工作空间里打开文件」（openFileInWorkspace 写入 store 的交接载荷）：
  // 挂载/激活时取走一次并交给气泡窗。非激活标签不抢——store 里只有一份，
  // 等目标标签激活后消费，避免后台空间替别人开文件。
  const consumePendingBubbleFile = useWorkbenchStore((state) => state.consumePendingBubbleFile)
  const pendingBubbleFile = useWorkbenchStore((state) => state.pendingBubbleFile)
  useEffect(() => {
    if (!active || !pendingBubbleFile) return
    if (pendingBubbleFile.tabId !== tab.id) return
    const file = consumePendingBubbleFile(tab.id)
    if (file) bubble.openFile(file)
  }, [active, pendingBubbleFile, consumePendingBubbleFile, bubble, tab.id])

  // 激活标签时刷新一次会话列表（后台 run 的标题/状态可能已经变了）。
  const refreshSessions = useWorkbenchStore((state) => state.refreshSessions)
  useEffect(() => {
    if (!active) return
    void refreshSessions()
  }, [active, refreshSessions])

  if (!workspace) {
    return <div className="wb-ws-missing">工作空间不存在或已删除</div>
  }

  const pageProps: WorkspacePageProps = {
    tab,
    workspace: workspace as AgentWorkspace,
    sessions,
    onOpenSession: (sessionId) => setWorkspaceView(tab.id, { kind: 'session', sessionId }),
    onOpenFile: (file: OfficeFile) => bubble.openFile(file),
    onOpenPage: (page: WorkspacePageKey) => setWorkspaceView(tab.id, { kind: 'page', page }),
    onNewWork: () => setWorkspaceView(tab.id, { kind: 'draft' }),
    onToast: workbenchToast,
  }

  const view = tab.view
  const session = view.kind === 'session'
    ? sessions.find((item) => item.id === view.sessionId) ?? null
    : null
  const chatTitle = view.kind === 'draft'
    ? '新工作'
    : view.kind === 'session'
      ? sessionDisplayTitle(session)
      : ''
  const renderPage = () => {
    if (view.kind !== 'page') return null
    switch (view.page) {
      case 'overview': return <OverviewPage {...pageProps} />
      case 'library': return <LibraryPage {...pageProps} />
      case 'outputs': return <OutputsPage {...pageProps} />
      case 'plan': return <PlanPage {...pageProps} />
      default: return null
    }
  }

  return (
    <div className={cn(
      'wb-ws',
      // 最大化覆盖层显示期间隐藏主区（对话区）；退场开始就摘掉，
      // 让对话区随覆盖层淡出逐渐显现。仅会话/草稿视图有对话区可覆盖，
      // 功能页（资料库/产物/计划）下面同样被盖住，行为一致。
      bubble.bubble.maximized && bubble.visible && !bubble.exitKind && 'has-max-bubble',
    )}>
      <div className="wb-ws-main">
        {view.kind === 'page' ? renderPage() : null}
        {/* 对话区：右上角一个图标入口，点开右侧「资料与文件」面板（无文字，保持极简）。 */}
        {active && (view.kind === 'session' || view.kind === 'draft') ? (
          <div className="wb-chat">
            <header className="wb-chat-head">
              <span className="wb-chat-head-title" title={chatTitle}>{chatTitle}</span>
              <div className="wb-chat-head-actions">
                {/* 面板打开时它自己有浏览/收起/关闭按钮；这里保留同一个按钮的位置（仅隐藏），
                    避免收起/展开最后一步因「按钮出现/消失」把标题挤动一下。 */}
                <span className={bubble.visible ? 'wb-chat-files-slot is-hidden' : 'wb-chat-files-slot'}>
                  <Hint label="资料与文件（⌘J）">
                    <IconButton
                      label="资料与文件"
                      size="sm"
                      icon={<FolderOpen size={15} />}
                      aria-expanded={bubble.visible}
                      aria-hidden={bubble.visible}
                      tabIndex={bubble.visible ? -1 : 0}
                      onClick={() => bubble.openBrowser()}
                    />
                  </Hint>
                </span>
              </div>
            </header>
            {/* 待发送批注徽章由 ConversationPane 渲染（紧贴输入框上方的浮层行）。 */}
            {view.kind === 'session' ? (
              <ConversationPane
                key={`session:${view.sessionId}`}
                tabId={tab.id}
                workspaceId={tab.workspaceId}
                sessionId={view.sessionId}
              />
            ) : (
              <ConversationPane
                key={`draft:${tab.id}`}
                tabId={tab.id}
                workspaceId={tab.workspaceId}
                sessionId={null}
              />
            )}
          </div>
        ) : null}
        {!active && (view.kind === 'session' || view.kind === 'draft') ? (
          <div className="wb-ws-inactive-hint">
            {view.kind === 'draft' ? '新工作草稿' : '工作会话'}
          </div>
        ) : null}
      </div>

      {pendingSetupWorkspaceId === workspace.id ? (
        <SetupWizard workspace={workspace as AgentWorkspace} onDone={finishWorkspaceSetup} />
      ) : null}

      {bubble.visible ? (
        <BubbleWindow
          exiting={bubble.exitKind}
          bubble={bubble.exitKind ? { ...bubble.bubble, mode: 'open' } : bubble.bubble}
          onResize={bubble.setWidth}
          onMinimize={bubble.minimize}
          onToggleMax={bubble.toggleMaximize}
          onClose={bubble.close}
          onActivateFile={bubble.activateFile}
          onCloseFile={(fileId) => { void bubble.closeFile(fileId) }}
          onBrowse={bubble.openBrowser}
          onOpenFile={bubble.openFile}
          onToast={workbenchToast}
          workspaceId={workspace.id}
        />
      ) : null}
    </div>
  )
}
