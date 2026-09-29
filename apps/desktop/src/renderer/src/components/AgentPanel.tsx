import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentModelPreference, AgentNavigationTarget, AgentRoomReference, AgentSessionLink, PendingAgentIntent, ExternalConversationSummary } from '@nxcore/agent-contract'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
import { WritingStyleInsightBanner } from '@/components/agent/WritingStyleInsightBanner'
import {
  agentSessionLinkDestination,
  navigationKey,
  navigationRequiresSessionHandoff,
  parseAgentNavigationTarget,
  replayNavigationMode,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { useAgentSession } from '@/components/agent/useAgentSession'
import { LocalAgentAdapterWizard } from '@/components/agent/LocalAgentAdapterWizard'
import type { MentionedAgent, MentionedItem } from '@/components/agent/agentMentions'
import type { LocalAgentAdapterCheck } from '../../../shared/sources'
import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import type { LocalAgentInstallation } from '../../../shared/local-agents'
import {
  buildRoomOverviewCitationContext,
  buildRoomOverviewCitationPrompt,
  type RoomOverviewCitation,
} from '@/components/context-room/roomOverviewCitation'
import {
  isRoomOverviewProjectionToolName,
  publishRoomOverviewChanged,
} from '@/components/context-room/roomOverviewChange'
import { recordRoomOverviewDiagnostic } from '@/components/context-room/roomOverviewDiagnostics'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import {
  loadConversationSuggestionSettings,
  onConversationSuggestionSettingsChanged,
  type ConversationSuggestionSettings,
} from '@/state/conversationSuggestionSettings'
import type { PageId } from '@/data/navigation'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { useActiveDocument } from '@/state/ActiveDocumentContext'
import {
  buildAgentDocumentSelectionRunRequest,
  type AgentDocumentSelectionItem,
  type AgentDocumentSelectionSubmission,
} from '@/components/agent/agentDocumentSelection'

import './agent/AgentPanel.css'
import './agent/AgentChat.css'

export function AgentPanel({
  pageId,
  pageLabel,
  roomId,
  rooms,
  roomBackendReady,
  navigationRequest,
  sessionRouteRequest,
  askRequest,
  onNavigate,
  onNavigatePage,
  onRestoreRoomTab,
  onNavigationConsumed,
  onOpenSessionLink,
  onOpenDocument,
  onSessionRouteConsumed,
  onAskConsumed,
  onOpenMentionFile,
  focusRequest = 0,
  roomCitations,
  onRemoveRoomCitation,
  onClearRoomCitations,
}: {
  pageId: PageId
  pageLabel: string
  roomId: string | null
  rooms: ContextRoomWorkspaceTab[]
  roomBackendReady: boolean
  navigationRequest: AgentNavigationRequest | null
  sessionRouteRequest: AgentSessionRouteRequest | null
  askRequest: { key: string; roomId: string; message: string } | null
  onNavigate: (request: AgentNavigationRequest) => void
  /** 应用级页面跳转（与 Sidebar 同源）；用于「去设置」类提示动作。 */
  onNavigatePage?: (page: PageId) => void
  onRestoreRoomTab: (target: AgentNavigationRequest['target']) => void
  onNavigationConsumed: (key: string) => void
  onOpenSessionLink: (link: AgentSessionLink, destination: 'source' | 'target') => void
  onOpenDocument: (target: { roomId: string; documentId: string; blockId?: string | null }) => void
  onSessionRouteConsumed: (key: string) => void
  onAskConsumed: (key: string) => void
  onOpenMentionFile?: (fileId: string) => void
  focusRequest?: number
  roomCitations: RoomOverviewCitation[]
  onRemoveRoomCitation: (citationId: string) => void
  onClearRoomCitations: () => void
}) {
  const { t, locale } = useLocale()
  const [draft, setDraft] = useState('')
  const { refreshFromBackend } = useContextRoomState()
  const [submitting, setSubmitting] = useState(false)
  const [pendingNavigationByRun, setPendingNavigationByRun] = useState<Record<string, AgentNavigationTarget>>({})
  const [composerResetKey, setComposerResetKey] = useState(0)
  const [localAgents, setLocalAgents] = useState<LocalAgentInstallation[]>([])
  const [selectedExternalConversation, setSelectedExternalConversation] = useState<ExternalConversationSummary | null>(null)
  const [notificationRunTarget, setNotificationRunTarget] = useState<{ key: string; runId: string } | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const previousSessionIdRef = useRef<string | null>(null)
  const handledNavigationKeysRef = useRef(new Set<string>())
  const handledRequestKeysRef = useRef(new Set<string>())
  const handledSessionRouteKeysRef = useRef(new Set<string>())
  const handledAskKeysRef = useRef(new Set<string>())
  const handledOverviewToolIdsRef = useRef(new Set<string>())
  const citationSectionLabel = (citation: RoomOverviewCitation) => t(citation.section === 'overview'
      ? 'contextRoom:overviewDashboard.roomOverview'
      : citation.section === 'status'
        ? 'contextRoom:overviewDashboard.currentStatus'
        : citation.section === 'next_steps'
          ? 'contextRoom:overviewDashboard.suggestedNextSteps'
          : citation.section === 'entities'
            ? 'contextRoom:overviewDashboard.relatedMemoryEntities'
            : 'contextRoom:overviewDashboard.roomTimeline')
  const citationItems = roomCitations.map((citation) => {
    const summary = citation.text.replace(/\s+/g, ' ').trim()
    return {
      id: citation.id,
      label: `${citationSectionLabel(citation)} · “${summary}”`,
      detail: citation.comment ? `${summary}\n${t('surface:agentComposer.referenceComment')}${locale === 'zh-CN' ? '：' : ': '}${citation.comment}` : summary,
    }
  })
  // 仅在有引用时展示（composer 侧空态不渲染文案）。
  const contextSummary = roomCitations.length
    ? `${roomCitations[0]?.roomTitle ?? pageLabel} · ${t('surface:agentComposer.countReferences', { count: roomCitations.length })}`
    : ''
  const currentRoomTitle = roomId
    ? rooms.find((room) => room.id === roomId)?.title ?? t('contextRoom:creation.emptyRoomTitle')
    : undefined
  const citationPrompt = buildRoomOverviewCitationPrompt(roomCitations, locale)
  const session = useAgentSession(pageLabel, roomId, rooms)
  const agentAvailable = Boolean(window.nxcore?.agent)

  const [conversationSuggestionSettings, setConversationSuggestionSettings] =
    useState<ConversationSuggestionSettings>(loadConversationSuggestionSettings)
  const [composerSuggestion, setComposerSuggestion] = useState<{ key: string; text: string } | null>(null)
  const [starterPrompts, setStarterPrompts] = useState<string[] | null>(null)
  // 同一对话快照只在定时器真正触发时标记（清理掉的调度下次 effect 重排，StrictMode/依赖抖动不再永久丢失）；Esc 丢弃按快照 key 记忆；命中缓存立即回显（5 分钟 TTL），切对话往返不重复生成。
  const ghostContextKeyRef = useRef<string | null>(null)
  const ghostDismissedKeysRef = useRef<Set<string>>(new Set())
  const ghostCacheRef = useRef<Map<string, { text: string; at: number }>>(new Map())
  const starterPromptsCacheRef = useRef<{ key: string; prompts: string[]; at: number } | null>(null)
  useEffect(() => onConversationSuggestionSettingsChanged(setConversationSuggestionSettings), [])

  const lastMessage = session.messages.length ? session.messages[session.messages.length - 1] : null
  const ghostContextKey = `${session.sessionId ?? 'draft'}:${session.messages.length}:${lastMessage?.id ?? ''}`
  const ghostSuggestion = composerSuggestion?.key === ghostContextKey ? composerSuggestion.text : null

  useEffect(() => {
    const api = window.nxcore?.agent
    if (!api?.suggestConversationPrompt || !conversationSuggestionSettings.completionEnabled) {
      setComposerSuggestion(null)
      return
    }
    if (session.activeRunId) {
      setComposerSuggestion(null)
      return
    }
    const recentMessages = session.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-8)
      .map((message) => ({ role: message.role as 'user' | 'assistant', text: message.content.slice(0, 4000) }))
    // 空会话（新对话）走开场问题变体：等会话清单就绪后再取。
    if (recentMessages.length === 0 && !session.scopeReady) return
    if (ghostDismissedKeysRef.current.has(ghostContextKey)) return
    const cached = ghostCacheRef.current.get(ghostContextKey)
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      setComposerSuggestion({ key: ghostContextKey, text: cached.text })
      return
    }
    if (ghostContextKeyRef.current === ghostContextKey) return
    const timer = window.setTimeout(() => {
      ghostContextKeyRef.current = ghostContextKey
      const recentSessions = [...session.sessions]
        .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
        .slice(0, 8)
        .map((item) => ({ title: item.title, updatedAt: item.updatedAt }))
      api.suggestConversationPrompt({
        sessionId: session.sessionId,
        pageLabel,
        roomTitle: currentRoomTitle ?? null,
        messages: recentMessages,
        ...(recentMessages.length === 0 ? { recentSessions } : {}),
        language: locale,
      })
        .then(({ suggestion }) => {
          if (!suggestion?.trim()) return
          ghostCacheRef.current.set(ghostContextKey, { text: suggestion, at: Date.now() })
          if (ghostCacheRef.current.size > 100) {
            const oldest = ghostCacheRef.current.keys().next().value
            if (oldest !== undefined) ghostCacheRef.current.delete(oldest)
          }
          setComposerSuggestion({ key: ghostContextKey, text: suggestion })
        })
        .catch(() => undefined)
    }, 400)
    return () => { window.clearTimeout(timer) }
  }, [conversationSuggestionSettings.completionEnabled, session.activeRunId, session.messages, session.sessionId, session.sessions, session.scopeReady, ghostContextKey, pageLabel, currentRoomTitle, locale])

  // 新对话空态：按最近会话标题生成开场推荐（5 分钟 TTL 缓存，失败静默回退静态文案）。
  const newConversationEmpty = session.scopeReady && session.messages.length === 0
  useEffect(() => {
    const api = window.nxcore?.agent
    if (!api?.suggestStarterPrompts || !conversationSuggestionSettings.starterPromptsEnabled || !newConversationEmpty) return
    const recentSessions = [...session.sessions]
      .sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
      .slice(0, 8)
      .map((item) => ({ title: item.title, updatedAt: item.updatedAt }))
    const key = `${pageLabel}|${roomId ?? ''}|${locale}|${currentRoomTitle ?? ''}|${recentSessions.map((item) => item.title ?? '').join('/')}`
    const cached = starterPromptsCacheRef.current
    if (cached && cached.key === key && Date.now() - cached.at < 5 * 60_000) {
      setStarterPrompts(cached.prompts)
      return
    }
    let cancelled = false
    api.suggestStarterPrompts({
      pageLabel,
      roomTitle: currentRoomTitle ?? null,
      recentSessions,
      language: locale,
    })
      .then(({ prompts }) => {
        if (cancelled || !prompts?.length) return
        starterPromptsCacheRef.current = { key, prompts, at: Date.now() }
        setStarterPrompts(prompts)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [conversationSuggestionSettings.starterPromptsEnabled, newConversationEmpty, session.sessions, session.scopeReady, pageLabel, roomId, locale, currentRoomTitle])

  const { activeDocument, prepareActiveDocumentRun } = useActiveDocument()
  const agentNamesById = useMemo(() => Object.fromEntries(
    localAgents.map((agent) => [agent.id, agent.displayName]),
  ), [localAgents])

  const handleNotificationRunLocated = useCallback((key: string) => {
    setNotificationRunTarget((current) => current?.key === key ? null : current)
  }, [])

  const focusComposer = (attention = false) => {
    window.requestAnimationFrame(() => {
      const composer = composerRef.current
      composer?.focus()
      if (!attention || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

      composer?.closest<HTMLElement>('.agent-prompt')?.animate?.(
        [
          { transform: 'scale(1)', boxShadow: '0 2px 12px rgba(15, 23, 42, 0.07)' },
          { transform: 'scale(1.018)', boxShadow: '0 10px 28px rgba(59, 130, 246, 0.18)' },
          { transform: 'scale(1)', boxShadow: '0 2px 12px rgba(15, 23, 42, 0.07)' },
        ],
        { duration: 460, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      )
    })
  }

  useEffect(() => {
    if (!focusRequest) return
    focusComposer(true)
  }, [focusRequest])

  const acceptGhost = useCallback(() => {
    setComposerSuggestion((current) => {
      if (current) setDraft(current.text)
      return null
    })
    focusComposer()
  }, [focusComposer])

  const dismissGhost = useCallback(() => {
    ghostDismissedKeysRef.current.add(ghostContextKey)
    if (ghostDismissedKeysRef.current.size > 50) ghostDismissedKeysRef.current.clear()
    setComposerSuggestion(null)
  }, [ghostContextKey])

  useEffect(() => {
    void window.nxcore?.agent.discoverLocalAgents?.()
      .then(setLocalAgents)
      .catch(() => setLocalAgents([]))
  }, [])

  useEffect(() => {
    setComposerResetKey((current) => current + 1)
  }, [pageLabel])

  useEffect(() => {
    if (previousSessionIdRef.current === session.sessionId) return
    if (previousSessionIdRef.current !== null) {
      setDraft('')
      if (roomCitations.length) onClearRoomCitations()
      setComposerResetKey((current) => current + 1)
    }
    previousSessionIdRef.current = session.sessionId
    setSelectedExternalConversation(null)
    setPendingNavigationByRun({})
  }, [onClearRoomCitations, roomCitations.length, session.sessionId])

  const selectExternalConversation = useCallback((conversation: ExternalConversationSummary | null) => {
    setSelectedExternalConversation(conversation)
  }, [])

  /** 消息区点击 @ 条目跳转：Room 走导航管线开房间标签，文件跳文件页聚焦，本应用会话切回该对话。 */
  const openMention = useCallback((item: MentionedItem) => {
    if (item.kind === 'room') {
      onNavigate({
        key: `mention:room:${item.id}:${Date.now()}`,
        source: {
          sessionId: session.sessionId ?? '',
          pageId,
          pageLabel,
          roomId,
          runId: '',
        },
        target: {
          pageId: 'rooms',
          title: item.displayName,
          action: 'referenced',
          roomId: item.id,
          objectType: 'room',
        },
      })
      return
    }
    if (item.kind === 'file') {
      onOpenMentionFile?.(item.id)
      return
    }
    if (item.kind === 'conversation' && item.provider !== undefined && item.provider !== 'everroom') return
    void session.selectSessionById(item.id).catch(() => {
      showToast({ title: t('surface:agentChat.mentionTargetUnavailable') })
    })
  }, [onNavigate, onOpenMentionFile, pageId, pageLabel, roomId, session, t])


  useEffect(() => {
    if (!session.sessionId || navigationRequest) return
    const tools = Object.values(session.toolCallsByRun).flat()
    const roomIds = new Set(rooms.map((room) => room.id))
    for (const tool of tools) {
      if (tool.status !== 'completed') continue
      const target = parseAgentNavigationTarget(tool.result)
      if (!target) continue
      const key = navigationKey(tool, target)
      if (handledNavigationKeysRef.current.has(key)) continue
      const alreadyLinked = session.sessionLinks.some((link) => (
        link.sourceSessionId === session.sessionId
        && link.sourceRunId === tool.runId
        && link.target.pageId === target.pageId
        && (link.target.roomId ?? null) === (target.roomId ?? null)
        && (link.target.objectId ?? '') === (target.objectId ?? '')
      ))
      if (alreadyLinked) {
        handledNavigationKeysRef.current.add(key)
        continue
      }
      const replayMode = replayNavigationMode({
        toolRunId: tool.runId,
        activeRunId: session.activeRunId,
        target,
        roomIds,
      })
      if (replayMode === 'skip') {
        handledNavigationKeysRef.current.add(key)
        continue
      }
      if (replayMode === 'defer') continue
      if (replayMode === 'restore-tab') {
        handledNavigationKeysRef.current.add(key)
        onRestoreRoomTab(target)
        continue
      }
      handledNavigationKeysRef.current.add(key)
      const request = {
        key,
        source: {
          sessionId: session.sessionId,
          pageId,
          pageLabel,
          roomId,
          runId: tool.runId,
        },
        target,
      }
      if (tool.name === 'context_room_create') {
        void refreshFromBackend()
          .catch(() => null)
          .finally(() => onNavigate(request))
      } else {
        onNavigate(request)
      }
      return
    }
  }, [navigationRequest, onNavigate, onRestoreRoomTab, pageId, pageLabel, refreshFromBackend, roomId, rooms, session.activeRunId, session.sessionId, session.sessionLinks, session.toolCallsByRun])

  useEffect(() => {
    for (const tool of Object.values(session.toolCallsByRun).flat()) {
      const createsProposal = tool.name === 'context_room_correction_propose'
      const projectionToolName = isRoomOverviewProjectionToolName(tool.name) ? tool.name : null
      if (!createsProposal && !projectionToolName) continue
      if (handledOverviewToolIdsRef.current.has(tool.id)) continue
      // 只重放当前活跃 run 的实时结果；会话水合载入的历史工具（重启/换会话
      // 恢复）不再重发——面板需要时会自行拉取最新投影，而陈旧结果的重发会
      // 触发全量快照刷新，重启后首次进 Room 曾因此被弹回首页。语义与上方
      // 导航重放的 live 判定（replayNavigationMode）保持一致。
      if (tool.runId !== session.activeRunId) {
        if (tool.status === 'completed' || tool.status === 'error' || tool.status === 'stopped') {
          handledOverviewToolIdsRef.current.add(tool.id)
          recordRoomOverviewDiagnostic('replay.skipped_historical_tool', {
            roomId,
            toolName: tool.name,
            toolId: tool.id,
            runId: tool.runId,
            status: tool.status,
          })
        }
        continue
      }
      if (tool.status === 'error' || tool.status === 'stopped') {
        handledOverviewToolIdsRef.current.add(tool.id)
        recordRoomOverviewDiagnostic('correction.tool_failed', {
          roomId,
          toolName: tool.name,
          toolId: tool.id,
          runId: tool.runId,
          status: tool.status,
          errorPresent: Boolean(tool.error),
        }, tool.status === 'error' ? 'error' : 'warn')
        continue
      }
      if (tool.status !== 'completed') continue
      handledOverviewToolIdsRef.current.add(tool.id)
      if (createsProposal) {
        recordRoomOverviewDiagnostic('correction.proposal_created', {
          roomId,
          toolId: tool.id,
          runId: tool.runId,
        })
        continue
      }
      if (projectionToolName) publishRoomOverviewChanged(tool.result, roomId, projectionToolName)
    }
  }, [roomId, session.activeRunId, session.toolCallsByRun])

  useEffect(() => {
    if (!navigationRequest || navigationRequest.target.pageId !== pageId) return
    if ((navigationRequest.target.roomId ?? null) !== roomId) return
    if (handledRequestKeysRef.current.has(navigationRequest.key)) return
    if (!navigationRequiresSessionHandoff(navigationRequest)) {
      handledRequestKeysRef.current.add(navigationRequest.key)
      onNavigationConsumed(navigationRequest.key)
      return
    }
    if (!roomBackendReady || !session.scopeReady || session.loading || session.activeRunId || submitting) return
    handledRequestKeysRef.current.add(navigationRequest.key)
    setSubmitting(true)
    void (async () => {
      const reusableSession = session.sessions.length === 1
        && session.currentSession?.id === session.sessionId
        && !session.currentSession.title?.trim()
        && session.messages.length === 0
        && session.sessionLinks.length === 0
      const targetSession = reusableSession ? session.currentSession! : await session.createSession()
      const targetSessionId = targetSession.id
      await session.renameSession(targetSessionId, navigationRequest.target.title.trim().slice(0, 120))
      await session.createSessionLink({
        sourceSessionId: navigationRequest.source.sessionId,
        targetSessionId,
        sourceRunId: navigationRequest.source.runId,
        sourcePageId: navigationRequest.source.pageId,
        sourcePageLabel: navigationRequest.source.pageLabel,
        sourceRoomId: navigationRequest.source.roomId,
        target: navigationRequest.target,
      })
      onNavigationConsumed(navigationRequest.key)
    })()
      .catch(() => {
        onNavigationConsumed(navigationRequest.key)
      })
      .finally(() => setSubmitting(false))
  }, [navigationRequest, onNavigationConsumed, pageId, roomBackendReady, roomId, session, submitting])

  useEffect(() => {
    if (!sessionRouteRequest || sessionRouteRequest.pageId !== pageId) return
    if (sessionRouteRequest.roomId !== roomId || session.loading) return
    if (!session.sessions.some((item) => item.id === sessionRouteRequest.sessionId)) return
    if (handledSessionRouteKeysRef.current.has(sessionRouteRequest.key)) return
    handledSessionRouteKeysRef.current.add(sessionRouteRequest.key)
    setNotificationRunTarget(sessionRouteRequest.runId
      ? { key: sessionRouteRequest.key, runId: sessionRouteRequest.runId }
      : null)
    void session.selectSessionById(sessionRouteRequest.sessionId)
      .then(() => onSessionRouteConsumed(sessionRouteRequest.key))
      .catch(() => {
        handledSessionRouteKeysRef.current.delete(sessionRouteRequest.key)
        setNotificationRunTarget((current) => current?.key === sessionRouteRequest.key ? null : current)
      })
  }, [onSessionRouteConsumed, pageId, roomId, session, sessionRouteRequest])

  const [adapterWizard, setAdapterWizard] = useState<{
    checks: LocalAgentAdapterCheck[]
    resolve: (proceed: boolean) => void
  } | null>(null)
  // 发送含 @ 本机 Agent 的消息前检查 ACP 适配器是否已安装；缺失时弹安装向导。
  // 检测本身失败不拦发送（gateway 侧 spawn 失败仍有兜底错误）。
  const ensureLocalAgentAdapters = async (agents: MentionedAgent[]): Promise<boolean> => {
    const check = window.nxcore?.agent?.checkLocalAgentAdapters
    if (!check) return true
    let results: LocalAgentAdapterCheck[]
    try {
      results = (await check(agents.map((agent) => agent.id))) ?? []
    } catch {
      return true
    }
    if (!results.some((item) => !item.adapter.installed)) return true
    return new Promise<boolean>((resolve) => {
      setAdapterWizard({ checks: results, resolve })
    })
  }

  const sendPrompt = async (prompt: string, replaceRunId?: string, files: File[] = [], mentioned: MentionedItem[] = []) => {
    if ((!prompt.trim() && !citationPrompt && files.length === 0) || !agentAvailable) return
    const mentionedAgents: MentionedAgent[] = mentioned
      .filter((item) => item.kind === 'agent')
      .map((item) => ({ id: item.id, displayName: item.displayName }))
    if (mentionedAgents?.length && !await ensureLocalAgentAdapters(mentionedAgents)) return
    // @ 引用的 Room：本次运行按该 Room 解析（覆盖页面所在 Room 的默认聚焦）。
    const mentionedRoomId = [...mentioned].reverse().find((item) => item.kind === 'room')?.id
    // @ 引用的对话记录：取最后一条作为 referencedConversationId 注入运行上下文。
    const mentionedConversationId = [...mentioned].reverse().find((item) => item.kind === 'conversation')?.id
    const mentionedFileIds = mentioned.filter((item) => item.kind === 'file').map((item) => item.id)
    const submittedPrompt = prompt.trim() || citationPrompt
    const submittedContext = roomCitations.length
      ? buildRoomOverviewCitationContext(roomCitations)
      : ''
    setDraft('')
    setSubmitting(true)
    try {
      const externalConversation = selectedExternalConversation
      const activeDocumentContext = await prepareActiveDocumentRun(submittedPrompt)
      let attachments = undefined
      if (files.length > 0) {
        const filesApi = window.nxcore?.files
        if (!filesApi) throw new Error(t('surface:agentComposer.filesServiceUnavailable'))
        const outcomes = await filesApi.importDropped(files, { pipelines: { room: false, wiki: false, memory: false }, ...(roomId ? { roomId } : {}) })
        const imported = outcomes?.filter((item) => item.fileId && item.fileVersionId && !item.error) ?? []
        if (imported.length !== files.length) {
          throw new Error(t('surface:agentComposer.someFilesFailedToImport'))
        }
        attachments = imported.map((item) => ({
          fileId: item.fileId!,
          fileVersionId: item.fileVersionId!,
          fileName: item.filename,
          status: 'processing' as const,
        }))
      }
      if (mentionedFileIds.length) {
        const filesApi = window.nxcore?.files
        if (!filesApi) throw new Error(t('surface:agentComposer.filesServiceUnavailable'))
        const referenced = await Promise.all(mentionedFileIds.map(async (fileId) => {
          const entry = await filesApi.catalogEntry(fileId)
          if (!entry?.currentVersionId) throw new Error(t('surface:agentComposer.mentionedFileUnavailable'))
          return {
            fileId,
            fileVersionId: entry.currentVersionId,
            fileName: entry.displayName ?? entry.sharedTitle ?? entry.originalName,
            status: (entry.processingState === 'ready' ? 'ready' : 'processing') as 'ready' | 'processing',
          }
        }))
        const known = new Set((attachments ?? []).map((item) => item.fileId))
        attachments = [...(attachments ?? []), ...referenced.filter((item) => !known.has(item.fileId))]
      }
      // selectedRoomId 只在 Room 仍存在时提交：Room 已合并/删除/同步丢失时
      // 提交死 id 会被网关 409 拒绝（room_not_available），转而以全局会话运行。
      const validRoomId = roomId && rooms.some((room) => room.id === roomId) ? roomId : undefined
      const effectiveRoomId = mentionedRoomId && rooms.some((room) => room.id === mentionedRoomId)
        ? mentionedRoomId
        : validRoomId
      await session.sendPrompt(
        submittedPrompt || t('surface:agentComposer.analyzeUploadedFiles'),
        submittedContext,
        effectiveRoomId,
        activeDocumentContext,
        replaceRunId,
        attachments,
        undefined,
        externalConversation?.id ?? mentionedConversationId,
        mentionedAgents,
        mentioned,
      )
      if (externalConversation) setSelectedExternalConversation(null)
      if (roomCitations.length) onClearRoomCitations()
      setComposerResetKey((current) => current + 1)
    } catch {
      setDraft(prompt.trim())
    } finally {
      setSubmitting(false)
    }
  }

  // slides「AI 修改」弹层转发注入：roomId 对上、会话就绪后自动发送（key 去重防重放）。
  useEffect(() => {
    if (!askRequest || askRequest.roomId !== roomId || session.loading) return
    if (handledAskKeysRef.current.has(askRequest.key)) return
    handledAskKeysRef.current.add(askRequest.key)
    void sendPrompt(askRequest.message)
      .then(() => onAskConsumed(askRequest.key))
      .catch(() => handledAskKeysRef.current.delete(askRequest.key))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest, roomId, session.loading])

  const selectDocument = async ({ document, originalPrompt }: AgentDocumentSelectionSubmission) => {
    if (!roomBackendReady) return
    setSubmitting(true)
    try {
      const documents = window.nxcore?.documents
      if (!documents) throw new Error(t('surface:agent.documentServiceUnavailable'))
      const snapshot = await documents.get(document.documentId)
      const request = buildAgentDocumentSelectionRunRequest(originalPrompt, snapshot)
      await session.sendPrompt(request.prompt, undefined, undefined, request.activeDocument)
    } catch {
      // useAgentSession exposes the request error inside the conversation.
    } finally {
      setSubmitting(false)
    }
  }

  const selectDocumentRoom = async (
    room: AgentRoomReference,
    intent: PendingAgentIntent,
    document?: AgentDocumentSelectionItem,
  ) => {
    if (!roomBackendReady) return
    setSubmitting(true)
    try {
      const runId = await session.submitPendingIntent(intent.id, room.id, document?.documentId)
      if (!runId) throw new Error(t('surface:agent.thisRequestIsStillBeingProcessed'))
      setPendingNavigationByRun((current) => ({
        ...current,
        [runId]: {
          pageId: 'rooms',
          title: document?.title ?? room.title,
          action: document ? 'updated' : 'created',
          roomId: room.id,
          ...(document ? { objectId: document.documentId, objectType: 'document' as const } : {}),
        },
      }))
    } finally {
      setSubmitting(false)
    }
  }

  const openSessionLink = async (link: AgentSessionLink) => {
    const destination = agentSessionLinkDestination(link, session.sessionId)
    if (!destination) return
    setSubmitting(true)
    try {
      if (destination === 'source') await session.markSessionLinkReturned(link.id)
      onOpenSessionLink(link, destination)
    } finally {
      setSubmitting(false)
    }
  }

  // 档位可用性：lite 配置了 model 才显示档位；primary 缺连接要素时仍显示但点击提示去设置
  // （网关约定：model 空＝未配置＝档位隐藏；primary 空＝强模型档不可用）。
  const loadTierAvailability = useCallback(async (): Promise<{ lite: boolean; primary: boolean }> => {
    try {
      const snapshot = await window.nxcore?.runtimeConfig?.get()
      const config = snapshot?.config as {
        lite?: { model?: unknown }
        primary?: { provider?: unknown; model?: unknown; baseUrl?: unknown }
      } | undefined
      const lite = typeof config?.lite?.model === 'string' && config.lite.model.trim() !== ''
      const primary = ['provider', 'model', 'baseUrl'].every((key) => {
        const value = config?.primary?.[key as keyof NonNullable<typeof config.primary>]
        return typeof value === 'string' && value.trim() !== ''
      })
      return { lite, primary }
    } catch {
      return { lite: false, primary: false }
    }
  }, [])

  const modelTierLocked = Boolean(session.sessionId)
  const effectiveModelPreference: AgentModelPreference = session.currentSession?.modelPreference ?? session.modelPreferenceDefault
  // 渠道与档位同一把锁：会话已创建＝读会话锁定渠道（无渠道则 null），
  // 未创建＝读全局默认渠道。
  const effectiveChannelAgentId = session.sessionId
    ? session.currentSession?.channelAgentId ?? null
    : session.channelAgentIdDefault

  const composer = (
    <AgentComposer
      ref={composerRef}
      contextSummary={contextSummary}
      contextItems={citationItems}
      hasSelectedText={roomCitations.length > 0}
      hasSubmittableContext={Boolean(citationPrompt)}
      resetKey={composerResetKey}
      selectedExternalConversation={selectedExternalConversation}
      localAgents={localAgents}
      rooms={rooms}
      modelPreference={effectiveModelPreference}
      modelPreferenceLocked={modelTierLocked}
      contextUsage={session.contextUsage}
      contextCompacting={session.contextCompacting}
      loadModelAvailability={loadTierAvailability}
      onSelectModelPreference={session.setModelPreferenceDefault}
      channelAgentId={effectiveChannelAgentId}
      onSelectChannelAgent={session.setChannelAgentIdDefault}
      onOpenSettings={onNavigatePage ? () => onNavigatePage('settings') : undefined}
      ghostSuggestion={ghostSuggestion}
      onAcceptGhost={acceptGhost}
      onDismissGhost={dismissGhost}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading || submitting}
      available={agentAvailable}
      onChange={setDraft}
      onSelectExternalConversation={selectExternalConversation}
      onClearContext={onClearRoomCitations}
      onRemoveContext={onRemoveRoomCitation}
      onStop={() => void session.stop()}
      onSubmit={(files, mentioned) => void sendPrompt(draft, undefined, files, mentioned)}
    />
  )

  return (
    <aside className="agent-panel">
      <AgentToolbar>
        <AgentSessionSwitcher
          activeRunId={session.activeRunId}
          connected={session.connected}
          displayTitle={navigationRequest?.target.title ?? session.displayTitle}
          sessionId={session.sessionId}
          sessions={session.sessions}
          onCreate={async () => {
            setNotificationRunTarget(null)
            setDraft('')
            if (roomCitations.length) onClearRoomCitations()
            setComposerResetKey((current) => current + 1)
            // 懒创建：只回到草稿态，首条消息发出时才用当前档位/渠道默认建会话。
            return session.startNewConversation()
          }}
          onDelete={session.deleteSession}
          onRename={session.renameSession}
          onSelect={async (selectedSession) => {
            setNotificationRunTarget(null)
            setDraft('')
            if (roomCitations.length) onClearRoomCitations()
            setComposerResetKey((current) => current + 1)
            await session.selectSession(selectedSession)
          }}
        />
      </AgentToolbar>

      <WritingStyleInsightBanner />

      <AgentChatView
        activeDocument={activeDocument}
        activeRunId={session.activeRunId}
        agentIdByRun={session.agentIdByRun}
        agentNamesById={agentNamesById}
        activityByRun={session.activityByRun}
        availableRooms={rooms}
        composer={composer}
        currentSessionId={session.sessionId}
        scopeReady={session.scopeReady}
        starterPrompts={newConversationEmpty ? starterPrompts : null}
        draftHasContent={Boolean(draft.trim())}
        error={session.error}
        loading={session.loading}
        messages={session.messages}
        notificationRunTarget={notificationRunTarget}
        onNotificationRunLocated={handleNotificationRunLocated}
        pendingApprovals={session.pendingApprovals}
        onRejectDocumentIntent={focusComposer}
        onRetryPrompt={(prompt, runId) => void sendPrompt(prompt, runId)}
        onOpenSessionLink={(link) => void openSessionLink(link)}
        onOpenMention={openMention}
        onSelectRoom={selectDocumentRoom}
        onSelectDocument={(selection) => void selectDocument(selection)}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          focusComposer()
        }}
        pendingNavigationByRun={pendingNavigationByRun}
        reasoningByRun={session.reasoningByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        resolvingApprovalIds={session.resolvingApprovalIds}
        sessionLinks={session.sessionLinks}
        submitting={submitting || !roomBackendReady}
        toolCallsByRun={session.toolCallsByRun}
        onResolveApproval={(approvalId, decision) => void session.resolveApproval(approvalId, decision)}
        composerNotice={adapterWizard ? (
          <LocalAgentAdapterWizard
            initialChecks={adapterWizard.checks}
            onProceed={() => {
              adapterWizard.resolve(true)
              setAdapterWizard(null)
            }}
            onCancel={() => {
              adapterWizard.resolve(false)
              setAdapterWizard(null)
            }}
          />
        ) : undefined}
      />
    </aside>
  )
}
