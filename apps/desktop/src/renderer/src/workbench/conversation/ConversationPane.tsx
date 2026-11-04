import { LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentAttachmentReference, AgentMountedDirectory, AgentNoteCard } from '@nxcore/agent-contract'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { buildAskBatch, type PendingAskDraft } from '@/components/agent/askDrafts'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { useAgentSession } from '@/components/agent/useAgentSession'
import { RoomDocumentsProvider } from '@/components/context-room/RoomDocumentsProvider'
import { desktopOperationBridge, DocumentOperationProvider } from '@/components/context-room/operations'
import { onToast as onAppToast } from '@/state/toast'
import '@/components/agent/AgentChat.css'
import '@/components/agent/AgentPanel.css'

import { useWorkbenchStore } from '../state/store'
import { workbenchToast } from '../shell/toast'
import { ConversationEmpty } from './ConversationEmpty'
import { NoteQueueChip } from './NoteQueueChip'
import './conversation.css'

/** 连接失败的「正在连接」提示延迟出现，避免 ready 帧到达前的闪烁。 */
const CONNECTING_HINT_DELAY_MS = 1500

/** 批注草稿 → 气泡卡片结构（原文摘录 + 注释原话；来源文件可辨时带标题）。 */
function buildNoteCards(drafts: readonly PendingAskDraft[]): AgentNoteCard[] {
  return drafts.map((draft) => ({
    excerpt: (draft.excerpt ?? '').replace(/\s+/g, ' ').trim(),
    note: (draft.instruction ?? draft.displayMessage ?? draft.message).trim(),
    ...(draft.title?.trim() ? { title: draft.title.trim() } : {}),
  }))
}

export interface ConversationPaneProps {
  /** 所属工作空间标签 id：草稿落成会话时把标签视图切到该会话。 */
  tabId: string
  workspaceId: string | null
  sessionId: string | null
}

/**
 * 主区对话：WorkBuddy 式大对话区。
 *
 * 装配与 office-proto/AgentChatDock 保持一致（DocumentOperationProvider +
 * RoomDocumentsProvider + useAgentSession + AgentChatView/AgentComposer），
 * 差异只在布局（占满主区、内容 820px 居中）和会话来源（工作台 store 驱动）。
 *
 * 会话切换语义（重要）：切换只 unsubscribe 事件流，绝不 cancelRun——网关侧 run
 * 独立于渲染层继续跑，回到会话时由快照 + 事件全量恢复。
 */
export function ConversationPane({ tabId, workspaceId, sessionId }: ConversationPaneProps) {
  const operationBridge = useMemo(() => desktopOperationBridge(), [])
  /**
   * 会话内核的重挂载计数：当前会话还有 run 在跑时，useAgentSession.startNewConversation
   * 会拒绝进入草稿态（它只能停在自己那个会话上）。这里重挂载 inner 拿一个干净的内核，
   * 旧会话的 run 在网关侧继续跑（不做 cancelRun）。
   */
  const [paneEpoch, setPaneEpoch] = useState(0)
  const restartConversationKernel = useCallback(() => setPaneEpoch((epoch) => epoch + 1), [])

  // Agent 组件内部用 showToast（@/state/toast）报错/提示，桥接到工作台 toast。
  useEffect(() => onAppToast((detail) => {
    workbenchToast(detail.message ? `${detail.title}：${detail.message}` : detail.title)
  }), [])

  return (
    <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={() => undefined}>
      <RoomDocumentsProvider>
        <ConversationPaneInner
          key={paneEpoch}
          tabId={tabId}
          workspaceId={workspaceId}
          sessionId={sessionId}
          onRestartConversationKernel={restartConversationKernel}
        />
      </RoomDocumentsProvider>
    </DocumentOperationProvider>
  )
}

