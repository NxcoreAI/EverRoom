import { LoaderCircle, X } from 'lucide-react'

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
  return (
    <aside className="document-continuation-toolbar" aria-label="Agent 续写">
      <span>Agent 续写</span>
      {error ? <small role="alert">{error}</small> : null}
      <button type="button" disabled={busy} onClick={onClose}>
        {busy ? <LoaderCircle className="document-patch-review-spinner" aria-hidden="true" /> : <X aria-hidden="true" />}
        关闭此次续写
      </button>
    </aside>
  )
}
