// 编辑器停靠栏的 Agent 聊天面板：移植自 EverRoom 的 AgentPanel/AgentChatView
// 全套交互框架（多会话切换 / 工具时间线 / 流式回答 / 写入审阅 / 排队发送 /
// 模型档位 / 权限模式 / @提及），数据源是主窗口 preload 暴露的真实网关桥
// （window.nxcore.agent → 主进程 IPC → AgentGatewayBridge → gateway）。
import React, { useEffect, useMemo, useRef, useState } from 'react'

import { LocaleProvider } from '@/i18n/LocaleContext'
import { RoomDocumentsProvider } from '@/components/context-room/RoomDocumentsProvider'
import { desktopOperationBridge, DocumentOperationProvider } from '@/components/context-room/operations'
import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { useAgentSession } from '@/components/agent/useAgentSession'
import { onToast as onAppToast } from '@/state/toast'
import '@/components/agent/AgentChat.css'
import '@/components/agent/AgentPanel.css'

import { type OfficeFile, starterPrompts } from './data'

export function AgentChatDock({ file, onToast }: { file: OfficeFile; onToast: (msg: string) => void }) {
  const operationBridge = useMemo(() => desktopOperationBridge(), [])

  // EverRoom 组件的 toast 事件桥到外壳 op-toast
  useEffect(() => onAppToast((detail) => {
    onToast(detail.message ? `${detail.title}：${detail.message}` : detail.title)
  }), [onToast])

  return (
    <LocaleProvider>
      <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={() => {}}>
        <RoomDocumentsProvider>
          <AgentChatDockInner file={file} />
        </RoomDocumentsProvider>
      </DocumentOperationProvider>
    </LocaleProvider>
  )
}

function AgentChatDockInner({ file }: { file: OfficeFile }) {
  const [draft, setDraft] = useState('')
  const [composerResetKey, setComposerResetKey] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // 会话按文件稳定 id 隔离（不能用文件名：改名/同名/超长会把历史落进另一个分区，
  // 离开标签再回来就「找不到对话记录」）；文件名只作为运行上下文的「当前页面」。
  const session = useAgentSession(file.name, null, [], { sessionKey: file.id })
  const prompts = starterPrompts[file.kind]

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setComposerResetKey((key) => key + 1)
    void session.sendPrompt(text)
  }

  const composer = (
    <AgentComposer
      ref={composerRef}
      contextSummary=""
      contextItems={[]}
      hasSelectedText={false}
      resetKey={composerResetKey}
      selectedExternalConversation={null}
      localAgents={[]}
      rooms={[]}
      modelPreference={session.currentSession?.modelPreference ?? session.modelPreferenceDefault}
      modelPreferenceLocked={Boolean(session.sessionId)}
      loadModelAvailability={async () => ({ lite: true, primary: true })}
      onSelectModelPreference={session.setModelPreferenceDefault}
      channelAgentId={null}
      permissionMode={session.permissionMode}
      permissionModeAvailable={session.permissionModeAvailable}
      onSelectPermissionMode={session.setSessionPermissionMode}
      thinkingLevel={session.sessionId ? session.currentSession?.thinkingLevel ?? null : session.thinkingLevelDefault}
      onSelectThinkingLevel={session.setSessionThinkingLevel}
      ghostSuggestion={null}
      queuedSubmissions={session.queuedSubmissions}
      onRemoveQueuedSubmission={session.removeQueuedSubmission}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading}
      available
      onChange={setDraft}
      onSelectExternalConversation={() => {}}
      onClearContext={() => {}}
      onRemoveContext={() => {}}
      onStop={() => void session.stop()}
      onSubmit={() => submit()}
    />
  )

  return (
    <aside className="agent-panel">
      <AgentToolbar>
        <AgentSessionSwitcher
          activeRunId={session.activeRunId}
          connected={session.connected}
          displayTitle={session.displayTitle}
          sessionId={session.sessionId}
          sessions={session.sessions}
          onCreate={async () => {
            setDraft('')
            setComposerResetKey((key) => key + 1)
            return session.startNewConversation()
          }}
          onDelete={async (target) => { await session.deleteSession(target) }}
          onRename={async (sessionId, title) => { await session.renameSession(sessionId, title) }}
          onSelect={async (target) => { await session.selectSession(target) }}
        />
      </AgentToolbar>
      <AgentChatView
        activeDocument={null}
        activeRunId={session.activeRunId}
        agentIdByRun={session.agentIdByRun}
        agentNamesById={{}}
        activityByRun={session.activityByRun}
        availableRooms={[]}
        composer={composer}
        currentSessionId={session.sessionId}
        scopeReady={session.scopeReady}
        starterPrompts={session.sessionId === null ? prompts : null}
        draftHasContent={Boolean(draft.trim())}
        error={session.error}
        loading={session.loading}
        messages={session.messages}
        pendingApprovals={session.pendingApprovals}
        onRejectDocumentIntent={() => composerRef.current?.focus()}
        onRetryPrompt={(prompt, runId) => void session.sendPrompt(prompt, undefined, undefined, null, runId)}
        onOpenSessionLink={() => {}}
        onResolveApproval={(approvalId, decision, feedback) => void session.resolveApproval(approvalId, decision, feedback)}
        onSelectDocument={() => {}}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          composerRef.current?.focus()
        }}
        onSelectRoom={async () => {}}
        pendingNavigationByRun={{}}
        reasoningByRun={session.reasoningByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        resolvingApprovalIds={session.resolvingApprovalIds}
        sessionLinks={[]}
        submitting={false}
        toolCallsByRun={session.toolCallsByRun}
      />
    </aside>
  )
}
