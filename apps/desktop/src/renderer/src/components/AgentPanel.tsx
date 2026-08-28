import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentNavigationTarget, AgentRoomReference, AgentSessionLink, PendingAgentIntent, ExternalConversationSummary } from '@nxcore/agent-contract'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
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
import type { PageId } from '@/data/navigation'
import { useLocale } from '@/i18n/LocaleContext'
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
  onNavigate,
  onRestoreRoomTab,
  onNavigationConsumed,
  onOpenSessionLink,
  onOpenDocument,
  onSessionRouteConsumed,
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
  onNavigate: (request: AgentNavigationRequest) => void
  onRestoreRoomTab: (target: AgentNavigationRequest['target']) => void
  onNavigationConsumed: (key: string) => void
  onOpenSessionLink: (link: AgentSessionLink, destination: 'source' | 'target') => void
  onOpenDocument: (target: { roomId: string; documentId: string; blockId?: string | null }) => void
  onSessionRouteConsumed: (key: string) => void
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
  const contextSummary = roomCitations.length
    ? `${roomCitations[0]?.roomTitle ?? pageLabel} · ${t('surface:agentComposer.countReferences', { count: roomCitations.length })}`
    : `${pageLabel} · ${t('surface:agent.noTextSelected')}`
  const citationPrompt = buildRoomOverviewCitationPrompt(roomCitations, locale)
  const session = useAgentSession(pageLabel, roomId, rooms)
  const agentAvailable = Boolean(window.nxcore?.agent)
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
  }, [roomId, session.toolCallsByRun])

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

  const sendPrompt = async (prompt: string, replaceRunId?: string, files: File[] = []) => {
    if ((!prompt.trim() && !citationPrompt && files.length === 0) || !agentAvailable) return
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
      if (externalConversation) {
        await session.sendPrompt(
          submittedPrompt || t('surface:agentComposer.analyzeUploadedFiles'),
          submittedContext,
          roomId ?? undefined,
          activeDocumentContext,
          replaceRunId,
          attachments,
          undefined,
          externalConversation?.id,
        )
      } else {
        await session.sendPrompt(
          submittedPrompt || t('surface:agentComposer.analyzeUploadedFiles'),
          submittedContext,
          roomId ?? undefined,
          activeDocumentContext,
          replaceRunId,
          attachments,
        )
      }
      if (externalConversation) setSelectedExternalConversation(null)
      if (roomCitations.length) onClearRoomCitations()
      setComposerResetKey((current) => current + 1)
    } catch {
      setDraft(prompt.trim())
    } finally {
      setSubmitting(false)
    }
  }

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

  const composer = (
    <AgentComposer
      ref={composerRef}
      contextSummary={contextSummary}
      contextItems={citationItems}
      hasSelectedText={roomCitations.length > 0}
      hasSubmittableContext={Boolean(citationPrompt)}
      resetKey={composerResetKey}
      selectedExternalConversation={selectedExternalConversation}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading || submitting}
      available={agentAvailable}
      onChange={setDraft}
      onSelectExternalConversation={selectExternalConversation}
      onClearContext={onClearRoomCitations}
      onRemoveContext={onRemoveRoomCitation}
      onStop={() => void session.stop()}
      onSubmit={(files) => void sendPrompt(draft, undefined, files)}
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
            return session.createSession()
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
        onSelectRoom={selectDocumentRoom}
        onSelectDocument={(selection) => void selectDocument(selection)}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          focusComposer()
        }}
        pendingNavigationByRun={pendingNavigationByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        resolvingApprovalIds={session.resolvingApprovalIds}
        sessionLinks={session.sessionLinks}
        submitting={submitting || !roomBackendReady}
        toolCallsByRun={session.toolCallsByRun}
        onResolveApproval={(approvalId, decision) => void session.resolveApproval(approvalId, decision)}
      />
    </aside>
  )
}
