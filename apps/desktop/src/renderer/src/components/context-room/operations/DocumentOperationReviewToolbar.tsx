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
    <aside className="document-patch-review-toolbar" aria-label={t('审阅文档改动')}>
      <div className="document-patch-review-progress">
        <strong>{review.summary || t('Agent 提议的改动')}</strong>
        <span>{t('{accepted} 接受 · {rejected} 拒绝 · {undecided} 待决定', counts)}</span>
      </div>
      <div className="document-patch-review-actions">
        <button type="button" disabled={!rejectable} onClick={onClose}>{t('关闭此次修改')}</button>
      </div>
      {review.status === 'conflicted' ? (
        <p className="document-patch-review-error" role="alert">{t('文档版本已经变化。请关闭审阅后让 Agent 重新生成改动。')}</p>
      ) : error ? <p className="document-patch-review-error" role="alert">{error}</p> : null}
    </aside>
  )
}
