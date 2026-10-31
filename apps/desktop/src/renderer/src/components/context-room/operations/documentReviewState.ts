import type { DocumentOperationReviewView } from './presenterRegistry'

export type DocumentReviewDecision = 'accepted' | 'rejected'
export type DocumentReviewDecisionMap = Record<string, DocumentReviewDecision>

export function nextDocumentReviewReveal(
  revealedOperationId: string | null,
  operationId: string | null,
): { operationId: string | null; autoReveal: boolean } {
  return {
    operationId,
    autoReveal: operationId !== null && operationId !== revealedOperationId,
  }
}

export function reviewDecisionCounts(
  review: Pick<DocumentOperationReviewView, 'items'>,
  decisions: DocumentReviewDecisionMap,
): { accepted: number; rejected: number; undecided: number } {
  let accepted = 0
  let rejected = 0
  for (const item of review.items) {
    if (decisions[item.id] === 'accepted') accepted += 1
    else if (decisions[item.id] === 'rejected') rejected += 1
  }
  return { accepted, rejected, undecided: review.items.length - accepted - rejected }
}
