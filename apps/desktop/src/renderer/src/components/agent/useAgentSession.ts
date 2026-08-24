import type {
  AgentEvent,
  AgentActiveDocumentContext,
  AgentFileAttachment,
  AgentMessage,
  AgentRoomReference,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  CreateAgentSessionLinkInput,
} from '@nxcore/agent-contract'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import {
  mergeAgentToolEvent,
  reduceAgentRunActivity,
  reduceAgentRunEvents,
  type AgentRunActivity,
  type DisplayAgentToolCall,
  type DisplayAgentToolStatus,
  type ReducedAgentRunEvents,
} from './agentRunActivity'
import { buildAgentRunContext } from './agentRunContext'

export { mergeAgentToolEvent, reduceAgentRunEvents } from './agentRunActivity'
export type {
  AgentRunActivity,
  DisplayAgentToolCall,
  DisplayAgentToolStatus,
  ReducedAgentRunEvents,
} from './agentRunActivity'

export interface DisplayAgentMessage extends AgentMessage {
  streaming?: boolean
}

export function mergePendingAgentMessages(
  messages: DisplayAgentMessage[],
  pendingMessages: DisplayAgentMessage[],
): DisplayAgentMessage[] {
  if (pendingMessages.length === 0) return messages
  return [...messages, ...pendingMessages.filter((message) => !messages.some((existing) => (
    existing.id === message.id
    || (existing.runId === message.runId && existing.role === message.role && existing.content === message.content)
  )))]
}

export function removeAgentRunMessages(
  messages: DisplayAgentMessage[],
  runId: string,
): DisplayAgentMessage[] {
  return messages.filter((message) => message.runId !== runId)
}

const SESSION_STORAGE_KEY = 'nxcore-ce:agent-session:v2'
const LEGACY_SESSION_STORAGE_KEY = 'nxcore-ce:agent-sessions:v1'
const defaultSessionCreations = new Map<string, Promise<AgentSession>>()

function isUserSession(session: AgentSession): boolean {
  return session.pageLabel !== 'Remote Agent'
    && !session.pageLabel.startsWith('AI ')
}

function sessionScope(_pageLabel?: string, _roomId?: string | null): string {
  return 'global'
}

function readStoredSession(): string | null {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)
      ?? '{}'
    const value: unknown = JSON.parse(stored)
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.global === 'string') return record.global
    // Migrate the old per-page/per-Room map by keeping one last selection.
    const legacy = Object.values(record).find((sessionId): sessionId is string => typeof sessionId === 'string')
    return legacy ?? null
  } catch {
    return null
  }
}

function storeSession(sessionId: string | null): void {
  try {
    if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionId))
    else localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Session persistence is optional when browser storage is unavailable.
  }
}

