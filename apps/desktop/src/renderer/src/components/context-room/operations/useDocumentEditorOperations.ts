import type { DocumentOperationStatus } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { showToast } from '../../../state/toast'
import { useLocale } from '../../../i18n/LocaleContext'

import {
  buildContinuationRevisionPrompt,
  pendingContinuationBlock,
  pendingContinuationBlocks,
} from './documentContinuationState'
import { onDocumentOperationNavigation } from './documentOperationNavigation'
import type { DocumentReviewDecision, DocumentReviewDecisionMap } from './documentReviewState'
import { useDocumentOperations } from './DocumentOperationProvider'
import { presentDocumentOperation, type DocumentContinuationCandidate, type DocumentOperationReviewView } from './presenterRegistry'
import type { DocumentOperationEntry } from './types'

export interface AtomicDiffViewModel {
  review: DocumentOperationReviewView
  decisions: DocumentReviewDecisionMap
  markdownDrafts: Record<string, string>
  currentItemId: string | null
  busy: boolean
  error: string | null
}

type DocumentContinuationDecisionMap = Record<string, 'accepted' | 'rejected' | undefined>

export interface ContinuationViewModel {
  review: DocumentOperationReviewView
  items: DocumentContinuationCandidate[]
  currentItemId: string
  decisions: DocumentContinuationDecisionMap
  markdownDrafts: Record<string, string>
  busy: boolean
  error: string | null
}

export interface StreamingDocumentChunkViewModel {
  id: string
  sequence: number
  markdown: string
}

export interface StreamingDocumentViewModel {
  operationId: string
  title: string
  status: DocumentOperationStatus
  revision: number
  chunks: StreamingDocumentChunkViewModel[]
  active: boolean
  busy: boolean
  error: string | null
}

export interface DocumentEditorOperationCommands {
  closeAtomicDiff(): void
  decideAtomicDiffItem(itemId: string, decision: DocumentReviewDecision | null): void
  updateAtomicDiffItemDraft(itemId: string, markdown: string): void
  acceptAllAtomicDiffItems(): void
  closeContinuation(): void
  decideContinuationItem(itemId: string, decision: 'accepted' | 'rejected'): void
  updateContinuationItemDraft(itemId: string, markdown: string): void
  acceptContinuationItems(itemIds: string[]): Promise<void>
  acceptAllContinuationItems(): Promise<void>
  requestContinuationRevision(itemIds: string | string[], feedback: string): Promise<void>
}

export interface DocumentEditorOperationViewModel {
  atomicDiff: AtomicDiffViewModel | null
  continuation: ContinuationViewModel | null
  streamingDocument: StreamingDocumentViewModel | null
  locked: boolean
  completionBlocked: boolean
  commands: DocumentEditorOperationCommands
}

type DocumentOperationMarkdownDraftMap = Record<string, string>

function markdownDraftKey(operationId: string, itemId: string): string {
  return `${operationId}:${itemId}`
}

function operationMarkdownDrafts(
  drafts: DocumentOperationMarkdownDraftMap,
  operationId: string | undefined,
): Record<string, string> {
  if (!operationId) return {}
  const prefix = `${operationId}:`
  return Object.fromEntries(Object.entries(drafts)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, markdown]) => [key.slice(prefix.length), markdown]))
}

const activeStreamingStatuses = new Set<DocumentOperationStatus>([
  'created',
  'running',
  'awaiting_input',
  'applying',
])

const completionBlockingStatuses = new Set<DocumentOperationStatus>([
  'created',
  'running',
  'awaiting_input',
  'awaiting_review',
  'applying',
  'conflicted',
])

const terminalAgentRunEvents = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
])

async function waitForContinuationSourceRun(
  api: NonNullable<typeof window.nxcore>['agent'],
  sessionId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  let afterSeq = 0
  while (Date.now() < deadline) {
    try {
      const events = await api.getEvents(sessionId, runId, afterSeq)
      for (const event of events) afterSeq = Math.max(afterSeq, event.seq)
      if (events.some((event) => terminalAgentRunEvents.has(event.type))) return
    } catch {
      return
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80))
  }
}

