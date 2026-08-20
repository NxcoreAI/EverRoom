import type { DocumentOperationReviewView } from './presenterRegistry'
import { useLocale } from '../../../i18n/LocaleContext'
import { reviewDecisionCounts } from './documentReviewState'
import type { DocumentReviewDecisionMap } from './documentReviewState'
import './DocumentOperationReview.css'

export function DocumentOperationReviewToolbar({
  review,
  decisions,
  busy,
  error,
  onClose,
}: {
  review: DocumentOperationReviewView
  decisions: DocumentReviewDecisionMap
  busy: boolean
  error?: string | null
  onClose: () => void
}) {
  const { t } = useLocale()
  const counts = reviewDecisionCounts(review, decisions)
  const rejectable = (review.status === 'awaiting_review' || review.status === 'conflicted') && !busy

  return (
    <aside className="document-patch-review-toolbar" aria-label={t('contextRoom:documentOperationReviewToolbar.reviewDocumentChanges')}>
      <div className="document-patch-review-progress">
        <strong>{review.summary || t('contextRoom:documentOperationReviewToolbar.changesProposedByAgent')}</strong>
        <span>{t('contextRoom:documentOperationReviewToolbar.acceptedAcceptedRejectedRejectedUndecidedUndecided', counts)}</span>
      </div>
      <div className="document-patch-review-actions">
        <button type="button" disabled={!rejectable} onClick={onClose}>{t('contextRoom:documentOperationReviewToolbar.closeTheseChanges')}</button>
      </div>
      {review.status === 'conflicted' ? (
        <p className="document-patch-review-error" role="alert">{t('contextRoom:documentOperationReviewToolbar.theDocumentVersionHasChangedCloseTheReview')}</p>
      ) : error ? <p className="document-patch-review-error" role="alert">{error}</p> : null}
    </aside>
  )
}