function ConversationPaneInner({ tabId, workspaceId, sessionId, onRestartConversationKernel }: ConversationPaneProps & {
  onRestartConversationKernel: () => void
}) {
  const hook = useAgentSession('Agent', null, [], { workspaceId, initialSessionId: sessionId })
  const syncTabSession = useWorkbenchStore((state) => state.syncTabSession)

  const pendingAgentAsk = useWorkbenchStore((state) => state.pendingAgentAsk)
  const askDrafts = useWorkbenchStore((state) => state.askDrafts)
  const clearAskDrafts = useWorkbenchStore((state) => state.clearAskDrafts)
  const askQueueSendNonce = useWorkbenchStore((state) => state.askQueueSendNonce)

  const [draft, setDraft] = useState('')
  const [composerResetKey, setComposerResetKey] = useState(0)
  const [connectingVisible, setConnectingVisible] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  /** 最新 hook：effect 里按 sessionId 调用切换方法时避免闭包拿到旧函数。 */
  const hookRef = useRef(hook)
  hookRef.current = hook
  /** 已经向 hook 请求过的会话 id（初始值来自 props，首次挂载由 initialSessionId 处理）。 */
  const requestedSessionRef = useRef<string | null>(sessionId)

  const bridgeAvailable = Boolean(window.nxcore?.agent)
  const canSend = bridgeAvailable && Boolean(workspaceId)
  const hasMessages = hook.messages.length > 0
  const loadingView = !hook.scopeReady || (hook.loading && hook.messages.length === 0)
  /**
   * 会话态判定与 AgentChatView 的 hasConversation 对齐：运行中的 run / 审批 / 错误也算
   * 「有内容」。草稿态（sessionId 为 null）始终留在 hero，失败信息用顶部错误条展示。
   */
  const conversationState = !loadingView && (
    hasMessages
    || Boolean(hook.activeRunId)
    || hook.pendingApprovals.length > 0
    || hook.sessionLinks.length > 0
    || Boolean(hook.sessionId && hook.error)
  )

  // props.sessionId 变化 → 切会话/进草稿态。首次挂载不重复请求（initialSessionId 已生效）。
  useEffect(() => {
    if (requestedSessionRef.current === sessionId) return
    requestedSessionRef.current = sessionId
    setDraft('')
    setComposerResetKey((key) => key + 1)
    if (sessionId === null) {
      // 当前会话还有 run 在跑：startNewConversation 会拒绝（不能取消别人的 run）。
      // 重挂载会话内核进入草稿态，旧 run 交给网关继续，回到旧会话时由快照恢复。
      if (hookRef.current.activeRunId) {
        workbenchToast('已新建对话，原会话任务会在后台继续运行')
        onRestartConversationKernel()
        return
      }
      void hookRef.current.startNewConversation().catch((error: unknown) => {
        workbenchToast(error instanceof Error ? error.message : '新建对话失败')
      })
      return
    }
    void hookRef.current.selectSessionById(sessionId).catch((error: unknown) => {
      workbenchToast(error instanceof Error ? error.message : '切换会话失败')
    })
  }, [onRestartConversationKernel, sessionId])

  /**
   * Office「AI 修改」浮层的待注入消息（Word 选区浮层等）：本面板是这个工作空间的
   * 对话出口，挂载/激活后消费一次——技术指令进 runtime，人话进气泡（displayPrompt）。
   * 忙或未就绪时退化为填进输入框，绝不静默丢掉用户敲的东西。
   */
  useEffect(() => {
    if (!pendingAgentAsk || pendingAgentAsk.workspaceId !== workspaceId) return
    // 会话内核还没就绪：等它就绪再注入，别把消息降级成「Agent 正忙」。
    if (!hook.scopeReady || hook.loading) return
    const pending = pendingAgentAsk
    // 消费即置空，避免重挂载/重渲染重复发送。
    useWorkbenchStore.getState().setPendingAgentAsk(null)
    const fallback = () => setDraft(pending.displayMessage ?? pending.message)
    /** 有在跑的 run 时 sendPrompt 会排队并返回 null——排队也算投递成功，不能再回填输入框。 */
    const queuesBehindRun = Boolean(hookRef.current.activeRunId)
    void hookRef.current
      .sendPrompt(
        pending.message,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // displayPrompt：气泡/标题只显示人话，块索引与工具名只进 runtime。
        pending.displayMessage,
      )
      .then((runId) => {
        if (runId !== null || queuesBehindRun) return
        fallback()
        workbenchToast('Agent 正忙，批注已放进输入框')
      })
      .catch(fallback)
  }, [pendingAgentAsk, workspaceId, hook.scopeReady, hook.loading])

  // 会话快照同步回 store：首次发送自动建会话后，侧栏立刻出现该会话（不必等轮询）。
  // 只把「当前请求的会话」（或草稿态自动创建的会话）写回 store；切会话过程中旧的
  // 快照不能把侧栏选中态抢回去。
  useEffect(() => {
    const session = hook.currentSession
    if (!session) return
    const requested = requestedSessionRef.current
    if (requested !== null && requested !== session.id) return
    syncTabSession(tabId, session)
  }, [hook.currentSession, syncTabSession, tabId])

  // 兜底对账：hook 停在了别的会话（并发切换/重试后重选了旧会话）时，切回 store 请求的会话。
  // 延迟执行，避开 selectSessionById 尚未落定 sessionId 的同一次提交。
  useEffect(() => {
    if (sessionId === null || hook.loading || !hook.scopeReady) return
    if (!hook.sessionId || hook.sessionId === sessionId) return
    const timer = window.setTimeout(() => {
      if (hookRef.current.loading || hookRef.current.sessionId === sessionId) return
      void hookRef.current.selectSessionById(sessionId).catch(() => undefined)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [hook.loading, hook.scopeReady, hook.sessionId, sessionId])

  // 已选中会话但事件流还没 ready：延迟显示「正在连接」，不打断已有消息的阅读。
  useEffect(() => {
    if (!hook.sessionId || hook.connected || hook.error) {
      setConnectingVisible(false)
      return
    }
    const timer = window.setTimeout(() => setConnectingVisible(true), CONNECTING_HINT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hook.connected, hook.error, hook.sessionId])

  /** 本工作空间的批注草稿（其它空间的留在各自对话里）。 */
  const workspaceAskDrafts = askDrafts.filter((draft) => draft.workspaceId === workspaceId)

  /**
   * 待发送批注徽章：挂在输入框（composer / hero 输入框）正上方一行。空队列时
   * NoteQueueChip 自身返回 null，不占任何空间。
   */
  const noteQueueChip = (
    <NoteQueueChip workspaceId={workspaceId} drafts={workspaceAskDrafts} />
  )

  /**
   * 发送一轮：输入框里的文件附件（文件引擎引用）与挂载目录一起进本轮运行上下文。
   * sendPrompt 的入参是长参数位，这里按位补齐并在末尾追加 mountedDirectories。
   *
   * 批注队列自动附带：有未发批注时合并进**本次**发送（prompt 尾部拼 batch.message，
   * displayPrompt 拼人话）——sendPrompt 在 loading/sending 时直接丢弃（返回 null，
   * 不排队），连发两次第二条必丢，所以必须单次合并。投递成功（含排队）才清空队列。
   */
  const send = (attachments: AgentAttachmentReference[] = [], mountedDirectories: AgentMountedDirectory[] = []) => {
    const text = draft.trim()
    // 只有批注也能发：批注等价于一条消息（输入框空 ≠ 没东西可发）。
    if ((!text && attachments.length === 0 && workspaceAskDrafts.length === 0) || !canSend || hook.loading) return
    // 合并路径总有用户文本（text 为空时只有附件能触发发送，批注跟着下一轮文本走）。
    const batch = workspaceAskDrafts.length > 0 ? buildAskBatch(workspaceAskDrafts) : null
    const prompt = batch ? (text ? `${text}\n\n${batch.message}` : batch.message) : text
    const displayPrompt = batch ? (text ? `${text}\n\n${batch.displayMessage}` : batch.displayMessage) : undefined
    // 批注卡片：有批注就带（气泡正文与卡片分离渲染）；displayContent＝输入框正文，
    // 空串＝纯批注发送（无气泡，只有卡片）。
    const noteCards = batch ? buildNoteCards(workspaceAskDrafts) : undefined
    setDraft('')
    setComposerResetKey((key) => key + 1)
    /** 有在跑的 run 时 sendPrompt 会排队并返回 null——排队也算投递成功，不清回输入框。 */
    const queuesBehindRun = Boolean(hookRef.current.activeRunId)
    // 首条消息在草稿态发出时由 hook 自动建会话（归属当前 workspaceId）。
    void hook.sendPrompt(
      prompt,
      undefined,
      undefined,
      undefined,
      undefined,
      attachments.length ? attachments : undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      displayPrompt,
      mountedDirectories.length ? mountedDirectories : undefined,
      noteCards,
      text,
    ).then((runId) => {
      // 批注已随本轮发出（或已排队）：清掉队列；失败时留在队列里下次再带。
      if (batch && workspaceId && (runId !== null || queuesBehindRun)) {
        clearAskDrafts(workspaceId)
      }
    }).catch(() => {
      // 发送失败：内容还回输入框；用户已重新输入则不覆盖。
      setDraft((current) => (current ? current : text))
    })
  }

  /**
   * 一次发出所有批注：合成一条消息（技术指令带编号，人话用圈号），投递成功才清空。
   * 排队（有 run 在跑）也算投递成功；真正失败时草稿留着，用户可以再发一次。
   * 气泡带批注卡片（原文摘录 + 注释，hover 只读展开），不显示合成文本。
   */
  const sendAskDrafts = () => {
    const batch = buildAskBatch(workspaceAskDrafts)
    if (!batch || !workspaceId || !canSend || hook.loading) return
    void hook
      .sendPrompt(
        batch.message,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        batch.displayMessage,
        undefined,
        buildNoteCards(workspaceAskDrafts),
        '',
      )
      .then((runId) => {
        if (runId === null && !hookRef.current.activeRunId) {
          workbenchToast('Agent 正忙，批注先留着，稍后再发')
          return
        }
        clearAskDrafts(workspaceId)
      })
      .catch(() => workbenchToast('发送失败，批注已保留'))
  }

  /**
   * 文档内批注面板点了「全部发送」：主进程把动作转成 nonce，这里消费一次。
   * 用 ref 记住已处理的 nonce，避免重挂载后重复发送。
   */
  const handledSendNonce = useRef(0)
  useEffect(() => {
    if (askQueueSendNonce === 0 || askQueueSendNonce === handledSendNonce.current) return
    handledSendNonce.current = askQueueSendNonce
    if (workspaceAskDrafts.length === 0 || !hook.scopeReady || hook.loading) return
    sendAskDrafts()
  }, [askQueueSendNonce, workspaceAskDrafts.length, hook.scopeReady, hook.loading])

  /**
   * 会话态输入框：AgentChatView 在消息列表底部渲染 {composer}（normal flow）。
   * 徽章与 AgentComposer 平级放同一个 fragment——**不要**包一层 wrapper div：
   * AgentComposer 的 ResizeObserver 把 --agent-composer-height 写在
   * shell.parentElement 上（frame 级消费者都依赖它），多包一层就会写到 wrapper
   * 上、frame 拿不到。徽章自身 absolute 吸在输入框上方（见 .wb-note-chip）。
   */
  const composer = (
    <>
      {noteQueueChip}
      <AgentComposer
        ref={composerRef}
        contextSummary=""
        contextItems={[]}
        hasSelectedText={false}
        /** 只有批注也允许发送：批注等价于一条消息，空输入不再是空提交。 */
        hasSubmittableContext={workspaceAskDrafts.length > 0}
        resetKey={composerResetKey}
        selectedExternalConversation={null}
        localAgents={[]}
        rooms={[]}
        modelPreference={hook.currentSession?.modelPreference ?? hook.modelPreferenceDefault}
        modelPreferenceLocked={Boolean(hook.sessionId)}
        loadModelAvailability={async () => ({ lite: true, primary: true })}
        onSelectModelPreference={hook.setModelPreferenceDefault}
        channelAgentId={null}
        permissionMode={hook.permissionMode}
        permissionModeAvailable={hook.permissionModeAvailable}
        onSelectPermissionMode={hook.setSessionPermissionMode}
        thinkingLevel={hook.sessionId ? hook.currentSession?.thinkingLevel ?? null : hook.thinkingLevelDefault}
        onSelectThinkingLevel={hook.setSessionThinkingLevel}
        contextUsage={hook.contextUsage}
        contextCompacting={hook.contextCompacting}
        ghostSuggestion={null}
        queuedSubmissions={hook.queuedSubmissions}
        onRemoveQueuedSubmission={hook.removeQueuedSubmission}
        value={draft}
        active={Boolean(hook.activeRunId)}
        loading={hook.loading}
        available={canSend}
        onChange={setDraft}
        onSelectExternalConversation={() => undefined}
        onClearContext={() => undefined}
        onRemoveContext={() => undefined}
        onStop={() => void hook.stop()}
        onSubmit={(payload) => send(payload.attachments, payload.mountedDirectories)}
      />
    </>
  )

  const standaloneError = hook.error && !conversationState ? hook.error : null

  return (
    <div
      className="wb-conversation"
      data-state={loadingView ? 'loading' : conversationState ? 'active' : 'empty'}
      data-has-note-queue={workspaceAskDrafts.length > 0 ? 'true' : undefined}
    >
      {!bridgeAvailable || !workspaceId ? (
        <div className="wb-conversation-notice" role="status">
          {bridgeAvailable ? '工作区未就绪，暂时无法发送消息。' : '桌面端 Agent 服务未就绪，暂时无法发送消息。'}
        </div>
      ) : null}

      {standaloneError ? (
        <div className="wb-conversation-error" role="alert">
          <span>{standaloneError}</span>
          <button type="button" className="wb-conversation-retry" onClick={() => hook.reload()}>
            <RefreshCw size={13} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}

      {loadingView ? (
        <div className="wb-conversation-loading" role="status" aria-live="polite">
          <div className="wb-conversation-skeleton" aria-hidden="true">
            <div className="wb-skeleton-row"><span className="wb-skeleton-line" /><span className="wb-skeleton-line" /></div>
            <div className="wb-skeleton-row is-user"><span className="wb-skeleton-line" /></div>
            <div className="wb-skeleton-row"><span className="wb-skeleton-line" /><span className="wb-skeleton-line short" /></div>
          </div>
          <p>
            <LoaderCircle className="wb-spin" size={13} aria-hidden="true" />
            正在连接对话…
          </p>
        </div>
      ) : conversationState ? (
        <>
          {connectingVisible && hook.sessionId && !hook.loading ? (
            <div className="wb-conversation-status" role="status">
              <LoaderCircle className="wb-spin" size={13} aria-hidden="true" />
              <span>正在连接会话…</span>
              <button type="button" className="wb-conversation-status-retry" onClick={() => hook.reload()}>
                重试
              </button>
            </div>
          ) : null}
          <AgentChatView
            activeDocument={null}
            activeRunId={hook.activeRunId}
            agentIdByRun={hook.agentIdByRun}
            agentNamesById={{}}
            activityByRun={hook.activityByRun}
            availableRooms={[]}
            cancelledRunIds={hook.cancelledRunIds}
            composer={composer}
            currentSessionId={hook.sessionId}
            draftHasContent={Boolean(draft.trim()) || workspaceAskDrafts.length > 0}
            error={hook.error}
            interruptedRunIds={hook.interruptedRunIds}
            loading={hook.loading}
            messages={hook.messages}
            onOpenMention={(item) => {
              workbenchToast(`${item.kind === 'file' ? '文件' : item.kind === 'room' ? '房间' : '对话'}：${item.displayName}`)
            }}
            onOpenSessionLink={() => workbenchToast('会话引用跳转暂未接入工作台')}
            onRejectDocumentIntent={() => composerRef.current?.focus()}
            onResolveApproval={(approvalId, decision, feedback) => void hook.resolveApproval(approvalId, decision, feedback)}
            onRetryError={() => hook.reload()}
            onRetryPrompt={(prompt, runId) => void hook.sendPrompt(prompt, undefined, undefined, null, runId)}
            onSelectDocument={() => workbenchToast('文档选择暂未接入工作台产物面板')}
            onSelectPrompt={(prompt) => {
              setDraft(prompt)
              composerRef.current?.focus()
            }}
            onSelectRoom={async () => {
              workbenchToast('房间选择暂未接入工作台')
            }}
            pendingApprovals={hook.pendingApprovals}
            pendingNavigationByRun={{}}
            reasoningByRun={hook.reasoningByRun}
            resolvingApprovalIds={hook.resolvingApprovalIds}
            runCompletedAtByRun={hook.runCompletedAtByRun}
            runStartedAtByRun={hook.runStartedAtByRun}
            scopeReady={hook.scopeReady}
            sessionLinks={hook.sessionLinks}
            starterPrompts={null}
            submitting={hook.loading}
            toolCallsByRun={hook.toolCallsByRun}
          />
        </>
      ) : (
        <ConversationEmpty
          draft={draft}
          disabled={!canSend || hook.loading}
          onDraftChange={setDraft}
          onSubmit={send}
          aboveInput={noteQueueChip}
          hasPendingNotes={workspaceAskDrafts.length > 0}
        />
      )}
    </div>
  )
}