function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function useAgentSession(
  pageLabel: string,
  roomId: string | null,
  rooms: AgentRoomReference[],
) {
  const { locale, t } = useLocale()
  const api = window.nxcore?.agent
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [currentSession, setCurrentSession] = useState<AgentSession | null>(null)
  const [sessionLinks, setSessionLinks] = useState<AgentSessionLink[]>([])
  const [messages, setMessages] = useState<DisplayAgentMessage[]>([])
  const [toolCallsByRun, setToolCallsByRun] = useState<Record<string, DisplayAgentToolCall[]>>({})
  const [activityByRun, setActivityByRun] = useState<Record<string, AgentRunActivity>>({})
  const [runStartedAtByRun, setRunStartedAtByRun] = useState<Record<string, string>>({})
  const [runCompletedAtByRun, setRunCompletedAtByRun] = useState<Record<string, string>>({})
  const [reasoningByRun, setReasoningByRun] = useState<Record<string, string>>({})
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [scopeReady, setScopeReady] = useState(false)
  const [displayTitle, setDisplayTitle] = useState('')
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequenceByRun = useRef(new Map<string, number>())
  const eventsByRun = useRef(new Map<string, AgentEvent[]>())
  const terminalRunIdsRef = useRef(new Set<string>())
  const sessionIdRef = useRef<string | null>(null)
  const activeScopeRef = useRef(sessionScope(pageLabel, roomId))

  const updateToolCall = useCallback((event: AgentEvent) => {
    setToolCallsByRun((current) => {
      const tools = current[event.runId] ?? []
      const next = mergeAgentToolEvent(tools, event)
      return next === tools ? current : { ...current, [event.runId]: next }
    })
  }, [])

  const applyEvent = useCallback((event: AgentEvent) => {
    const lastSequence = sequenceByRun.current.get(event.runId) ?? 0
    if (event.seq <= lastSequence) return
    sequenceByRun.current.set(event.runId, event.seq)
    const runEvents = [...(eventsByRun.current.get(event.runId) ?? []), event]
    eventsByRun.current.set(event.runId, runEvents)
    setActivityByRun((current) => ({
      ...current,
      [event.runId]: reduceAgentRunActivity(runEvents),
    }))

    if (event.type === 'run.accepted' || event.type === 'run.started') {
      if (event.type === 'run.accepted') {
        const prompt = (event.payload as { prompt?: unknown }).prompt
        if (typeof prompt === 'string' && prompt.trim()) {
          setMessages((current) => {
            const existing = current.find((message) =>
              message.role === 'user'
              && (
                message.runId === event.runId
                || (message.runId === 'pending' && message.content === prompt)
              )
            )

            if (existing) {
              return current
                .filter((message) => message.id === existing.id || !(
                  message.id !== existing.id
                  && message.role === 'user'
                  && message.content === prompt
                  && (message.runId === 'pending' || message.runId === event.runId)
                ))
                .map((message) => message.id === existing.id
                  ? { ...message, sessionId: event.sessionId, runId: event.runId }
                  : message
                )
            }

            return [...current, {
              id: `user-${event.runId}`,
              sessionId: event.sessionId,
              runId: event.runId,
              role: 'user',
              content: prompt,
              createdAt: event.occurredAt,
            }]
          })
        }
      }
      setActiveRunId(event.runId)
      setRunStartedAtByRun((current) => current[event.runId]
        ? current
        : { ...current, [event.runId]: event.occurredAt })
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status: 'running' }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status: 'running' }
        : current)
      return
    }
    if (
      event.type === 'tool.requested' ||
      event.type === 'tool.started' ||
      event.type === 'tool.updated' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed'
    ) {
      updateToolCall(event)
      return
    }
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') setReasoningByRun((current) => ({
        ...current,
        [event.runId]: (current[event.runId] ?? '') + delta,
      }))
      return
    }
    if (event.type === 'message.started') {
      setMessages((current) => current.some((message) => message.id === `stream-${event.runId}`)
        ? current
        : [...current, {
          id: `stream-${event.runId}`,
          sessionId: event.sessionId,
          runId: event.runId,
          role: 'assistant',
          content: '',
          createdAt: event.occurredAt,
          streaming: true,
        }])
      return
    }
    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta !== 'string') return
      setMessages((current) => {
        const id = `stream-${event.runId}`
        const existing = current.find((message) => message.id === id)
        if (!existing) {
          return [...current, {
            id,
            sessionId: event.sessionId,
            runId: event.runId,
            role: 'assistant',
            content: delta,
            createdAt: event.occurredAt,
            streaming: true,
          }]
        }
        return current.map((message) => message.id === id
          ? { ...message, content: message.content + delta }
          : message)
      })
      return
    }
    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      setMessages((current) => {
        const streamId = `stream-${event.runId}`
        const existing = current.find((message) => message.id === streamId)
        if (!existing && typeof content === 'string') {
          return [...current, {
            id: streamId,
            sessionId: event.sessionId,
            runId: event.runId,
            role: 'assistant',
            content,
            createdAt: event.occurredAt,
            streaming: false,
          }]
        }
        return current.map((message) => message.id === streamId
          ? { ...message, content: typeof content === 'string' ? content : message.content, streaming: false }
          : message)
      })
      return
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      terminalRunIdsRef.current.add(event.runId)
      setActiveRunId((current) => current === event.runId ? null : current)
      setMessages((current) => current.map((message) => message.runId === event.runId && message.streaming
        ? { ...message, streaming: false }
        : message))
      setRunCompletedAtByRun((current) => ({ ...current, [event.runId]: event.occurredAt }))
      setToolCallsByRun((current) => {
        const tools = current[event.runId]
        if (!tools || event.type === 'run.completed') return current
        const status: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
        return {
          ...current,
          [event.runId]: tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
            ? { ...tool, status, completedAt: event.occurredAt }
            : tool),
        }
      })
      const status = event.type === 'run.interrupted' ? 'interrupted' : 'idle'
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status, updatedAt: event.occurredAt }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status, updatedAt: event.occurredAt }
        : current)
      if (event.type === 'run.failed') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : t('surface:useAgentSession.runFailed'))
      }
    }
  }, [updateToolCall])

  const hydrateSnapshot = useCallback(async (
    snapshot: AgentSessionSnapshot,
    pendingMessages: DisplayAgentMessage[] = [],
    expectedScope = activeScopeRef.current,
  ) => {
    if (expectedScope !== activeScopeRef.current || snapshot.session.id !== sessionIdRef.current) return false
    sequenceByRun.current.clear()
    eventsByRun.current.clear()
    terminalRunIdsRef.current.clear()
    const runIds = [...new Set([
      ...snapshot.messages.map((message) => message.runId),
      ...(snapshot.activeRun ? [snapshot.activeRun.id] : []),
    ].filter((runId) => runId && runId !== 'pending'))]
    const eventGroups = api
      ? await Promise.all(runIds.map(async (runId) => ({
        runId,
        events: await api.getEvents(snapshot.session.id, runId, 0),
      })))
      : []
    const nextSessionLinks = api ? await api.listSessionLinks(snapshot.session.id) : []
    const nextTools: Record<string, DisplayAgentToolCall[]> = {}
    const nextActivity: Record<string, AgentRunActivity> = {}
    const nextReasoning: Record<string, string> = {}
    const nextStartedAt: Record<string, string> = {}
    const nextCompletedAt: Record<string, string> = {}
    const reducedByRun = new Map<string, ReducedAgentRunEvents>()
    for (const group of eventGroups) {
      const reduced = reduceAgentRunEvents(group.events)
      const savedAnswer = snapshot.messages.find((message) => (
        message.runId === group.runId && message.role === 'assistant'
      ))?.content ?? ''
      reducedByRun.set(group.runId, reduced)
      sequenceByRun.current.set(group.runId, reduced.lastSequence)
      eventsByRun.current.set(group.runId, group.events)
      nextActivity[group.runId] = reduceAgentRunActivity(group.events, savedAnswer)
      if (reduced.tools.length) nextTools[group.runId] = reduced.tools
      if (reduced.reasoning) nextReasoning[group.runId] = reduced.reasoning
      if (reduced.startedAt) nextStartedAt[group.runId] = reduced.startedAt
      if (reduced.completedAt) nextCompletedAt[group.runId] = reduced.completedAt
    }
    if (snapshot.activeRun?.startedAt) nextStartedAt[snapshot.activeRun.id] = snapshot.activeRun.startedAt

    if (expectedScope !== activeScopeRef.current || snapshot.session.id !== sessionIdRef.current) return false

    const nextMessages = mergePendingAgentMessages(snapshot.messages, pendingMessages)
    if (snapshot.activeRun) {
      const reduced = reducedByRun.get(snapshot.activeRun.id)
      const hasAssistant = nextMessages.some((message) => (
        message.runId === snapshot.activeRun?.id && message.role === 'assistant'
      ))
      if (!hasAssistant && reduced && (reduced.messageStarted || reduced.streamingContent)) {
        nextMessages.push({
          id: `stream-${snapshot.activeRun.id}`,
          sessionId: snapshot.session.id,
          runId: snapshot.activeRun.id,
          role: 'assistant',
          content: reduced.streamingContent,
          createdAt: reduced.startedAt ?? snapshot.activeRun.createdAt,
          streaming: !reduced.messageCompleted,
        })
      }
    }

    setMessages(nextMessages)
    setSessionLinks(nextSessionLinks)
    setToolCallsByRun(nextTools)
    setActivityByRun(nextActivity)
    setReasoningByRun(nextReasoning)
    setRunStartedAtByRun(nextStartedAt)
    setRunCompletedAtByRun(nextCompletedAt)
    setActiveRunId(snapshot.activeRun?.id ?? null)
    setSessionId(snapshot.session.id)
    setCurrentSession(snapshot.session)
    const title = snapshot.session.title?.trim() || t('surface:useAgentSession.newConversation')
    setDisplayTitle(title)
    setScopeReady(true)
    setSessions((current) => current.some((session) => session.id === snapshot.session.id)
      ? current.map((session) => session.id === snapshot.session.id ? snapshot.session : session)
      : [snapshot.session, ...current])
    sessionIdRef.current = snapshot.session.id
    storeSession(snapshot.session.id)
    return true
  }, [api])

  const selectSession = useCallback(async (
    session: AgentSession,
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<void> => {
    if (!api) return
    const expectedScope = sessionScope(pageLabel, roomId)
    setLoading(true)
    setScopeReady(false)
    setError(null)
    setSessionId(session.id)
    setCurrentSession(session)
    setDisplayTitle(session.title?.trim() || t('surface:useAgentSession.newConversation'))
    sessionIdRef.current = session.id
    try {
      await api.unsubscribe()
      const snapshot = await api.getSession(session.id)
      const hydrated = await hydrateSnapshot(snapshot, pendingMessages, expectedScope)
      if (!hydrated || expectedScope !== activeScopeRef.current) return
      storeSession(session.id)
      await api.subscribe(session.id)
    } catch (requestError) {
      if (expectedScope === activeScopeRef.current && session.id === sessionIdRef.current) {
        setConnected(false)
        setScopeReady(true)
        setError(requestErrorMessage(requestError, t('surface:useAgentSession.switchFailed')))
      }
    } finally {
      if (expectedScope === activeScopeRef.current && session.id === sessionIdRef.current) setLoading(false)
    }
  }, [api, hydrateSnapshot])

  useLayoutEffect(() => {
    let alive = true
    activeScopeRef.current = sessionScope(pageLabel, roomId)
    setScopeReady(false)
    setMessages([])
    setToolCallsByRun({})
    setActivityByRun({})
    setRunStartedAtByRun({})
    setRunCompletedAtByRun({})
    setReasoningByRun({})
    setActiveRunId(null)
    setSessionId(null)
    setSessions([])
    setSessionLinks([])
    sessionIdRef.current = null
    sequenceByRun.current.clear()
    eventsByRun.current.clear()
    setError(null)

    if (api) {
      setLoading(true)
      void api.listSessions()
        .then(async (listedSessions) => {
          if (!alive) return
          const userSessions = listedSessions.filter(isUserSession)
          setSessions(userSessions)
          const storedSessionId = readStoredSession()
          const selected = userSessions.find((session) => session.id === storedSessionId)
            ?? userSessions[0]
          if (selected) await selectSession(selected)
          else if (alive) {
            const scope = sessionScope()
            setDisplayTitle(t('surface:useAgentSession.newConversation'))
            let creation = defaultSessionCreations.get(scope)
            if (!creation) {
              creation = api.createSession({ pageLabel: 'Agent', roomId: null })
              defaultSessionCreations.set(scope, creation)
              const clear = () => {
                if (defaultSessionCreations.get(scope) === creation) {
                  defaultSessionCreations.delete(scope)
                }
              }
              void creation.then(clear, clear)
            }
            const created = await creation
            if (!alive || scope !== activeScopeRef.current) return
            setSessions([created])
            await selectSession(created)
          }
        })
        .catch((requestError) => {
          if (alive) {
            setConnected(false)
            setScopeReady(true)
          }
          if (alive) setError(requestError instanceof Error ? requestError.message : t('surface:useAgentSession.loadFailed'))
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    } else {
      setScopeReady(true)
    }

    const removeListener = api?.onEvent((frame) => {
      const frameSessionId = frame.type === 'ready' ? frame.sessionId : frame.event.sessionId
      if (!alive || frameSessionId !== sessionIdRef.current) return
      if (frame.type === 'ready') {
        setConnected(true)
        if (frame.lastEventSeq > 0) {
          void api.getSession(frame.sessionId).then(hydrateSnapshot).catch((requestError) => {
            setError(requestError instanceof Error ? requestError.message : t('surface:useAgentSession.restoreFailed'))
          })
        }
      } else {
        applyEvent(frame.event)
      }
    })

    return () => {
      alive = false
      removeListener?.()
      void api?.unsubscribe()
    }
  }, [api, applyEvent, hydrateSnapshot, selectSession])

  const createSession = async (
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<AgentSession> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    if (activeRunId) throw new Error(t('surface:useAgentSession.stopBeforeCreating'))
    try {
      const session = await api.createSession({ pageLabel: 'Agent', roomId: null })
      setSessions((current) => [session, ...current])
      await selectSession(session, pendingMessages)
      return session
    } catch (createError) {
      setError(requestErrorMessage(createError, t('surface:useAgentSession.createFailed')))
      throw createError
    }
  }

  const ensureSession = async (pendingMessages: DisplayAgentMessage[]): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current
    return (await createSession(pendingMessages)).id
  }

  const renameSession = async (sessionIdToRename: string, title: string): Promise<void> => {
    if (!api || !title.trim()) return
    try {
      const updated = await api.updateSession(sessionIdToRename, { title: title.trim() })
      setSessions((current) => current.map((session) => session.id === updated.id ? updated : session))
      setCurrentSession((current) => current?.id === updated.id ? updated : current)
      if (updated.id === sessionIdRef.current) {
        setDisplayTitle(updated.title?.trim() ?? '')
      }
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.renameFailed')))
      throw requestError
    }
  }

  const deleteSession = async (session: AgentSession): Promise<void> => {
    if (!api || session.status === 'running' || (session.id === sessionId && activeRunId)) return
    try {
      await api.deleteSession(session.id)
      const remaining = sessions.filter((item) => item.id !== session.id)
      setSessions(remaining)
      if (session.id === sessionIdRef.current) {
        await api.unsubscribe()
        const next = remaining[0]
        if (next) await selectSession(next)
        else {
          sessionIdRef.current = null
          setSessionId(null)
          setCurrentSession(null)
          setDisplayTitle(t('surface:useAgentSession.newConversation'))
          setScopeReady(false)
          setSessionLinks([])
          setMessages([])
          setToolCallsByRun({})
          setActivityByRun({})
          setReasoningByRun({})
          setRunStartedAtByRun({})
          setRunCompletedAtByRun({})
          eventsByRun.current.clear()
          sequenceByRun.current.clear()
          setConnected(false)
          storeSession(null)
          try {
            await createSession()
          } catch {
            setScopeReady(true)
          }
        }
      }
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.deleteFailed')))
      throw requestError
    }
  }

  const selectSessionById = async (sessionIdToSelect: string): Promise<void> => {
    if (!api || sessionIdToSelect === sessionIdRef.current) return
    const listed = sessions.find((session) => session.id === sessionIdToSelect)
    if (listed) {
      await selectSession(listed)
      return
    }
    const snapshot = await api.getSession(sessionIdToSelect)
    await selectSession(snapshot.session)
  }

  const createSessionLink = async (input: CreateAgentSessionLinkInput): Promise<AgentSessionLink> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    try {
      const link = await api.createSessionLink(input)
      if (link.sourceSessionId === sessionIdRef.current || link.targetSessionId === sessionIdRef.current) {
        setSessionLinks((current) => current.some((item) => item.id === link.id) ? current : [...current, link])
      }
      return link
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.createReferenceFailed')))
      throw requestError
    }
  }

  const markSessionLinkReturned = async (linkId: string): Promise<AgentSessionLink> => {
    if (!api) throw new Error(t('surface:useAgentSession.desktopOnly'))
    try {
      const link = await api.markSessionLinkReturned(linkId)
      setSessionLinks((current) => current.map((item) => item.id === link.id ? link : item))
      return link
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.returnFailed')))
      throw requestError
    }
  }

  const sendPrompt = async (
    prompt: string,
    selectedText?: string,
    selectedRoomId?: string,
    activeDocument?: AgentActiveDocumentContext | null,
    replaceRunId?: string,
    attachments?: AgentFileAttachment[],
  ): Promise<string | null> => {
    const message = prompt.trim()
    if (!message || activeRunId || loading || sending) return null
    if (replaceRunId) {
      setMessages((current) => removeAgentRunMessages(current, replaceRunId))
      setToolCallsByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setActivityByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setRunStartedAtByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setRunCompletedAtByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      setReasoningByRun((current) => {
        if (!(replaceRunId in current)) return current
        const next = { ...current }
        delete next[replaceRunId]
        return next
      })
      eventsByRun.current.delete(replaceRunId)
      sequenceByRun.current.delete(replaceRunId)
      terminalRunIdsRef.current.delete(replaceRunId)
    }
    const optimisticId = `user-${crypto.randomUUID()}`
    const optimisticMessage: DisplayAgentMessage = {
      id: optimisticId,
      sessionId: sessionIdRef.current ?? 'pending',
      runId: 'pending',
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    }

    setMessages((current) => mergePendingAgentMessages(current, [optimisticMessage]))
    setSending(true)
    setError(null)
    try {
      const currentSessionId = await ensureSession([optimisticMessage])
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, sessionId: currentSessionId }
        : item))
      const run = await api!.startRun(currentSessionId, {
        prompt: message,
        idempotencyKey: crypto.randomUUID(),
        ...(replaceRunId ? { replaceRunId } : {}),
        responseLanguage: locale,
        context: buildAgentRunContext(rooms, selectedText, selectedRoomId, activeDocument, pageLabel, attachments),
      })
      const updatedAt = new Date().toISOString()
      const runCompleted = terminalRunIdsRef.current.has(run.id)
      setSessions((current) => current.map((session) => session.id === currentSessionId
        ? {
            ...session,
            title: session.title ?? message.slice(0, 48),
            ...(!runCompleted ? { status: 'running' as const } : {}),
            updatedAt,
          }
        : session))
      setCurrentSession((current) => current?.id === currentSessionId
        ? {
            ...current,
            title: current.title ?? message.slice(0, 48),
            ...(!runCompleted ? { status: 'running' as const } : {}),
            updatedAt,
          }
        : current)
      const nextTitle = currentSession?.id === currentSessionId && currentSession.title?.trim()
        ? currentSession.title.trim()
        : message.slice(0, 48)
      setDisplayTitle(nextTitle)
      if (!runCompleted) {
        setActiveRunId(run.id)
        setReasoningByRun((current) => ({ ...current, [run.id]: '' }))
      }
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, runId: run.id }
        : item))
      return run.id
    } catch (requestError) {
      if (optimisticId) {
        setMessages((current) => current.filter((message) => message.id !== optimisticId))
      }
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.sendFailed')))
      throw requestError
    } finally {
      setSending(false)
    }
  }

  const submitPendingIntent = async (
    intentId: string,
    selectedRoomId: string,
    documentId?: string,
  ): Promise<string | null> => {
    if (!api || activeRunId || loading || sending) return null
    setSending(true)
    setError(null)
    try {
      const { run } = await api.submitPendingIntent(intentId, {
        roomId: selectedRoomId,
        ...(documentId ? { documentId } : {}),
        idempotencyKey: crypto.randomUUID(),
        responseLanguage: locale,
      })
      const runCompleted = terminalRunIdsRef.current.has(run.id)
      const updatedAt = new Date().toISOString()
      setSessions((current) => current.map((session) => session.id === run.sessionId
        ? { ...session, ...(!runCompleted ? { status: 'running' as const } : {}), updatedAt }
        : session))
      setCurrentSession((current) => current?.id === run.sessionId
        ? { ...current, ...(!runCompleted ? { status: 'running' as const } : {}), updatedAt }
        : current)
      if (!runCompleted) {
        setActiveRunId(run.id)
        setReasoningByRun((current) => ({ ...current, [run.id]: '' }))
      }
      return run.id
    } catch (requestError) {
      const message = requestErrorMessage(requestError, t('surface:useAgentSession.continueFailed'))
      setError(/no longer available/i.test(message)
        ? t('surface:useAgentSession.selectionExpired')
        : /not allowed/i.test(message)
          ? t('surface:useAgentSession.roomUnavailable')
          : /active run/i.test(message) ? t('surface:useAgentSession.agentBusy') : message)
      throw requestError
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!api || !activeRunId) return
    try {
      await api.cancelRun(activeRunId)
    } catch (requestError) {
      setError(requestErrorMessage(requestError, t('surface:useAgentSession.stopFailed')))
    }
  }

  return {
    activeRunId,
    activityByRun,
    connected,
    createSession,
    createSessionLink,
    currentSession,
    deleteSession,
    displayTitle,
    error,
    loading: loading || sending,
    messages,
    reasoningByRun,
    runCompletedAtByRun,
    runStartedAtByRun,
    scopeReady,
    renameSession,
    markSessionLinkReturned,
    selectSession,
    selectSessionById,
    sendPrompt,
    sessionId,
    sessionLinks,
    sessions,
    stop,
    submitPendingIntent,
    toolCallsByRun,
  }
}
