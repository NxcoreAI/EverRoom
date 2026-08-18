import type {
  DocumentMutationOperation,
  DocumentMutationTarget,
  DocumentOperation,
  DocumentOperationStatus,
  TiptapJsonContent,
} from '@nxcore/agent-contract'

import type { DocumentOperationEntry } from './types'

export type DocumentOperationPresenterKey =
  | 'atomic-diff'
  | 'continuation'
  | 'selection-rewrite'
  | 'streaming-document'

export interface DocumentOperationPresenter<TViewModel = unknown> {
  key: DocumentOperationPresenterKey
  present(entry: DocumentOperationEntry): TViewModel | null
}

export interface DocumentReviewItem {
  id: string
  sequence: number
  operation: DocumentMutationOperation
  target: DocumentMutationTarget
  markdown: string
  before: TiptapJsonContent[]
  after: TiptapJsonContent[]
  addedCharacters: number
  deletedCharacters: number
}

export interface DocumentContinuationCandidate {
  blockId: string
  sequence: number
  target: DocumentMutationTarget
  contentJson: TiptapJsonContent
  textPreview: string
  addedCharacters: number
}

export interface DocumentOperationReviewView {
  id: string
  kind: 'edit' | 'continue'
  status: DocumentOperationStatus
  summary: string
  baseVersion: number
  appliedVersion: number | null
  items: DocumentReviewItem[]
  continuationCandidates: DocumentContinuationCandidate[]
  acceptedItemIds: string[]
  rejectedItemIds: string[]
  currentContinuationCandidate: DocumentContinuationCandidate | null
}

function reviewPresenter(
  key: 'atomic-diff' | 'continuation',
  kind: DocumentOperationReviewView['kind'],
): DocumentOperationPresenter<DocumentOperationReviewView> {
  return {
    key,
    present: (entry) => {
      if (!entry.detail || entry.detail.capabilityId !== `document.${kind === 'edit' ? 'edit' : 'continue'}`) return null
      return operationReviewView(entry.detail, kind)
    },
  }
}

function textLength(nodes: TiptapJsonContent[]): number {
  const read = (node: TiptapJsonContent): number => node.type === 'text'
    ? (node.text?.length ?? 0)
    : (node.content ?? []).reduce((total, child) => total + read(child), 0)
  return nodes.reduce((total, node) => total + read(node), 0)
}

export function operationReviewView(
  operation: DocumentOperation,
  kind: DocumentOperationReviewView['kind'],
): DocumentOperationReviewView {
  const items: DocumentReviewItem[] = operation.items
    .filter((item): item is typeof item & { operation: 'insert' | 'replace' | 'delete'; target: NonNullable<typeof item.target> } =>
      item.target !== null && (item.operation === 'insert' || item.operation === 'replace' || item.operation === 'delete'))
    .map((item) => ({
      id: item.id,
      sequence: item.sequence,
      operation: item.operation,
      target: item.target,
      markdown: item.markdown,
      before: item.before,
      after: item.after,
      addedCharacters: textLength(item.after),
      deletedCharacters: textLength(item.before),
    }))
  const continuationCandidates: DocumentContinuationCandidate[] = kind === 'continue'
    ? operation.items
        .filter((item) => item.target !== null && item.after[0])
        .map((item) => ({
          blockId: item.id,
          sequence: item.sequence,
          target: item.target!,
          contentJson: item.after[0]!,
          textPreview: item.markdown,
          addedCharacters: textLength(item.after),
        }))
    : []
  const acceptedIds = operation.items.filter((item) => item.status === 'applied').map((item) => item.id)
  const rejectedIds = operation.items.filter((item) => item.status === 'rejected' || item.status === 'skipped').map((item) => item.id)
  const pendingCandidates = continuationCandidates.filter((candidate) =>
    !acceptedIds.includes(candidate.blockId) && !rejectedIds.includes(candidate.blockId))
  return {
    id: operation.id,
    baseVersion: operation.baseVersion ?? 0,
    kind,
    status: operation.status,
    summary: operation.summary,
    items,
    continuationCandidates,
    acceptedItemIds: acceptedIds,
    rejectedItemIds: rejectedIds,
    appliedVersion: operation.items.reduce<number | null>(
      (version, item) => item.appliedVersion !== null ? Math.max(version ?? 0, item.appliedVersion) : version,
      null,
    ),
    currentContinuationCandidate: pendingCandidates[0] ?? null,
  }
}

function operationPresenter(key: 'selection-rewrite' | 'streaming-document'):
DocumentOperationPresenter<DocumentOperation> {
  return {
    key,
    present: (entry) => entry.summary.presenterKey === key ? entry.detail : null,
  }
}

export const documentOperationPresenterRegistry = new Map<DocumentOperationPresenterKey, DocumentOperationPresenter>([
  ['atomic-diff', reviewPresenter('atomic-diff', 'edit')],
  ['continuation', reviewPresenter('continuation', 'continue')],
  ['selection-rewrite', operationPresenter('selection-rewrite')],
  ['streaming-document', operationPresenter('streaming-document')],
])

export function getDocumentOperationPresenter(key: string): DocumentOperationPresenter | null {
  return documentOperationPresenterRegistry.get(key as DocumentOperationPresenterKey) ?? null
}

export function presentDocumentOperation<TViewModel = unknown>(
  entry: DocumentOperationEntry | undefined,
  key: DocumentOperationPresenterKey,
): TViewModel | null {
  if (!entry || entry.summary.presenterKey !== key) return null
  return (getDocumentOperationPresenter(key)?.present(entry) as TViewModel | null) ?? null
}
