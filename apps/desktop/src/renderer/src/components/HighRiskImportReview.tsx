import { Check, ShieldAlert, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { HighRiskImportReview as HighRiskImportReviewDto } from '../../../shared/ingest'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import './HighRiskImportReview.css'

export function HighRiskImportReview() {
  const { t } = useLocale()
  const filesApi = window.nxcore?.files
  const [reviews, setReviews] = useState<HighRiskImportReviewDto[]>([])
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!filesApi) return setReviews([])
    try {
      setReviews((await filesApi.listHighRiskReviews()).items)
    } catch {
      // The gateway can still be starting; the next change event will retry.
    }
  }, [filesApi])

  useEffect(() => {
    void refresh()
    return filesApi?.onHighRiskReviewsChanged(() => void refresh())
  }, [filesApi, refresh])

  const review = reviews[0]
  if (!review) return null

  const resolve = async (accepted: boolean) => {
    if (!filesApi || resolvingId) return
    setResolvingId(review.id)
    try {
      const result = await filesApi.resolveHighRiskReview(review.id, accepted)
      showToast(accepted
        ? {
            title: t('surface:highRiskImportReview.accepted'),
            message: t('surface:highRiskImportReview.importQueued', {
              imported: result.imported,
              failed: result.failed,
            }),
          }
        : { title: t('surface:highRiskImportReview.skipped') })
      await refresh()
    } catch (error) {
      showToast({
        title: t('surface:highRiskImportReview.failed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setResolvingId(null)
    }
  }

  return (
    <aside className="high-risk-import-review" role="region" aria-live="polite">
      <span className="high-risk-import-review-icon" aria-hidden="true"><ShieldAlert /></span>
      <div className="high-risk-import-review-copy">
        <strong>{t('surface:highRiskImportReview.title')}</strong>
        <small>{t(
          review.origin === 'auto-scan'
            ? 'surface:highRiskImportReview.autoScanMessage'
            : 'surface:highRiskImportReview.manualMessage',
          { count: review.fileCount, source: review.sourceLabel },
        )}</small>
        {reviews.length > 1
          ? <small>{t('surface:highRiskImportReview.morePending', { count: reviews.length - 1 })}</small>
          : null}
        <div className="high-risk-import-review-actions">
          <button className="high-risk-import-review-skip" type="button" disabled={Boolean(resolvingId)} onClick={() => void resolve(false)}>
            <X aria-hidden="true" />{t('surface:highRiskImportReview.skip')}
          </button>
          <button className="high-risk-import-review-accept" type="button" disabled={Boolean(resolvingId)} onClick={() => void resolve(true)}>
            <Check aria-hidden="true" />{t('surface:highRiskImportReview.accept')}
          </button>
        </div>
      </div>
    </aside>
  )
}
