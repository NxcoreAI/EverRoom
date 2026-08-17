import type {
  AcceptDocumentContinuationBlockInput,
  AcceptDocumentContinuationBlockResult,
  ApplyDocumentPatchInput,
  ApplyDocumentPatchResult,
  DocumentPatch,
  DocumentPatchStatus,
  DocumentPatchSummary,
  RejectDocumentContinuationBlockInput,
  RejectDocumentContinuationBlockResult,
  RoomDocument,
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
  acceptedHunkIds,
  decisionsForPatch,
  patchEventUpdate,
  setPatchHunkDecision,
  type DocumentPatchDecisionMap,
  type DocumentPatchHunkDecision,
} from './documentPatchState'
import {
  continuationBaseVersion,
  pendingContinuationBlock,
  pendingContinuationBlocks,
} from './documentContinuationState'

export type DocumentContinuationDecision = 'accepted' | 'rejected'
export type DocumentContinuationDecisionMap = Record<string, DocumentContinuationDecision | undefined>

interface PatchDocumentsBridge {
  listPatches(documentId?: string, status?: DocumentPatchStatus): Promise<DocumentPatchSummary[]>
  getPatch(patchId: string): Promise<DocumentPatch>
  applyPatch(patchId: string, input: ApplyDocumentPatchInput): Promise<ApplyDocumentPatchResult>
  rejectPatch(patchId: string): Promise<DocumentPatch>
  acceptContinuationBlock(
    patchId: string,
    input: AcceptDocumentContinuationBlockInput,
  ): Promise<AcceptDocumentContinuationBlockResult>
  rejectContinuationBlock(
    patchId: string,
    input: RejectDocumentContinuationBlockInput,
  ): Promise<RejectDocumentContinuationBlockResult>
  closeContinuation(patchId: string): Promise<DocumentPatch>
}

export type DocumentPatchActionErrorKind = 'conflict' | 'not-found' | 'network'

export interface DocumentPatchActionError {
  kind: DocumentPatchActionErrorKind
  message: string
}

export interface DocumentPatchContextValue {
  patchesById: Record<string, DocumentPatchSummary>
  fullPatchesById: Record<string, DocumentPatch>
  decisionsByPatchId: Record<string, DocumentPatchDecisionMap>
  busyPatchIds: ReadonlySet<string>
  errorsByPatchId: Record<string, DocumentPatchActionError | undefined>
  reviewPatchId: string | null
  currentHunkId: string | null
  continuationPatchIdByDocument: Record<string, string | undefined>
  continuationDecisionsByPatchId: Record<string, DocumentContinuationDecisionMap | undefined>
  refreshPatches(documentId?: string, status?: DocumentPatchStatus): Promise<DocumentPatchSummary[]>
  loadPatch(patchId: string): Promise<DocumentPatch | null>
  openReview(patchId: string): Promise<DocumentPatch | null>
  closeReview(): void
  setCurrentHunkId(hunkId: string | null): void
  setHunkDecision(patchId: string, hunkId: string, decision: DocumentPatchHunkDecision | null): void
  applySelected(patchId: string): Promise<ApplyDocumentPatchResult | null>
  rejectPatch(patchId: string): Promise<DocumentPatch | null>
  acceptContinuationBlock(patchId: string): Promise<AcceptDocumentContinuationBlockResult | null>
  acceptAllContinuationBlocks(patchId: string): Promise<DocumentPatch | null>
  rejectContinuationBlock(patchId: string): Promise<RejectDocumentContinuationBlockResult | null>
  decideContinuationBlock(
    patchId: string,
    blockId: string,
    decision: DocumentContinuationDecision,
  ): void
  closeContinuation(patchId: string): Promise<DocumentPatch | null>
  clearPatchError(patchId: string): void
}

const DocumentPatchContext = createContext<DocumentPatchContextValue | null>(null)

function patchBridge(): PatchDocumentsBridge | null {
  const documents = window.nxcore?.documents as unknown as Partial<PatchDocumentsBridge> | undefined
  return documents
    && typeof documents.listPatches === 'function'
    && typeof documents.getPatch === 'function'
    && typeof documents.applyPatch === 'function'
    && typeof documents.rejectPatch === 'function'
    ? documents as PatchDocumentsBridge
    : null
}

