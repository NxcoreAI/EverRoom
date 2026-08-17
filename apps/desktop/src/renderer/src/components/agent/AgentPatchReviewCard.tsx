import type { DocumentPatchStatus, DocumentPatchSummary } from '@nxcore/agent-contract'
import { AlertTriangle, Check, ChevronRight, FileDiff, RotateCcw, X } from 'lucide-react'
import { useEffect } from 'react'

import { useDocumentPatches } from '../context-room/patches/DocumentPatchProvider'
import './AgentPatchReviewCard.css'

const statusCopy: Record<DocumentPatchStatus, string> = {
  building: '正在生成改动',
  pending: '等待审阅',
  applied: '已应用',
  rejected: '已拒绝',
  conflicted: '文档已更新，改动存在冲突',
  aborted: '生成已中止',
  expired: '改动已过期',
}

export function shouldShowAgentPatchReviewCard(
  patch: DocumentPatchSummary | null | undefined,
): patch is DocumentPatchSummary {
  return Boolean(patch && patch.kind !== 'continue')
}

export function AgentPatchReviewCard({
  patchId,
  onOpenDocument,
  onRetry,
}: {
  patchId: string
  onOpenDocument?: (target: { roomId: string; documentId: string; patchId: string }) => void
  onRetry?: (patchId: string) => void
}) {
  const {
    patchesById,
    busyPatchIds,
    errorsByPatchId,
    loadPatch,
    openReview,
    rejectPatch,
  } = useDocumentPatches()
  const patch = patchesById[patchId]
  const busy = busyPatchIds.has(patchId)
  const error = errorsByPatchId[patchId]

  useEffect(() => {
    void loadPatch(patchId)
  }, [loadPatch, patchId])

  if (!shouldShowAgentPatchReviewCard(patch)) return null

  const open = () => {
    void openReview(patchId)
    if (patch) onOpenDocument?.({ roomId: patch.roomId, documentId: patch.documentId, patchId })
  }

  const reviewable = patch.status === 'pending' || patch.status === 'conflicted'

  return (
    <section className="agent-patch-card" data-status={patch.status} aria-label={`文档改动：${patch.documentTitle}`}>
      <header>
        <span className="agent-patch-card-icon" aria-hidden="true">
          {patch.status === 'conflicted' ? <AlertTriangle /> : patch.status === 'applied' ? <Check /> : <FileDiff />}
        </span>
        <span className="agent-patch-card-title">
          <strong>{patch.documentTitle}</strong>
          <small>{statusCopy[patch.status]}</small>
        </span>
      </header>
      {patch.summary ? <p>{patch.summary}</p> : null}
      <div className="agent-patch-card-stats" aria-label="改动统计">
        <span>{patch.hunkCount} 处改动</span>
        <span className="is-added">+{patch.addedCharacters}</span>
        <span className="is-deleted">-{patch.deletedCharacters}</span>
      </div>
      {error ? <div className="agent-patch-card-error" role="alert">{error.message}</div> : null}
      <footer>
        {patch.status === 'conflicted' && onRetry ? (
          <button type="button" disabled={busy} onClick={() => onRetry(patchId)}>
            <RotateCcw aria-hidden="true" />重新生成
          </button>
        ) : null}
        {patch.status === 'pending' || patch.status === 'conflicted' ? (
          <button type="button" className="is-secondary" disabled={busy} onClick={() => void rejectPatch(patchId)}>
            <X aria-hidden="true" />拒绝
          </button>
        ) : null}
        {reviewable ? (
          <button type="button" className="is-primary" disabled={busy} onClick={open}>
            查看改动<ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </footer>
    </section>
  )
}
