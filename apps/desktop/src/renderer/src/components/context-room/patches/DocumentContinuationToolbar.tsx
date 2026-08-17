import type { DocumentPatch } from '@nxcore/agent-contract'
import { LoaderCircle, X } from 'lucide-react'

import { useDocumentPatches } from './DocumentPatchProvider'
import './DocumentPatchReview.css'

export function DocumentContinuationToolbar({ patch }: { patch: DocumentPatch }) {
  const { busyPatchIds, closeContinuation, errorsByPatchId } = useDocumentPatches()
  const busy = busyPatchIds.has(patch.id)
  const error = errorsByPatchId[patch.id]
  return (
    <aside className="document-continuation-toolbar" aria-label="Agent 续写">
      <span>Agent 续写</span>
      {error ? <small role="alert">{error.message}</small> : null}
      <button type="button" disabled={busy} onClick={() => void closeContinuation(patch.id)}>
        {busy ? <LoaderCircle className="document-patch-review-spinner" aria-hidden="true" /> : <X aria-hidden="true" />}
        关闭此次续写
      </button>
    </aside>
  )
}
