import type { DocumentPatch } from '@nxcore/agent-contract'
import { Check, ChevronLeft, ChevronRight, LoaderCircle, X } from 'lucide-react'

import { useDocumentPatches } from './DocumentPatchProvider'
import { adjacentPatchHunkId, patchDecisionCounts } from './documentPatchState'
import './DocumentPatchReview.css'

export function DocumentPatchReviewToolbar({ patch }: { patch: DocumentPatch }) {
  const {
    applySelected,
    busyPatchIds,
    closeReview,
    currentHunkId,
    decisionsByPatchId,
    errorsByPatchId,
    rejectPatch,
    setCurrentHunkId,
    setHunkDecision,
  } = useDocumentPatches()
  const decisions = decisionsByPatchId[patch.id] ?? {}
  const counts = patchDecisionCounts(patch, decisions)
  const currentIndex = Math.max(0, patch.hunks.findIndex((hunk) => hunk.id === currentHunkId))
  const currentHunk = patch.hunks[currentIndex]
  const busy = busyPatchIds.has(patch.id)
  const actionable = patch.status === 'pending' && !busy
  const rejectable = (patch.status === 'pending' || patch.status === 'conflicted') && !busy
  const error = errorsByPatchId[patch.id]

  const move = (direction: -1 | 1) => {
    setCurrentHunkId(adjacentPatchHunkId(patch.hunks, currentHunkId, direction))
  }

  return (
    <aside className="document-patch-review-toolbar" aria-label="审阅文档改动">
      <div className="document-patch-review-progress">
        <strong>{patch.summary || 'Agent 提议的改动'}</strong>
        <span>{patch.hunks.length ? `${currentIndex + 1} / ${patch.hunks.length}` : '没有改动'}</span>
      </div>
      <div className="document-patch-review-navigation">
        <button type="button" title="上一处改动" aria-label="上一处改动" disabled={!patch.hunks.length} onClick={() => move(-1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <button type="button" title="下一处改动" aria-label="下一处改动" disabled={!patch.hunks.length} onClick={() => move(1)}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      <div className="document-patch-review-decision">
        <button
          type="button"
          className={currentHunk && decisions[currentHunk.id] === 'rejected' ? 'is-active is-rejected' : ''}
          title="拒绝当前改动"
          disabled={!actionable || !currentHunk}
          onClick={() => currentHunk && setHunkDecision(patch.id, currentHunk.id, 'rejected')}
        >
          <X aria-hidden="true" />拒绝此处
        </button>
        <button
          type="button"
          className={currentHunk && decisions[currentHunk.id] === 'accepted' ? 'is-active is-accepted' : ''}
          title="接受当前改动"
          disabled={!actionable || !currentHunk}
          onClick={() => currentHunk && setHunkDecision(patch.id, currentHunk.id, 'accepted')}
        >
          <Check aria-hidden="true" />接受此处
        </button>
      </div>
      <div className="document-patch-review-actions">
        <span>{counts.accepted} 接受 · {counts.rejected} 拒绝 · {counts.undecided} 未决定</span>
        <button type="button" disabled={!rejectable} onClick={() => void rejectPatch(patch.id)}>全部拒绝</button>
        <button
          type="button"
          className="is-primary"
          disabled={!actionable || counts.accepted === 0}
          onClick={() => void applySelected(patch.id)}
        >
          {busy ? <LoaderCircle className="document-patch-review-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
          应用已接受改动
        </button>
        <button type="button" title="关闭审阅" aria-label="关闭审阅" onClick={closeReview}>
          <X aria-hidden="true" />
        </button>
      </div>
      {patch.status === 'conflicted' ? (
        <p className="document-patch-review-error" role="alert">文档版本已经变化。请关闭审阅后让 Agent 重新生成改动。</p>
      ) : error ? <p className="document-patch-review-error" role="alert">{error.message}</p> : null}
    </aside>
  )
}
