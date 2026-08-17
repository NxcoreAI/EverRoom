import type { DocumentPatch } from '@nxcore/agent-contract'

import { useDocumentPatches } from './DocumentPatchProvider'
import { patchDecisionCounts } from './documentPatchState'
import './DocumentPatchReview.css'

export function DocumentPatchReviewToolbar({ patch }: { patch: DocumentPatch }) {
  const {
    busyPatchIds,
    decisionsByPatchId,
    errorsByPatchId,
    rejectPatch,
  } = useDocumentPatches()
  const decisions = decisionsByPatchId[patch.id] ?? {}
  const counts = patchDecisionCounts(patch, decisions)
  const busy = busyPatchIds.has(patch.id)
  const rejectable = (patch.status === 'pending' || patch.status === 'conflicted') && !busy
  const error = errorsByPatchId[patch.id]

  return (
    <aside className="document-patch-review-toolbar" aria-label="审阅文档改动">
      <div className="document-patch-review-progress">
        <strong>{patch.summary || 'Agent 提议的改动'}</strong>
        <span>{counts.accepted} 接受 · {counts.rejected} 拒绝 · {counts.undecided} 待决定</span>
      </div>
      <div className="document-patch-review-actions">
        <button type="button" disabled={!rejectable} onClick={() => void rejectPatch(patch.id)}>关闭此次修改</button>
      </div>
      {patch.status === 'conflicted' ? (
        <p className="document-patch-review-error" role="alert">文档版本已经变化。请关闭审阅后让 Agent 重新生成改动。</p>
      ) : error ? <p className="document-patch-review-error" role="alert">{error.message}</p> : null}
    </aside>
  )
}
