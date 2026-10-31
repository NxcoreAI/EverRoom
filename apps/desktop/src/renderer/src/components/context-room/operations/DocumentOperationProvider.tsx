import type {
  DocumentOperation,
  DocumentOperationSummary,
  RoomDocument,
  StartDocumentOperationInput,
} from '@nxcore/agent-contract'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  mergeOperationDetail,
  mergeOperationSummary,
  setOperationDecision,
  type DocumentOperationStoreState,
} from './documentOperationState'
import { classifyDocumentOperationError } from './types'
import type {
  DocumentOperationDecision,
  DocumentOperationEntry,
  DocumentOperationListFilters,
  DocumentOperationCommandResult,
  OperationBridge,
} from './types'

const RECOVERABLE_STATUSES = [
  'created',
  'running',
  'awaiting_input',
  'awaiting_review',
  'applying',
  'conflicted',
  'failed',
] as const

export interface DocumentOperationContextValue {
  entriesById: DocumentOperationStoreState
  appliedDocumentsById: Record<string, RoomDocument>
  operations: DocumentOperationEntry[]
  presentingOperationIds: ReadonlySet<string>
  bridge: OperationBridge
  refresh(filters?: DocumentOperationListFilters): Promise<DocumentOperationSummary[]>
  start(input: StartDocumentOperationInput): Promise<DocumentOperation | null>
  load(operationId: string): Promise<DocumentOperation | null>
  setDecision(operationId: string, itemId: string, decision: DocumentOperationDecision | null): void
  execute(operationId: string, type: string, payload?: Record<string, unknown>): Promise<DocumentOperation | null>
  executeResult(
    operationId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<DocumentOperationCommandResult | null>
  setOperationPresentationPending(operationId: string, pending: boolean): void
}

const DocumentOperationContext = createContext<DocumentOperationContextValue | null>(null)

export function DocumentOperationProvider({
  children,
  operationBridge,
  onDocumentApplied,
}: {
  children: ReactNode
  operationBridge: OperationBridge
  onDocumentApplied?: (document: RoomDocument) => void
}) {
  const bridge = operationBridge
  const [entriesById, setEntriesById] = useState<DocumentOperationStoreState>({})
  const [appliedDocumentsById, setAppliedDocumentsById] = useState<Record<string, RoomDocument>>({})
  const [presentingOperationIds, setPresentingOperationIds] = useState<ReadonlySet<string>>(() => new Set())
  const entriesRef = useRef(entriesById)
  entriesRef.current = entriesById
  const loadRequests = useRef(new Map<string, Promise<DocumentOperation | null>>())
  const commandsInFlight = useRef(new Set<string>())
  const commandIds = useRef(new Map<string, string>())

  const recoverableFilters = useMemo(() => ({ statuses: [...RECOVERABLE_STATUSES] }), [])

  const refresh = useCallback(async (filters?: DocumentOperationListFilters) => {
    const summaries = await bridge.list(filters)
    setEntriesById((current) => {
      const next = { ...current }
      for (const summary of summaries) next[summary.id] = mergeOperationSummary(next[summary.id], summary)
      return next
    })
    return summaries
  }, [bridge])

  const load = useCallback((
    operationId: string,
    discoveredSummary?: DocumentOperationSummary,
  ) => {
    const existing = loadRequests.current.get(operationId)
    if (existing) return existing
    const currentEntry = entriesRef.current[operationId]
    if (currentEntry) {
      entriesRef.current = {
        ...entriesRef.current,
        [operationId]: { ...currentEntry, busy: true, error: undefined },
      }
      setEntriesById(entriesRef.current)
    }
    const operationSummary = currentEntry?.summary ?? discoveredSummary
    const request = bridge.get(operationId, operationSummary ? {
      roomId: operationSummary.roomId,
      sessionId: operationSummary.sessionId,
      runId: operationSummary.runId,
    } : undefined)
      .then((detail) => {
        if (detail) {
          entriesRef.current = {
            ...entriesRef.current,
            [operationId]: mergeOperationDetail(entriesRef.current[operationId], detail),
          }
          setEntriesById(entriesRef.current)
        }
        return detail
      })
      .catch((error: unknown) => {
        const current = entriesRef.current[operationId]
        if (current) {
          entriesRef.current = {
            ...entriesRef.current,
            [operationId]: { ...current, error: classifyDocumentOperationError(error) },
          }
          setEntriesById(entriesRef.current)
        }
        return null
      })
      .finally(() => {
        loadRequests.current.delete(operationId)
        const current = entriesRef.current[operationId]
        if (current) {
          entriesRef.current = {
            ...entriesRef.current,
            [operationId]: { ...current, busy: false },
          }
          setEntriesById(entriesRef.current)
        }
      })
    loadRequests.current.set(operationId, request)
    return request
  }, [bridge])

  const setDecision = useCallback((operationId: string, itemId: string, decision: DocumentOperationDecision | null) => {
    const current = entriesRef.current[operationId]
    if (!current) return
    entriesRef.current = {
      ...entriesRef.current,
      [operationId]: setOperationDecision(current, itemId, decision),
    }
    setEntriesById(entriesRef.current)
  }, [])

  const start = useCallback(async (input: StartDocumentOperationInput): Promise<DocumentOperation | null> => {
    if (!bridge.start) return null
    const operation = await bridge.start(input)
    entriesRef.current = {
      ...entriesRef.current,
      [operation.id]: mergeOperationDetail(entriesRef.current[operation.id], operation),
    }
    setEntriesById(entriesRef.current)
    return operation
  }, [bridge])

  const executeResult = useCallback(async (
    operationId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<DocumentOperationCommandResult | null> => {
    const entry = entriesRef.current[operationId]
    if (!entry || commandsInFlight.current.has(operationId)) return null
    commandsInFlight.current.add(operationId)
    const commandKey = JSON.stringify([operationId, type, payload ?? null])
    const commandId = commandIds.current.get(commandKey) ?? crypto.randomUUID()
    commandIds.current.set(commandKey, commandId)
    entriesRef.current = {
      ...entriesRef.current,
      [operationId]: { ...entry, busy: true, error: undefined },
    }
    setEntriesById(entriesRef.current)
    try {
      const result = await bridge.command(operationId, {
        commandId,
        expectedRevision: entry.revision,
        type,
        payload,
        context: {
          roomId: entry.summary.roomId,
          sessionId: entry.summary.sessionId,
          runId: entry.summary.runId,
        },
      })
      if (result) {
        commandIds.current.delete(commandKey)
        const merged = mergeOperationDetail(entriesRef.current[operationId], result.operation)
        entriesRef.current = { ...entriesRef.current, [operationId]: merged }
        setEntriesById(entriesRef.current)
        if (result.document) {
          onDocumentApplied?.(result.document)
          setAppliedDocumentsById((current) => {
            const previous = current[result.document!.id]
            if (previous && previous.version >= result.document!.version) return current
            return { ...current, [result.document!.id]: result.document! }
          })
        }
        return result
      }
      return null
    } catch (error) {
      const classified = classifyDocumentOperationError(error)
      const current = entriesRef.current[operationId]
      if (current) {
        entriesRef.current = {
          ...entriesRef.current,
          [operationId]: { ...current, error: classified },
        }
        setEntriesById(entriesRef.current)
      }
      if (classified.kind === 'conflict') await load(operationId)
      return null
    } finally {
      commandsInFlight.current.delete(operationId)
      const current = entriesRef.current[operationId]
      if (current) {
        entriesRef.current = {
          ...entriesRef.current,
          [operationId]: { ...current, busy: false },
        }
        setEntriesById(entriesRef.current)
      }
    }
  }, [bridge, load, onDocumentApplied])

  const execute = useCallback(async (
    operationId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<DocumentOperation | null> => {
    const result = await executeResult(operationId, type, payload)
    return result?.operation ?? null
  }, [executeResult])

  const setOperationPresentationPending = useCallback((operationId: string, pending: boolean) => {
    setPresentingOperationIds((current) => {
      if (current.has(operationId) === pending) return current
      const next = new Set(current)
      if (pending) next.add(operationId)
      else next.delete(operationId)
      return next
    })
  }, [])

  const refreshRecoverableOperations = useCallback(() => {
    return refresh(recoverableFilters).then((operations) => {
      // React state updates are asynchronous. Pass the summary directly so a
      // detail request made in this same tick still has its authorization
      // context (room/session/run).
      for (const operation of operations) void load(operation.id, operation)
    }).catch(() => undefined)
  }, [load, refresh, recoverableFilters])

  useEffect(() => {
    void refreshRecoverableOperations()
    const unsubscribeOperation = bridge.subscribe?.((operationId) => {
      const known = entriesRef.current[operationId]
      if (known) {
        void load(operationId, known.summary)
        return
      }
      // WebSocket notifications can arrive before the list response that
      // supplies the operation's authorization context. Discover the summary
      // first so the detail request never drops room/session/run identity.
      void refresh().then((summaries) => {
        const summary = summaries.find((candidate) => candidate.id === operationId)
        if (summary) return load(operationId, summary)
        return null
      }).catch(() => undefined)
    })
    const unsubscribeReady = bridge.subscribeReady?.(() => { void refreshRecoverableOperations() })
    return () => {
      unsubscribeOperation?.()
      unsubscribeReady?.()
    }
  }, [bridge, load, refreshRecoverableOperations])

  const value = useMemo<DocumentOperationContextValue>(() => ({
    entriesById,
    appliedDocumentsById,
    operations: Object.values(entriesById).sort((left, right) => right.summary.updatedAt.localeCompare(left.summary.updatedAt)),
    presentingOperationIds,
    bridge,
    refresh,
    start,
    load,
    setDecision,
    execute,
    executeResult,
    setOperationPresentationPending,
  }), [
    appliedDocumentsById,
    bridge,
    entriesById,
    execute,
    executeResult,
    load,
    presentingOperationIds,
    refresh,
    setDecision,
    setOperationPresentationPending,
    start,
  ])

  return <DocumentOperationContext.Provider value={value}>{children}</DocumentOperationContext.Provider>
}

export function useDocumentOperations(): DocumentOperationContextValue {
  const value = useContext(DocumentOperationContext)
  if (!value) throw new Error('useDocumentOperations must be used inside DocumentOperationProvider')
  return value
}
