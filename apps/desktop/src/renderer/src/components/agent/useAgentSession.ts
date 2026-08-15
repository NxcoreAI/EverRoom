import type {
  AgentEvent,
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface DisplayAgentMessage extends AgentMessage {
  streaming?: boolean
}

export function mergePendingAgentMessages(
  messages: DisplayAgentMessage[],
  pendingMessages: DisplayAgentMessage[],
): DisplayAgentMessage[] {
  if (pendingMessages.length === 0) return messages
  const messageIds = new Set(messages.map((message) => message.id))
  return [...messages, ...pendingMessages.filter((message) => !messageIds.has(message.id))]
}

const SESSION_STORAGE_KEY = 'nxcore-ce:agent-sessions:v1'

function sessionScope(pageLabel: string, roomId: string | null): string {
  return `${pageLabel}:${roomId ?? 'global'}`
}

function readStoredSession(pageLabel: string, roomId: string | null): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object') return null
    const sessionId = (value as Record<string, unknown>)[sessionScope(pageLabel, roomId)]
    return typeof sessionId === 'string' ? sessionId : null
  } catch {
    return null
  }
}

function storeSession(pageLabel: string, roomId: string | null, sessionId: string | null): void {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    const sessions = value && typeof value === 'object'
      ? { ...(value as Record<string, unknown>) }
      : {}
    const scope = sessionScope(pageLabel, roomId)
    if (sessionId) sessions[scope] = sessionId
    else delete sessions[scope]
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // Session persistence is optional when browser storage is unavailable.
  }
}