export function classifyDocumentPatchError(error: unknown): DocumentPatchActionError {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const response = value?.response && typeof value.response === 'object'
    ? value.response as Record<string, unknown>
    : null
  const data = response?.data && typeof response.data === 'object'
    ? response.data as Record<string, unknown>
    : null
  const status = typeof response?.status === 'number' ? response.status : null
  const code = [value?.code, data?.code, data?.error]
    .find((candidate) => typeof candidate === 'string') as string | undefined
  const rawMessage = typeof value?.message === 'string' ? value.message : ''
  const signature = `${code ?? ''} ${rawMessage}`.toUpperCase()
  if (
    status === 409
    || signature.includes('CONFLICT')
    || signature.includes('VERSION_MISMATCH')
    || signature.includes('VERSION HAS CHANGED')
    || signature.includes('版本已经变化')
    || signature.includes('版本已变化')
  ) {
    return { kind: 'conflict', message: '文档已经发生变化，当前改动不能直接应用。' }
  }
  if (status === 404 || signature.includes('NOT_FOUND') || signature.includes('NOT FOUND')) {
    return { kind: 'not-found', message: '这份改动已不可用。' }
  }
  return { kind: 'network', message: '暂时无法同步改动，请稍后重试。' }
}

function mergePatchSummaries(
  current: Record<string, DocumentPatchSummary>,
  patches: DocumentPatchSummary[],
): Record<string, DocumentPatchSummary> {
  if (patches.length === 0) return current
  const next = { ...current }
  for (const patch of patches) next[patch.id] = patch
  return next
}

export async function acceptContinuationBlocksSequentially(
  initialPatch: DocumentPatch,
  accept: (
    input: AcceptDocumentContinuationBlockInput,
  ) => Promise<AcceptDocumentContinuationBlockResult>,
  onAccepted: (result: AcceptDocumentContinuationBlockResult) => void,
): Promise<DocumentPatch> {
  let patch = initialPatch
  let block = pendingContinuationBlock(patch)
  let baseVersion = continuationBaseVersion(patch)
  while (block) {
    const result = await accept({ baseVersion, blockId: block.blockId })
    patch = result.patch
    onAccepted(result)
    baseVersion = result.document.version
    block = result.nextPendingBlock
  }
  return patch
}