function newestOperation(
  entries: DocumentOperationEntry[],
  documentId: string,
  presenterKey: 'atomic-diff' | 'continuation',
  focusedId: string | null,
): DocumentOperationEntry | undefined {
  const candidates = entries
    .filter((entry) => entry.summary.documentId === documentId
      && entry.summary.presenterKey === presenterKey
      && (entry.summary.status === 'awaiting_review' || entry.summary.status === 'conflicted'))
    .sort((left, right) => right.summary.updatedAt.localeCompare(left.summary.updatedAt))
  return candidates.find((entry) => entry.id === focusedId) ?? candidates[0]
}

function streamingDocumentId(entry: DocumentOperationEntry): string | null {
  if (entry.summary.documentId) return entry.summary.documentId
  const draftDocumentId = entry.detail?.input.draftDocumentId
  return typeof draftDocumentId === 'string' && draftDocumentId.trim() ? draftDocumentId : null
}

function newestStreamingOperation(
  entries: DocumentOperationEntry[],
  documentId: string,
): DocumentOperationEntry | undefined {
  return entries
    .filter((entry) => entry.summary.capabilityId === 'document.create'
      && entry.summary.presenterKey === 'streaming-document'
      && streamingDocumentId(entry) === documentId)
    .sort((left, right) => right.summary.updatedAt.localeCompare(left.summary.updatedAt))[0]
}

function operationDecisions(entry: DocumentOperationEntry): DocumentReviewDecisionMap {
  const detail = entry.detail
  const decisions = { ...entry.decisions } as DocumentReviewDecisionMap
  for (const item of detail?.items ?? []) {
    if (item.status === 'applied' || item.status === 'accepted') decisions[item.id] = 'accepted'
    else if (item.status === 'rejected' || item.status === 'skipped') decisions[item.id] = 'rejected'
  }
  return decisions
}

