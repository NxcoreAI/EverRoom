import i18n from '@/i18n/i18next'
import type { AppLocale } from '@/i18n/LocaleContext'
import type {
  DocumentContinuationCandidate,
  DocumentOperationReviewView,
} from './presenterRegistry'

export function pendingContinuationBlock(
  review: DocumentOperationReviewView | null | undefined,
): DocumentContinuationCandidate | null {
  return review?.kind === 'continue' && review.status === 'awaiting_review'
    ? review.currentContinuationCandidate
    : null
}

export function pendingContinuationBlocks(
  review: DocumentOperationReviewView | null | undefined,
): DocumentContinuationCandidate[] {
  if (review?.kind !== 'continue' || review.status !== 'awaiting_review') return []
  const decided = new Set([...review.acceptedItemIds, ...review.rejectedItemIds])
  return review.continuationCandidates
    .filter((block) => !decided.has(block.blockId))
    .sort((left, right) => left.sequence - right.sequence)
}

export const CONTINUATION_GROUP_MAX_BLOCKS = 3
export const CONTINUATION_GROUP_TARGET_CHARACTERS = 140

function continuationCharacterCount(candidate: DocumentContinuationCandidate): number {
  return Array.from(candidate.textPreview).length
}

/** Groups short, adjacent candidates into one review card while preserving item order. */
export function groupContinuationCandidates(
  candidates: DocumentContinuationCandidate[],
  currentBlockId: string,
  options: {
    maxBlocks?: number
    targetCharacters?: number
  } = {},
): DocumentContinuationCandidate[] {
  const maxBlocks = Math.max(1, options.maxBlocks ?? CONTINUATION_GROUP_MAX_BLOCKS)
  const targetCharacters = Math.max(1, options.targetCharacters ?? CONTINUATION_GROUP_TARGET_CHARACTERS)
  const start = candidates.findIndex((candidate) => candidate.blockId === currentBlockId)
  if (start < 0) return []
  const first = candidates[start]
  const group = [first]
  let characters = continuationCharacterCount(first)
  if (characters >= targetCharacters) return group
  for (let index = start + 1; index < candidates.length && group.length < maxBlocks; index += 1) {
    const candidate = candidates[index]
    group.push(candidate)
    characters += continuationCharacterCount(candidate)
    if (characters >= targetCharacters) break
  }
  return group
}

export function shouldHandleContinuationTab(input: {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  candidateVisible: boolean
  busy: boolean
}): boolean {
  return input.key === 'Tab'
    && !input.altKey
    && !input.ctrlKey
    && !input.metaKey
    && !input.shiftKey
    && input.candidateVisible
    && !input.busy
}

export function continuationRevealScrollTop({
  scrollTop,
  scrollHeight,
  clientHeight,
  candidateTop,
  candidateBottom,
  padding = 24,
}: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  candidateTop: number
  candidateBottom: number
  padding?: number
}): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  const availableHeight = Math.max(0, clientHeight - padding * 2)
  const candidateHeight = Math.max(0, candidateBottom - candidateTop)
  let nextScrollTop = scrollTop

  if (candidateHeight > availableHeight || candidateTop < scrollTop + padding) {
    nextScrollTop = candidateTop - padding
  } else if (candidateBottom > scrollTop + clientHeight - padding) {
    nextScrollTop = candidateBottom + padding - clientHeight
  }

  return Math.min(maxScrollTop, Math.max(0, nextScrollTop))
}

export function buildContinuationRevisionPrompt(input: {
  documentTitle: string
  previousSummary: string
  rejectedText: string
  feedback: string
}, locale: AppLocale = 'zh-CN'): string {
  const t = i18n.getFixedT(locale, 'common')
  const feedback = input.feedback.trim()
    || t('contextRoom:documentContinuation.defaultRevisionFeedback')
  return [
    t('contextRoom:documentContinuation.revisionContext', { title: input.documentTitle }),
    t('contextRoom:documentContinuation.revisionInstruction'),
    input.previousSummary.trim()
      ? t('contextRoom:documentContinuation.previousGoal', { summary: input.previousSummary.trim() })
      : '',
    t('contextRoom:documentContinuation.rejectedCandidateLabel'),
    `<rejected_candidate>\n${input.rejectedText.trim()}\n</rejected_candidate>`,
    t('contextRoom:documentContinuation.feedbackLabel'),
    `<feedback>\n${feedback}\n</feedback>`,
  ].filter(Boolean).join('\n\n')
}