export function DocumentPatchProvider({
  children,
  onDocumentApplied,
}: {
  children: ReactNode
  onDocumentApplied?: (document: RoomDocument) => void
}) {
  const [patchesById, setPatchesById] = useState<Record<string, DocumentPatchSummary>>({})
  const [fullPatchesById, setFullPatchesById] = useState<Record<string, DocumentPatch>>({})
  const [decisionsByPatchId, setDecisionsByPatchId] = useState<Record<string, DocumentPatchDecisionMap>>({})
  const [busyPatchIds, setBusyPatchIds] = useState<Set<string>>(() => new Set())
  const [errorsByPatchId, setErrorsByPatchId] = useState<Record<string, DocumentPatchActionError | undefined>>({})
  const [reviewPatchId, setReviewPatchId] = useState<string | null>(null)
  const [currentHunkId, setCurrentHunkId] = useState<string | null>(null)
  const [continuationPatchIdByDocument, setContinuationPatchIdByDocument] = useState<Record<string, string | undefined>>({})
  const [continuationDecisionsByPatchId, setContinuationDecisionsByPatchId] = useState<
    Record<string, DocumentContinuationDecisionMap | undefined>
  >({})
  const loadRequests = useRef(new Map<string, Promise<DocumentPatch | null>>())

  const clearPatchError = useCallback((patchId: string) => {
    setErrorsByPatchId((current) => current[patchId]
      ? { ...current, [patchId]: undefined }
      : current)
  }, [])

  const storePatch = useCallback((patch: DocumentPatch) => {
    setPatchesById((current) => ({ ...current, [patch.id]: patch }))
    setFullPatchesById((current) => ({ ...current, [patch.id]: patch }))
    setDecisionsByPatchId((current) => ({
      ...current,
      [patch.id]: decisionsForPatch(patch, current[patch.id]),
    }))
    setContinuationPatchIdByDocument((current) => {
      const active = pendingContinuationBlock(patch)
      if (active) return { ...current, [patch.documentId]: patch.id }
      if (current[patch.documentId] !== patch.id) return current
      const next = { ...current }
      delete next[patch.documentId]
      return next
    })
    setContinuationDecisionsByPatchId((current) => {
      const decisions = current[patch.id]
      if (!decisions) return current
      const pendingIds = new Set(pendingContinuationBlocks(patch).map((block) => block.blockId))
      const nextDecisions = Object.fromEntries(
        Object.entries(decisions).filter(([blockId]) => pendingIds.has(blockId)),
      ) as DocumentContinuationDecisionMap
      if (Object.keys(nextDecisions).length === Object.keys(decisions).length) return current
      return { ...current, [patch.id]: nextDecisions }
    })
    return patch
  }, [])

  const loadPatch = useCallback((patchId: string): Promise<DocumentPatch | null> => {
    const api = patchBridge()
    if (!api) {
      setErrorsByPatchId((current) => ({
        ...current,
        [patchId]: { kind: 'network', message: '文档改动服务不可用。' },
      }))
      return Promise.resolve(null)
    }
    const existing = loadRequests.current.get(patchId)
    if (existing) return existing
    setBusyPatchIds((current) => new Set(current).add(patchId))
    const request = api.getPatch(patchId)
      .then((patch) => {
        clearPatchError(patchId)
        return storePatch(patch)
      })
      .catch((error: unknown) => {
        setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
        return null
      })
      .finally(() => {
        loadRequests.current.delete(patchId)
        setBusyPatchIds((current) => {
          const next = new Set(current)
          next.delete(patchId)
          return next
        })
      })
    loadRequests.current.set(patchId, request)
    return request
  }, [clearPatchError, storePatch])

  const refreshPatches = useCallback(async (
    documentId?: string,
    status?: DocumentPatchStatus,
  ): Promise<DocumentPatchSummary[]> => {
    const api = patchBridge()
    if (!api) return []
    const patches = await api.listPatches(documentId, status)
    setPatchesById((current) => mergePatchSummaries(current, patches))
    return patches
  }, [])

  const openReview = useCallback(async (patchId: string) => {
    const patch = await loadPatch(patchId)
    if (!patch || patch.kind === 'continue') return patch
    setReviewPatchId(patchId)
    setCurrentHunkId(null)
    setCurrentHunkId((current) => current ?? patch?.hunks[0]?.id ?? null)
    return patch
  }, [loadPatch])

  const closeReview = useCallback(() => {
    setReviewPatchId(null)
    setCurrentHunkId(null)
  }, [])

  const setHunkDecision = useCallback((
    patchId: string,
    hunkId: string,
    decision: DocumentPatchHunkDecision | null,
  ) => {
    setDecisionsByPatchId((current) => {
      const patch = fullPatchesById[patchId]
      if (!patch || patch.status !== 'pending') return current
      return {
        ...current,
        [patchId]: setPatchHunkDecision(patch, current[patchId] ?? {}, hunkId, decision),
      }
    })
  }, [fullPatchesById])

  const applySelected = useCallback(async (patchId: string): Promise<ApplyDocumentPatchResult | null> => {
    const api = patchBridge()
    const patch = fullPatchesById[patchId]
    if (!api || !patch) return null
    const selectedIds = acceptedHunkIds(patch, decisionsByPatchId[patchId] ?? {})
    if (selectedIds.length === 0) {
      setErrorsByPatchId((current) => ({
        ...current,
        [patchId]: { kind: 'network', message: '请至少接受一处改动，或拒绝整份改动。' },
      }))
      return null
    }
    clearPatchError(patchId)
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      const result = await api.applyPatch(patchId, {
        baseVersion: patch.baseVersion,
        acceptedHunkIds: selectedIds,
      })
      storePatch(result.patch)
      onDocumentApplied?.(result.document)
      return result
    } catch (error) {
      const classified = classifyDocumentPatchError(error)
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classified }))
      if (classified.kind === 'conflict') void loadPatch(patchId)
      return null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, decisionsByPatchId, fullPatchesById, loadPatch, onDocumentApplied, storePatch])

  const rejectPatch = useCallback(async (patchId: string): Promise<DocumentPatch | null> => {
    const api = patchBridge()
    if (!api) return null
    clearPatchError(patchId)
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      return storePatch(await api.rejectPatch(patchId))
    } catch (error) {
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
      return null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, storePatch])

  const acceptContinuationBlock = useCallback(async (
    patchId: string,
  ): Promise<AcceptDocumentContinuationBlockResult | null> => {
    const api = patchBridge()
    const patch = fullPatchesById[patchId]
    const block = pendingContinuationBlock(patch)
    if (!api || typeof api.acceptContinuationBlock !== 'function' || !patch || !block) return null
    clearPatchError(patchId)
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      const result = await api.acceptContinuationBlock(patchId, {
        baseVersion: continuationBaseVersion(patch),
        blockId: block.blockId,
      })
      storePatch(result.patch)
      onDocumentApplied?.(result.document)
      return result
    } catch (error) {
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
      return null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, fullPatchesById, onDocumentApplied, storePatch])

  const closeContinuation = useCallback(async (patchId: string): Promise<DocumentPatch | null> => {
    const api = patchBridge()
    if (!api || typeof api.closeContinuation !== 'function') return null
    clearPatchError(patchId)
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      return storePatch(await api.closeContinuation(patchId))
    } catch (error) {
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
      return null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, storePatch])

  const rejectContinuationBlock = useCallback(async (
    patchId: string,
  ): Promise<RejectDocumentContinuationBlockResult | null> => {
    const api = patchBridge()
    const patch = fullPatchesById[patchId]
    const block = pendingContinuationBlock(patch)
    if (!api || typeof api.rejectContinuationBlock !== 'function' || !patch || !block) return null
    clearPatchError(patchId)
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      const result = await api.rejectContinuationBlock(patchId, {
        baseVersion: continuationBaseVersion(patch),
        blockId: block.blockId,
      })
      storePatch(result.patch)
      return result
    } catch (error) {
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
      return null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, fullPatchesById, storePatch])

  const acceptAllContinuationBlocks = useCallback(async (patchId: string): Promise<DocumentPatch | null> => {
    const api = patchBridge()
    let patch = fullPatchesById[patchId]
    if (!api || typeof api.acceptContinuationBlock !== 'function' || !patch) return null
    clearPatchError(patchId)
    setContinuationDecisionsByPatchId((current) => ({ ...current, [patchId]: {} }))
    setBusyPatchIds((current) => new Set(current).add(patchId))
    try {
      return await acceptContinuationBlocksSequentially(
        patch,
        (input) => api.acceptContinuationBlock(patchId, input),
        (result) => {
          patch = storePatch(result.patch)
          onDocumentApplied?.(result.document)
        },
      )
    } catch (error) {
      setErrorsByPatchId((current) => ({ ...current, [patchId]: classifyDocumentPatchError(error) }))
      return patch ?? null
    } finally {
      setBusyPatchIds((current) => {
        const next = new Set(current)
        next.delete(patchId)
        return next
      })
    }
  }, [clearPatchError, fullPatchesById, onDocumentApplied, storePatch])

  const decideContinuationBlock = useCallback((
    patchId: string,
    blockId: string,
    decision: DocumentContinuationDecision,
  ) => {
    const patch = fullPatchesById[patchId]
    if (!pendingContinuationBlocks(patch).some((block) => block.blockId === blockId)) return
    setContinuationDecisionsByPatchId((current) => ({
      ...current,
      [patchId]: { ...current[patchId], [blockId]: decision },
    }))
  }, [fullPatchesById])

  useEffect(() => {
    for (const [patchId, decisions] of Object.entries(continuationDecisionsByPatchId)) {
      if (!decisions || busyPatchIds.has(patchId)) continue
      const block = pendingContinuationBlock(fullPatchesById[patchId])
      if (!block) continue
      const decision = decisions[block.blockId]
      if (decision === 'accepted') void acceptContinuationBlock(patchId)
      else if (decision === 'rejected') void rejectContinuationBlock(patchId)
    }
  }, [
    acceptContinuationBlock,
    busyPatchIds,
    continuationDecisionsByPatchId,
    fullPatchesById,
    rejectContinuationBlock,
  ])

  useEffect(() => {
    const documents = window.nxcore?.documents
    if (!documents) return
    return documents.onEvent(({ event }) => {
      const update = patchEventUpdate(event)
      if (!update) return
      if (update.patch) setPatchesById((current) => ({ ...current, [update.patchId]: update.patch! }))
      if (update.document) onDocumentApplied?.(update.document)
      void loadPatch(update.patchId)
    })
  }, [loadPatch, onDocumentApplied])

  const value = useMemo<DocumentPatchContextValue>(() => ({
    patchesById,
    fullPatchesById,
    decisionsByPatchId,
    busyPatchIds,
    errorsByPatchId,
    reviewPatchId,
    currentHunkId,
    continuationPatchIdByDocument,
    continuationDecisionsByPatchId,
    refreshPatches,
    loadPatch,
    openReview,
    closeReview,
    setCurrentHunkId,
    setHunkDecision,
    applySelected,
    rejectPatch,
    acceptContinuationBlock,
    acceptAllContinuationBlocks,
    rejectContinuationBlock,
    decideContinuationBlock,
    closeContinuation,
    clearPatchError,
  }), [
    applySelected,
    acceptAllContinuationBlocks,
    acceptContinuationBlock,
    busyPatchIds,
    clearPatchError,
    closeReview,
    currentHunkId,
    continuationPatchIdByDocument,
    continuationDecisionsByPatchId,
    decisionsByPatchId,
    decideContinuationBlock,
    errorsByPatchId,
    fullPatchesById,
    loadPatch,
    openReview,
    patchesById,
    refreshPatches,
    rejectContinuationBlock,
    rejectPatch,
    closeContinuation,
    reviewPatchId,
    setHunkDecision,
  ])

  return <DocumentPatchContext.Provider value={value}>{children}</DocumentPatchContext.Provider>
}

export function useDocumentPatches(): DocumentPatchContextValue {
  const value = useContext(DocumentPatchContext)
  if (!value) throw new Error('useDocumentPatches must be used inside DocumentPatchProvider')
  return value
}