export function useAgentSession(pageLabel: string, roomId: string | null) {
  const api = window.nxcore?.agent
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [currentSession, setCurrentSession] = useState<AgentSession | null>(null)
  const [messages, setMessages] = useState<DisplayAgentMessage[]>([])
  const [reasoning, setReasoning] = useState('')
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequenceByRun = useRef(new Map<string, number>())
  const sessionIdRef = useRef<string | null>(null)

  const applyEvent = useCallback((event: AgentEvent) => {
    const lastSequence = sequenceByRun.current.get(event.runId) ?? 0
    if (event.seq <= lastSequence) return
    sequenceByRun.current.set(event.runId, event.seq)

    if (event.type === 'run.accepted' || event.type === 'run.started') {
      setActiveRunId(event.runId)
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status: 'running' }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status: 'running' }
        : current)
      return
    }
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') setReasoning((current) => current + delta)
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
      setMessages((current) => current.map((message) => message.id === `stream-${event.runId}`
        ? { ...message, content: typeof content === 'string' ? content : message.content, streaming: false }
        : message))
      return
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      setActiveRunId((current) => current === event.runId ? null : current)
      const status = event.type === 'run.interrupted' ? 'interrupted' : 'idle'
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, status, updatedAt: event.occurredAt }
        : session))
      setCurrentSession((current) => current?.id === event.sessionId
        ? { ...current, status, updatedAt: event.occurredAt }
        : current)
      if (event.type === 'run.failed') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : 'Agent 运行失败。')
      }
    }
  }, [])

  const hydrateSnapshot = useCallback(async (
    snapshot: AgentSessionSnapshot,
    pendingMessages: DisplayAgentMessage[] = [],
  ) => {
    sequenceByRun.current.clear()
    setReasoning('')
    setMessages(mergePendingAgentMessages(snapshot.messages, pendingMessages))
    setActiveRunId(snapshot.activeRun?.id ?? null)
    setSessionId(snapshot.session.id)
    setCurrentSession(snapshot.session)
    setSessions((current) => current.some((session) => session.id === snapshot.session.id)
      ? current.map((session) => session.id === snapshot.session.id ? snapshot.session : session)
      : [snapshot.session, ...current])
    sessionIdRef.current = snapshot.session.id
    if (snapshot.activeRun && api) {
      const events = await api.getEvents(snapshot.session.id, snapshot.activeRun.id, 0)
      for (const event of events) applyEvent(event)
    }
  }, [api, applyEvent])

  const selectSession = useCallback(async (
    session: AgentSession,
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<void> => {
    if (!api) return
    setLoading(true)
    setConnected(false)
    setError(null)
    try {
      await api.unsubscribe()
      const snapshot = await api.getSession(session.id)
      await hydrateSnapshot(snapshot, pendingMessages)
      storeSession(pageLabel, roomId, session.id)
      await api.subscribe(session.id)
    } catch {
    } finally {
      setLoading(false)
    }
  }, [api, hydrateSnapshot, pageLabel, roomId])

  useEffect(() => {
    let alive = true
    setMessages([])
    setReasoning('')
    setActiveRunId(null)
    setSessionId(null)
    setSessions([])
    setCurrentSession(null)
    sessionIdRef.current = null
    sequenceByRun.current.clear()
    setConnected(false)
    setError(null)

    if (api) {
      setLoading(true)
      void api.listSessions(pageLabel, roomId)
        .then(async (listedSessions) => {
          if (!alive) return
          setSessions(listedSessions)
          const storedSessionId = readStoredSession(pageLabel, roomId)
          const selected = listedSessions.find((session) => session.id === storedSessionId)
            ?? listedSessions[0]
          if (selected) await selectSession(selected)
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false)
        })
    }

    const removeListener = api?.onEvent((frame) => {
      const frameSessionId = frame.type === 'ready' ? frame.sessionId : frame.event.sessionId
      if (!alive || frameSessionId !== sessionIdRef.current) return
      if (frame.type === 'ready') {
        setConnected(true)
        if (frame.lastEventSeq > 0) {
          void api.getSession(frame.sessionId).then(hydrateSnapshot).catch(() => undefined)
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
  }, [api, applyEvent, hydrateSnapshot, pageLabel, roomId, selectSession])

  const createSession = async (
    pendingMessages: DisplayAgentMessage[] = [],
  ): Promise<AgentSession> => {
    if (!api) throw new Error('Agent 服务仅在桌面应用中可用。')
    if (activeRunId) throw new Error('请先停止当前运行，再新建会话。')
    try {
      const session = await api.createSession({ pageLabel, roomId })
      setSessions((current) => [session, ...current])
      await selectSession(session, pendingMessages)
      return session
    } catch (createError) {
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
    } catch {
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
          setMessages([])
          setReasoning('')
          setConnected(false)
          storeSession(pageLabel, roomId, null)
        }
      }
    } catch {
    }
  }

  const sendPrompt = async (prompt: string): Promise<void> => {
    const message = prompt.trim()
    if (!message || activeRunId || loading || sending) return
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
    setReasoning('')
    try {
      const currentSessionId = await ensureSession([optimisticMessage])
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, sessionId: currentSessionId }
        : item))
      const run = await api!.startRun(currentSessionId, {
        prompt: message,
        idempotencyKey: crypto.randomUUID(),
      })
      const updatedAt = new Date().toISOString()
      setSessions((current) => current.map((session) => session.id === currentSessionId
        ? { ...session, title: session.title ?? message.slice(0, 48), status: 'running', updatedAt }
        : session))
      setCurrentSession((current) => current?.id === currentSessionId
        ? { ...current, title: current.title ?? message.slice(0, 48), status: 'running', updatedAt }
        : current)
      setActiveRunId(run.id)
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, runId: run.id }
        : item))
    } catch {
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!api || !activeRunId) return
    try {
      await api.cancelRun(activeRunId)
    } catch {
    }
  }

  return {
    activeRunId,
    connected,
    createSession,
    currentSession,
    deleteSession,
    error,
    loading: loading || sending,
    messages,
    reasoning,
    renameSession,
    selectSession,
    sendPrompt,
    sessionId,
    sessions,
    stop,
  }
}
