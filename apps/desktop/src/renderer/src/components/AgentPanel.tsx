import { useEffect, useRef, useState } from 'react'
import type { AgentNavigationTarget, AgentRoomReference, AgentSessionLink } from '@nxcore/agent-contract'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
import {
  agentSessionLinkDestination,
  navigationKey,
  parseAgentNavigationTarget,
  type AgentNavigationRequest,
  type AgentSessionRouteRequest,
} from '@/components/agent/agentNavigation'
import { useAgentSession } from '@/components/agent/useAgentSession'
import type { ContextRoomWorkspaceTab } from '@/components/context-room/contextRoomTabs'
import type { PageId } from '@/data/navigation'

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
  onNavigationConsumed,
  onOpenSessionLink,
  onSessionRouteConsumed,
  focusRequest = 0,
}: {
  pageId: PageId
  pageLabel: string
  roomId: string | null
  rooms: ContextRoomWorkspaceTab[]
  roomBackendReady: boolean
  navigationRequest: AgentNavigationRequest | null
  sessionRouteRequest: AgentSessionRouteRequest | null
  onNavigate: (request: AgentNavigationRequest) => void
  onNavigationConsumed: (key: string) => void
  onOpenSessionLink: (link: AgentSessionLink, destination: 'source' | 'target') => void
  onSessionRouteConsumed: (key: string) => void
  focusRequest?: number
}) {
  const [draft, setDraft] = useState('')
  const [selectedText, setSelectedText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pendingNavigationByRun, setPendingNavigationByRun] = useState<Record<string, AgentNavigationTarget>>({})
  const [composerResetKey, setComposerResetKey] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const previousSessionIdRef = useRef<string | null>(null)
  const handledNavigationKeysRef = useRef(new Set<string>())
  const handledRequestKeysRef = useRef(new Set<string>())
  const handledSessionRouteKeysRef = useRef(new Set<string>())
  const selectedTextSummary = selectedText.replace(/\s+/g, ' ').trim()
  const contextSummary = selectedTextSummary
    ? `${pageLabel} · “${selectedTextSummary}”`
    : `${pageLabel} · 未选择文本`
  const session = useAgentSession(pageLabel, roomId, rooms)

  const focusComposer = () => {
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  useEffect(() => {
    if (!focusRequest) return
    focusComposer()
  }, [focusRequest])

  useEffect(() => {
    setSelectedText('')
    setComposerResetKey((current) => current + 1)
  }, [pageLabel])

  useEffect(() => {
    if (previousSessionIdRef.current === session.sessionId) return
    if (previousSessionIdRef.current !== null) {
      setDraft('')
      setSelectedText('')
      setComposerResetKey((current) => current + 1)
    }
    previousSessionIdRef.current = session.sessionId
    setPendingNavigationByRun({})
  }, [session.sessionId])

  useEffect(() => {
    const readWorkspaceSelection = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      const anchor = selection.anchorNode
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      if (!anchorElement?.closest('.workspace-main')) return
      const text = selection.toString().trim()
      if (text) setSelectedText(text.slice(0, 8_000))
    }
    document.addEventListener('selectionchange', readWorkspaceSelection)
    return () => document.removeEventListener('selectionchange', readWorkspaceSelection)
  }, [])

  useEffect(() => {
    if (!session.sessionId || navigationRequest) return
    const tools = Object.values(session.toolCallsByRun).flat()
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
      handledNavigationKeysRef.current.add(key)
      onNavigate({
        key,
        source: {
          sessionId: session.sessionId,
          pageId,
          pageLabel,
          roomId,
          runId: tool.runId,
        },
        target,
      })
      return
    }
  }, [navigationRequest, onNavigate, pageId, pageLabel, roomId, session.sessionId, session.sessionLinks, session.toolCallsByRun])

  useEffect(() => {
    if (!navigationRequest || navigationRequest.target.pageId !== pageId) return
    if ((navigationRequest.target.roomId ?? null) !== roomId) return
    if (!roomBackendReady || !session.scopeReady || session.loading || session.activeRunId || submitting) return
    if (handledRequestKeysRef.current.has(navigationRequest.key)) return
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
    void session.selectSessionById(sessionRouteRequest.sessionId)
      .then(() => onSessionRouteConsumed(sessionRouteRequest.key))
      .catch(() => handledSessionRouteKeysRef.current.delete(sessionRouteRequest.key))
  }, [onSessionRouteConsumed, pageId, roomId, session, sessionRouteRequest])

  const sendPrompt = async (prompt: string) => {
    if (!prompt.trim() || !roomBackendReady) return
    const submittedPrompt = prompt.trim()
    const submittedContext = selectedText
    setDraft('')
    setSubmitting(true)
    try {
      await session.sendPrompt(submittedPrompt, submittedContext)
      setSelectedText('')
      setComposerResetKey((current) => current + 1)
    } catch {
      setDraft(submittedPrompt)
    } finally {
      setSubmitting(false)
    }
  }

  const selectDocumentRoom = async (room: AgentRoomReference) => {
    if (!roomBackendReady) return
    setSubmitting(true)
    try {
      const runId = await session.sendPrompt(`在「${room.title}」中创建。`, undefined, room.id)
      if (runId) {
        setPendingNavigationByRun((current) => ({
          ...current,
          [runId]: {
            pageId: 'rooms',
            title: room.title,
            action: 'created',
            roomId: room.id,
          },
        }))
      }
    } catch {
      // useAgentSession exposes the request error inside the conversation.
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
      hasSelectedText={Boolean(selectedText)}
      resetKey={composerResetKey}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading || submitting}
      available={roomBackendReady}
      onChange={setDraft}
      onClearContext={() => setSelectedText('')}
      onStop={() => void session.stop()}
      onSubmit={() => void sendPrompt(draft)}
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
            setDraft('')
            setSelectedText('')
            setComposerResetKey((current) => current + 1)
            return session.createSession()
          }}
          onDelete={session.deleteSession}
          onRename={session.renameSession}
          onSelect={async (selectedSession) => {
            setDraft('')
            setSelectedText('')
            setComposerResetKey((current) => current + 1)
            await session.selectSession(selectedSession)
          }}
        />
      </AgentToolbar>

      <AgentChatView
        activeRunId={session.activeRunId}
        availableRooms={rooms}
        composer={composer}
        currentSessionId={session.sessionId}
        scopeReady={session.scopeReady}
        draftHasContent={Boolean(draft.trim())}
        error={session.error}
        loading={session.loading}
        messages={session.messages}
        onRetryPrompt={(prompt) => void sendPrompt(prompt)}
        onOpenSessionLink={(link) => void openSessionLink(link)}
        onSelectRoom={(room) => void selectDocumentRoom(room)}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          focusComposer()
        }}
        pendingNavigationByRun={pendingNavigationByRun}
        reasoningByRun={session.reasoningByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        sessionLinks={session.sessionLinks}
        submitting={submitting || !roomBackendReady}
        toolCallsByRun={session.toolCallsByRun}
      />
    </aside>
  )
}
