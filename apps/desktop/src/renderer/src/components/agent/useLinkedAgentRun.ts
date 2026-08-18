import type {
  AgentEvent,
  AgentRunStatus,
  AgentSessionLink,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import { useEffect, useRef, useState } from 'react'

import {
  reduceAgentRunActivity,
  reduceAgentRunEvents,
  type AgentRunActivity,
  type DisplayAgentToolCall,
} from './agentRunActivity'
import type { DisplayAgentMessage } from './useAgentSession'
import { useRoomDocumentsState } from '../context-room/RoomDocumentsProvider'
import { useDocumentOperations } from '../context-room/operations'

export interface LinkedAgentRunState {
  status: AgentRunStatus | null
  messages: DisplayAgentMessage[]
  activity: AgentRunActivity
  reasoning: string
  tools: DisplayAgentToolCall[]
  startedAt?: string
  completedAt?: string
  error: string | null
  loading: boolean
  documentPending: boolean
}

const EMPTY_STATE: LinkedAgentRunState = {
  status: null,
  messages: [],
  activity: { steps: [], pendingAnswer: '', finalAnswer: '', hasTools: false, completed: false },
  reasoning: '',
  tools: [],
  error: null,
  loading: false,
  documentPending: false,
}

const TERMINAL_EVENT_STATUS: Partial<Record<AgentEvent['type'], AgentRunStatus>> = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.interrupted': 'interrupted',
}

function terminalStatus(events: AgentEvent[]): AgentRunStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const status = TERMINAL_EVENT_STATUS[events[index]!.type]
    if (status) return status
  }
  return null
}

function eventError(events: AgentEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'run.failed' && event.type !== 'run.interrupted') continue
    const message = (event.payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return null
}

export function buildLinkedAgentRunState(
  snapshot: AgentSessionSnapshot,
  runId: string,
  events: AgentEvent[],
  documentPending = false,
): LinkedAgentRunState {
  const reduced = reduceAgentRunEvents(events)
  const savedAnswer = snapshot.messages.find((message) => (
    message.runId === runId && message.role === 'assistant'
  ))?.content ?? ''
  const activity = reduceAgentRunActivity(events, savedAnswer)
  const activeRun = snapshot.activeRun?.id === runId ? snapshot.activeRun : null
  const runStatus = terminalStatus(events) ?? activeRun?.status ?? null
  const status = documentPending && (runStatus === null || runStatus === 'completed') ? 'running' : runStatus
  const messages: DisplayAgentMessage[] = snapshot.messages.filter((message) => (
    message.runId === runId && (!documentPending || message.role !== 'assistant')
  ))
  const hasAssistantMessage = messages.some((message) => message.role === 'assistant')

  if (!documentPending && !hasAssistantMessage && (reduced.messageStarted || reduced.streamingContent)) {
    messages.push({
      id: `linked-stream-${runId}`,
      sessionId: snapshot.session.id,
      runId,
      role: 'assistant',
      content: reduced.streamingContent,
      createdAt: reduced.startedAt ?? activeRun?.createdAt ?? snapshot.session.updatedAt,
      streaming: !reduced.messageCompleted && (status === 'accepted' || status === 'running'),
    })
  }

  return {
    status,
    messages,
    activity,
    reasoning: reduced.reasoning,
    tools: reduced.tools,
    startedAt: reduced.startedAt ?? activeRun?.startedAt ?? undefined,
    completedAt: documentPending ? undefined : reduced.completedAt ?? activeRun?.completedAt ?? undefined,
    error: eventError(events) ?? activeRun?.error ?? null,
    loading: false,
    documentPending,
  }
}

function isTerminal(status: AgentRunStatus | null): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'interrupted'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load linked Agent progress.'
}

export function useLinkedAgentRun(link: AgentSessionLink | null): LinkedAgentRunState {
  const api = window.nxcore?.agent
  const { documentsByRoom } = useRoomDocumentsState()
  const { operations } = useDocumentOperations()
  const sourceSessionId = link?.sourceSessionId ?? null
  const sourceRunId = link?.sourceRunId ?? null
  const documentId = link?.target.objectType === 'document' ? link.target.objectId : undefined
  const document = documentId
    ? Object.values(documentsByRoom).flat().find((candidate) => candidate.id === documentId)
    : undefined
  const documentPending = Boolean(document?.activeTransactionId || (documentId && operations.some((entry) => {
    const operation = entry.summary
    const draftDocumentId = entry.detail?.input.draftDocumentId
    return operation.interactionMode === 'streaming_commit'
      && operation.runId === sourceRunId
      && (operation.documentId === documentId || draftDocumentId === documentId)
      && (operation.status === 'created' || operation.status === 'running' || operation.status === 'applying')
  })))
  const [state, setState] = useState<LinkedAgentRunState>(EMPTY_STATE)
  const stateRunKeyRef = useRef<string | null>(null)
  const documentPendingRef = useRef(documentPending)
  const linkedDataRef = useRef<{
    runKey: string
    snapshot: AgentSessionSnapshot
    events: AgentEvent[]
  } | null>(null)
  documentPendingRef.current = documentPending

  useEffect(() => {
    const linkedData = linkedDataRef.current
    if (!sourceSessionId || !sourceRunId) return
    if (!linkedData || linkedData.runKey !== `${sourceSessionId}:${sourceRunId}`) return
    setState(buildLinkedAgentRunState(
      linkedData.snapshot,
      sourceRunId,
      linkedData.events,
      documentPending,
    ))
  }, [documentPending, sourceRunId, sourceSessionId])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let afterSeq = 0
    const events: AgentEvent[] = []

    if (!api || !sourceSessionId || !sourceRunId) {
      stateRunKeyRef.current = null
      linkedDataRef.current = null
      setState(EMPTY_STATE)
      return
    }

    const runKey = `${sourceSessionId}:${sourceRunId}`
    if (stateRunKeyRef.current !== runKey) {
      stateRunKeyRef.current = runKey
      linkedDataRef.current = null
      setState({ ...EMPTY_STATE, loading: true })
    }

    const poll = async (): Promise<void> => {
      try {
        const [snapshot, nextEvents] = await Promise.all([
          api.getSession(sourceSessionId),
          api.getEvents(sourceSessionId, sourceRunId, afterSeq),
        ])
        if (cancelled) return

        events.push(...nextEvents)
        linkedDataRef.current = { runKey, snapshot, events: [...events] }
        const nextState = buildLinkedAgentRunState(snapshot, sourceRunId, events, documentPendingRef.current)
        afterSeq = Math.max(afterSeq, ...nextEvents.map((event) => event.seq))
        setState(nextState)
        if (isTerminal(nextState.status)) return
      } catch (error) {
        if (cancelled) return
        setState((current) => ({ ...current, error: errorMessage(error), loading: false }))
      }

      timer = globalThis.setTimeout(poll, 1_000)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) globalThis.clearTimeout(timer)
    }
  }, [api, sourceRunId, sourceSessionId])

  return state
}