export function useDocumentEditorOperations(documentId: string): DocumentEditorOperationViewModel {
  const { locale, t } = useLocale()
  const operations = useDocumentOperations()
  const [focusedOperationId, setFocusedOperationId] = useState<string | null>(null)
  const [markdownDrafts, setMarkdownDrafts] = useState<DocumentOperationMarkdownDraftMap>({})
  const markdownDraftsRef = useRef(markdownDrafts)
  markdownDraftsRef.current = markdownDrafts

  useEffect(() => onDocumentOperationNavigation((target) => {
    if (target.documentId === documentId) setFocusedOperationId(target.operationId)
  }), [documentId])

  const { atomicEntry, continuationEntry, streamingEntry } = useMemo(() => {
    const operationEntries = operations.operations.filter((entry) => entry.detail)
    return {
      atomicEntry: newestOperation(operationEntries, documentId, 'atomic-diff', focusedOperationId),
      continuationEntry: newestOperation(operationEntries, documentId, 'continuation', focusedOperationId),
      streamingEntry: newestStreamingOperation(operationEntries, documentId),
    }
  }, [documentId, focusedOperationId, operations.operations])

  useEffect(() => {
    if (!focusedOperationId) return
    const focused = operations.entriesById[focusedOperationId]
    if (!focused || (focused.summary.status !== 'awaiting_review' && focused.summary.status !== 'conflicted')) {
      setFocusedOperationId(null)
    }
  }, [focusedOperationId, operations.entriesById])
  const atomicReview = useMemo(
    () => presentDocumentOperation<DocumentOperationReviewView>(atomicEntry, 'atomic-diff') ?? undefined,
    [atomicEntry],
  )
  // 审阅期硬锁（summary 级，不吃 detail 加载延迟）：该文档有 awaiting_review 提案
  // 即锁编辑——防止用户编辑/保存把提案挤成 conflicted（2026-09-03 用户决策）。
  const reviewPending = operations.operations.some((entry) =>
    entry.summary.documentId === documentId && entry.summary.status === 'awaiting_review')
  const continuationReview = useMemo(
    () => presentDocumentOperation<DocumentOperationReviewView>(continuationEntry, 'continuation') ?? undefined,
    [continuationEntry],
  )
  const continuationItem = pendingContinuationBlock(continuationReview)
  const completionBlocked = operations.operations.some((entry) => entry.summary.documentId === documentId
    && completionBlockingStatuses.has(entry.summary.status))

  const updateMarkdownDraft = useCallback((operationId: string, itemId: string, markdown: string) => {
    const key = markdownDraftKey(operationId, itemId)
    const current = markdownDraftsRef.current
    if (current[key] === markdown) return
    const next = { ...current, [key]: markdown }
    markdownDraftsRef.current = next
    setMarkdownDrafts(next)
  }, [])

  const updateAtomicDiffItemDraft = useCallback((itemId: string, markdown: string) => {
    if (!atomicEntry || !atomicReview?.items.some((item) => item.id === itemId && item.operation !== 'delete')) return
    updateMarkdownDraft(atomicEntry.id, itemId, markdown)
  }, [atomicEntry, atomicReview, updateMarkdownDraft])

  const updateContinuationItemDraft = useCallback((itemId: string, markdown: string) => {
    if (!continuationEntry) return
    updateMarkdownDraft(continuationEntry.id, itemId, markdown)
  }, [continuationEntry, updateMarkdownDraft])

  const closeAtomicDiff = useCallback(() => {
    if (!atomicEntry) return
    void operations.execute(
      atomicEntry.id,
      atomicEntry.summary.status === 'conflicted' ? 'operation.cancel' : 'review.reject',
    )
  }, [atomicEntry, operations])

  const decideAtomicDiffItem = useCallback((itemId: string, decision: DocumentReviewDecision | null) => {
    if (!atomicReview) return
    if (!atomicEntry) return
    operations.setDecision(atomicEntry.id, itemId, decision)
    const next = { ...atomicEntry.decisions }
    if (decision) next[itemId] = decision
    else delete next[itemId]
    if (!atomicReview.items.every((item) => next[item.id])) return
    const acceptedItemIds = atomicReview.items
      .filter((item) => next[item.id] === 'accepted')
      .map((item) => item.id)
    const replacementMarkdownByItemId = Object.fromEntries(atomicReview.items
      .filter((item) => item.operation !== 'delete' && acceptedItemIds.includes(item.id))
      .flatMap((item) => {
        const draft = markdownDraftsRef.current[markdownDraftKey(atomicEntry.id, item.id)]
        return draft === undefined ? [] : [[item.id, draft]]
      }))
    void operations.execute(
      atomicEntry.id,
      acceptedItemIds.length ? 'review.apply' : 'review.reject',
      acceptedItemIds.length ? { acceptedItemIds, replacementMarkdownByItemId } : undefined,
    )
  }, [atomicEntry, atomicReview, operations])

  const acceptAllAtomicDiffItems = useCallback(() => {
    if (!atomicReview) return
    if (!atomicEntry) return
    const acceptedItemIds = atomicReview.items.map((item) => item.id)
    const replacementMarkdownByItemId = Object.fromEntries(atomicReview.items
      .filter((item) => item.operation !== 'delete')
      .flatMap((item) => {
        const draft = markdownDraftsRef.current[markdownDraftKey(atomicEntry.id, item.id)]
        return draft === undefined ? [] : [[item.id, draft]]
      }))
    for (const itemId of acceptedItemIds) operations.setDecision(atomicEntry.id, itemId, 'accepted')
    void operations.execute(atomicEntry.id, 'review.apply', { acceptedItemIds, replacementMarkdownByItemId })
  }, [atomicEntry, atomicReview, operations])

  const decideContinuationItem = useCallback((itemId: string, decision: 'accepted' | 'rejected') => {
    if (!continuationReview) return
    if (!continuationEntry) return
    const block = continuationReview.continuationCandidates.find((candidate) => candidate.blockId === itemId)
    if (!block) return
    const replacementMarkdown = markdownDraftsRef.current[markdownDraftKey(continuationEntry.id, itemId)]
    operations.setDecision(continuationEntry.id, itemId, decision)
    void operations.execute(
      continuationEntry.id,
      decision === 'accepted' ? 'item.accept' : 'item.reject',
      decision === 'accepted' && replacementMarkdown !== undefined
        ? { itemId, replacementMarkdown }
        : { itemId },
    )
  }, [continuationEntry, continuationReview, operations])

  const acceptContinuationItems = useCallback(async (itemIds: string[]) => {
    if (!continuationReview) return
    if (!continuationEntry) return
    const requested = new Set(itemIds)
    const blocks = pendingContinuationBlocks(continuationReview)
      .filter((block) => requested.has(block.blockId))
    for (const block of blocks) {
      operations.setDecision(continuationEntry.id, block.blockId, 'accepted')
      const replacementMarkdown = markdownDraftsRef.current[markdownDraftKey(continuationEntry.id, block.blockId)]
      const payload = replacementMarkdown === undefined
        ? { itemId: block.blockId }
        : { itemId: block.blockId, replacementMarkdown }
      const updated = await operations.execute(continuationEntry.id, 'item.accept', payload)
      if (!updated) break
    }
  }, [continuationEntry, continuationReview, operations])

  const acceptAllContinuationItems = useCallback(async () => {
    if (!continuationReview) return
    await acceptContinuationItems(
      pendingContinuationBlocks(continuationReview).map((block) => block.blockId),
    )
  }, [acceptContinuationItems, continuationReview])

  const requestContinuationRevision = useCallback(async (requestedItemIds: string | string[], feedback: string) => {
    if (!continuationReview || !continuationEntry) return
    const itemIds = Array.isArray(requestedItemIds) ? requestedItemIds : [requestedItemIds]
    const current = pendingContinuationBlock(continuationReview)
    const normalizedFeedback = feedback.trim()
    if (!current || itemIds[0] !== current.blockId) return
    const requested = new Set(itemIds)
    const rejectedBlocks = pendingContinuationBlocks(continuationReview)
      .filter((block) => requested.has(block.blockId))
    if (!rejectedBlocks.length) return
    const rejectedText = rejectedBlocks.map((block) =>
      markdownDraftsRef.current[markdownDraftKey(continuationEntry.id, block.blockId)]
        ?? block.textPreview).join('\n\n')
    const documentId = continuationEntry.summary.documentId
    const api = window.nxcore?.agent
    if (!documentId || !api) throw new Error(t('contextRoom:useDocumentEditorOperations.continuationUnavailable'))

    const closed = await operations.execute(continuationEntry.id, 'review.close')
    if (!closed) throw new Error(t('contextRoom:useDocumentEditorOperations.unableToCloseContinuation'))
    try {
      await waitForContinuationSourceRun(
        api,
        continuationEntry.summary.sessionId,
        continuationEntry.summary.runId,
      )
      await api.startRun(continuationEntry.summary.sessionId, {
        prompt: buildContinuationRevisionPrompt({
          documentTitle: continuationEntry.summary.documentTitle,
          previousSummary: continuationReview.summary,
          rejectedText,
          feedback: normalizedFeedback,
        }, locale),
        idempotencyKey: `continuation-revision:${continuationEntry.id}:${crypto.randomUUID()}`,
        responseLanguage: locale,
        context: {
          selectedRoomId: continuationEntry.summary.roomId,
          activeDocument: {
            roomId: continuationEntry.summary.roomId,
            documentId,
            title: continuationEntry.summary.documentTitle,
            version: closed.baseVersion ?? continuationReview.baseVersion,
            defaultAnchor: 'end',
          },
        },
      })
      showToast({ title: t('contextRoom:useDocumentEditorOperations.agentIsRevisingTheContinuation'), message: t('contextRoom:useDocumentEditorOperations.yourFeedbackHasBeenIncluded') })
    } catch (error) {
      showToast({
        title: t('contextRoom:useDocumentEditorOperations.unableToReviseTheContinuation'),
        message: error instanceof Error ? error.message : t('contextRoom:useDocumentEditorOperations.tryAgainLater'),
      })
      throw error
    }
  }, [continuationEntry, continuationReview, locale, operations, t])

  const closeContinuation = useCallback(() => {
    if (continuationEntry) void operations.execute(continuationEntry.id, 'review.close')
  }, [continuationEntry, operations])

  return useMemo(() => {
    const atomicDecisions = atomicEntry ? operationDecisions(atomicEntry) : {}
    const continuationDecisions = continuationEntry ? operationDecisions(continuationEntry) : {}
    const atomicMarkdownDrafts = operationMarkdownDrafts(markdownDrafts, atomicEntry?.id)
    const continuationMarkdownDrafts = operationMarkdownDrafts(markdownDrafts, continuationEntry?.id)
    const atomicDiff = atomicReview ? {
      review: atomicReview,
      decisions: atomicDecisions,
      markdownDrafts: atomicMarkdownDrafts,
      currentItemId: atomicReview.items.find((item) => !atomicDecisions[item.id])?.id ?? atomicReview.items[0]?.id ?? null,
      busy: atomicEntry?.busy ?? false,
      error: atomicEntry?.error ? t(atomicEntry.error.messageKey) : null,
    } : null
    const continuation = continuationReview && continuationItem ? {
      review: continuationReview,
      items: pendingContinuationBlocks(continuationReview),
      currentItemId: continuationItem.blockId,
      decisions: continuationDecisions,
      markdownDrafts: continuationMarkdownDrafts,
      busy: continuationEntry?.busy ?? false,
      error: continuationEntry?.error ? t(continuationEntry.error.messageKey) : null,
    } : null
    const streamingDocument = streamingEntry?.detail ? {
      operationId: streamingEntry.id,
      title: streamingEntry.summary.documentTitle,
      status: streamingEntry.summary.status,
      revision: streamingEntry.revision,
      chunks: streamingEntry.detail.items
        .filter((item) => item.operation === 'stream_chunk')
        .sort((left, right) => left.sequence - right.sequence)
        .map((item) => ({ id: item.id, sequence: item.sequence, markdown: item.markdown })),
      active: activeStreamingStatuses.has(streamingEntry.summary.status),
      busy: streamingEntry.busy,
      error: streamingEntry.error ? t(streamingEntry.error.messageKey) : null,
    } : null
    return {
      atomicDiff,
      continuation,
      streamingDocument,
      locked: Boolean(atomicDiff || continuation || streamingDocument?.active || reviewPending),
      completionBlocked,
      commands: {
        closeAtomicDiff,
        decideAtomicDiffItem,
        updateAtomicDiffItemDraft,
        acceptAllAtomicDiffItems,
        closeContinuation,
        decideContinuationItem,
        updateContinuationItemDraft,
        acceptContinuationItems,
        acceptAllContinuationItems,
        requestContinuationRevision,
      },
    }
  }, [
    acceptAllAtomicDiffItems,
    acceptContinuationItems,
    acceptAllContinuationItems,
    atomicEntry,
    atomicReview,
    closeAtomicDiff,
    closeContinuation,
    completionBlocked,
    continuationEntry,
    continuationItem,
    continuationReview,
    decideAtomicDiffItem,
    decideContinuationItem,
    markdownDrafts,
    requestContinuationRevision,
    streamingEntry,
    t,
    updateAtomicDiffItemDraft,
    updateContinuationItemDraft,
  ])
}
