import type { AgentEvent, AgentMessage, AgentSessionSnapshot } from '@nxcore/agent-contract'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface DisplayAgentMessage extends AgentMessage {
  streaming?: boolean
}

const SESSION_STORAGE_KEY = 'nxcore-ce:agent-sessions:v1'

function readStoredSession(pageLabel: string): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object') return null
    const sessionId = (value as Record<string, unknown>)[pageLabel]
    return typeof sessionId === 'string' ? sessionId : null
  } catch {
    return null
  }
}

function storeSession(pageLabel: string, sessionId: string | null): void {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    const sessions = value && typeof value === 'object' ? { ...value as Record<string, unknown> } : {}
    if (sessionId) sessions[pageLabel] = sessionId
    else delete sessions[pageLabel]
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // Session persistence is optional when browser storage is unavailable.
  }
}

export function useAgentSession(pageLabel: string) {
  const api = window.nxcore?.agent
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayAgentMessage[]>([])
  const [reasoning, setReasoning] = useState('')
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
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
      if (event.type === 'run.failed') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : 'Agent 运行失败。')
      }
    }
  }, [])

  const hydrateSnapshot = useCallback(async (snapshot: AgentSessionSnapshot) => {
    setMessages(snapshot.messages)
    setActiveRunId(snapshot.activeRun?.id ?? null)
    setSessionId(snapshot.session.id)
    sessionIdRef.current = snapshot.session.id
    if (snapshot.activeRun && api) {
      const events = await api.getEvents(snapshot.session.id, snapshot.activeRun.id, 0)
      for (const event of events) applyEvent(event)
    }
  }, [api, applyEvent])

  useEffect(() => {
    let alive = true
    setMessages([])
    setReasoning('')
    setActiveRunId(null)
    setSessionId(null)
    sessionIdRef.current = null
    sequenceByRun.current.clear()
    setConnected(false)
    setError(null)

    const storedSessionId = readStoredSession(pageLabel)
    if (api && storedSessionId) {
      setLoading(true)
      void api.getSession(storedSessionId)
        .then(async (snapshot) => {
          if (!alive) return
          await hydrateSnapshot(snapshot)
          if (alive) await api.subscribe(snapshot.session.id)
        })
        .catch(() => storeSession(pageLabel, null))
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
  }, [api, applyEvent, hydrateSnapshot, pageLabel])

  const ensureSession = async (): Promise<string> => {
    if (!api) throw new Error('Agent 服务仅在桌面应用中可用。')
    if (sessionIdRef.current) return sessionIdRef.current
    const session = await api.createSession({ pageLabel })
    sessionIdRef.current = session.id
    setSessionId(session.id)
    storeSession(pageLabel, session.id)
    await api.subscribe(session.id)
    return session.id
  }

  const sendPrompt = async (prompt: string): Promise<void> => {
    const message = prompt.trim()
    if (!message || activeRunId || loading) return
    setLoading(true)
    setError(null)
    setReasoning('')
    try {
      const currentSessionId = await ensureSession()
      const optimisticId = `user-${crypto.randomUUID()}`
      setMessages((current) => [...current, {
        id: optimisticId,
        sessionId: currentSessionId,
        runId: 'pending',
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      const run = await api!.startRun(currentSessionId, {
        prompt: message,
        idempotencyKey: crypto.randomUUID(),
      })
      setActiveRunId(run.id)
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, runId: run.id }
        : item))
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '无法启动 Agent。')
    } finally {
      setLoading(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!api || !activeRunId) return
    try {
      await api.cancelRun(activeRunId)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : '无法停止 Agent。')
    }
  }

  const reset = (): void => {
    void api?.unsubscribe()
    sessionIdRef.current = null
    sequenceByRun.current.clear()
    storeSession(pageLabel, null)
    setSessionId(null)
    setMessages([])
    setReasoning('')
    setActiveRunId(null)
    setConnected(false)
    setError(null)
  }

  return {
    activeRunId,
    connected,
    error,
    loading,
    messages,
    reasoning,
    reset,
    sendPrompt,
    sessionId,
    stop,
  }
}
