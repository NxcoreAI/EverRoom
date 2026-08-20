import { LoaderCircle, X } from 'lucide-react'
import { useLocale } from '../../../i18n/LocaleContext'

import './DocumentOperationReview.css'

export function DocumentContinuationToolbar({
  busy,
  error,
  onClose,
}: {
  busy: boolean
  error?: string | null
  onClose: () => void
}) {
  const { t } = useLocale()
  return (
    <aside className="document-continuation-toolbar" aria-label={t('contextRoom:documentContinuationToolbar.agentContinuation')}>
      <span>{t('contextRoom:documentContinuationToolbar.agentContinuation')}</span>
      {error ? <small role="alert">{error}</small> : null}
      <button type="button" disabled={busy} onClick={onClose}>
        {busy ? <LoaderCircle className="document-patch-review-spinner" aria-hidden="true" /> : <X aria-hidden="true" />}
        {t('contextRoom:documentContinuationToolbar.closeThisContinuation')}
      </button>
    </aside>
  )
}
