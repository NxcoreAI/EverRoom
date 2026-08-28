import type { RoomDuplicateCandidate, RoomMergeOperation, RoomMergePreview } from '@nxcore/agent-contract'
import { ArrowRight, Check, GitMerge, Loader2, RefreshCw, Split, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useLocale, type Translate } from '@/i18n/LocaleContext'
import { ReferenceDialog } from './shared'

function confidenceLabel(candidate: RoomDuplicateCandidate, t: Translate): string {
  if (candidate.confidence === 'high') return t('contextRoom:duplicateCenter.confidenceHigh')
  if (candidate.confidence === 'medium') return t('contextRoom:duplicateCenter.confidenceMedium')
  if (candidate.confidence === 'pending') return t('contextRoom:duplicateCenter.confidencePending')
  return t('contextRoom:duplicateCenter.confidenceRelated')
}

export function isMergeRecommendationCandidate(candidate: RoomDuplicateCandidate): boolean {
  return ['high', 'medium', 'pending'].includes(candidate.confidence)
}

function impactRows(preview: RoomMergePreview): Array<[string, number]> {
  return [
    ['documents', preview.impact.documents],
    ['externalSources', preview.impact.externalSources],
    ['wikiFiles', preview.impact.wikiFiles],
    ['roomMemories', preview.impact.localMemories + preview.impact.attributedMemories],
    ['agentRuns', preview.impact.agentRuns],
    ['sessionLinks', preview.impact.sessionLinks],
    ['entities', preview.impact.entities],
    ['relations', preview.impact.relations],
  ]
}

export function RoomDuplicateCenter({
  open,
  onOpenChange,
  onMerged,
  onCandidateCountChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onMerged: () => Promise<void>
  onCandidateCountChange?: (count: number) => void
}) {
  const { t } = useLocale()
  const api = window.nxcore?.contextRooms
  const [items, setItems] = useState<RoomDuplicateCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RoomDuplicateCandidate | null>(null)
  const [targetRoomId, setTargetRoomId] = useState<string>('')
  const [preview, setPreview] = useState<RoomMergePreview | null>(null)
  const [operation, setOperation] = useState<RoomMergeOperation | null>(null)

  const reload = async () => {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.listDuplicateCandidates('open')
      const candidates = result.items.filter(isMergeRecommendationCandidate)
      setItems(candidates)
      onCandidateCountChange?.(candidates.length)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:duplicateCenter.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void reload()
  }, [open])

  useEffect(() => {
    if (open) return
    // 关闭弹窗时回到列表态，避免下次打开看到上一次的合并预览残留；
    // 合并进行中（queued/running）保留进度视图，重开可继续跟踪。
    if (!operation || (operation.status !== 'queued' && operation.status !== 'running')) {
      setPreview(null)
      setSelected(null)
      setOperation(null)
      setTargetRoomId('')
    }
  }, [open, operation])

  const sourceRoomId = useMemo(() => {
    if (!selected || !targetRoomId) return ''
    return selected.roomAId === targetRoomId ? selected.roomBId : selected.roomAId
  }, [selected, targetRoomId])

  const beginPreview = async (candidate: RoomDuplicateCandidate) => {
    if (!api) return
    const target = candidate.roomAId
    setSelected(candidate)
    setTargetRoomId(target)
    setOperation(null)
    setLoading(true)
    setError(null)
    try {
      setPreview(await api.previewMerge(candidate.roomBId, target))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:duplicateCenter.previewFailed'))
    } finally {
      setLoading(false)
    }
  }

  const switchTarget = async (nextTarget: string) => {
    if (!api || !selected) return
    const source = selected.roomAId === nextTarget ? selected.roomBId : selected.roomAId
    setTargetRoomId(nextTarget)
    setLoading(true)
    setError(null)
    try {
      setPreview(await api.previewMerge(source, nextTarget))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:duplicateCenter.previewFailed'))
    } finally {
      setLoading(false)
    }
  }

  const confirmMerge = async () => {
    if (!api || !preview || !sourceRoomId || !targetRoomId) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.startMerge({
        sourceRoomId,
        targetRoomId,
        previewHash: preview.previewHash,
        idempotencyKey: crypto.randomUUID(),
      })
      setOperation(result)
      await onMerged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:duplicateCenter.startFailed'))
    } finally {
      setLoading(false)
    }
  }

  const refreshOperation = async () => {
    if (!api || !operation) return
    setLoading(true)
    try {
      const next = await api.getMergeOperation(operation.id)
      setOperation(next)
      if (next.status === 'completed') {
        await onMerged()
        await reload()
      }
    } finally {
      setLoading(false)
    }
  }

  const retryOperation = async () => {
    if (!api || !operation) return
    setLoading(true)
    try {
      setOperation(await api.retryMerge(operation.id))
    } finally {
      setLoading(false)
    }
  }

  const cancelOperation = async () => {
    if (!api || !operation || operation.commitReached) return
    setLoading(true)
    try {
      await api.cancelMerge(operation.id)
      setOperation(null)
      setPreview(null)
      setSelected(null)
      await onMerged()
      await reload()
    } finally {
      setLoading(false)
    }
  }

  const markSeparate = async (candidate: RoomDuplicateCandidate) => {
    if (!api) return
    await api.updateDuplicateCandidate(candidate.id, 'distinct')
    const candidates = items.filter((item) => item.id !== candidate.id)
    setItems(candidates)
    onCandidateCountChange?.(candidates.length)
  }

  return (
    <ReferenceDialog open={open} onOpenChange={onOpenChange} title={t('contextRoom:duplicateCenter.dialogTitle')}>
      <div className="context-room-duplicate-center">
        <header>
          <div>
            <span>{t('contextRoom:duplicateCenter.eyebrow')}</span>
            <h2>{t('contextRoom:duplicateCenter.title')}</h2>
          </div>
          <button type="button" className="context-room-icon-button" onClick={() => void reload()} title={t('contextRoom:duplicateCenter.refreshCandidates')} aria-label={t('contextRoom:duplicateCenter.refreshCandidates')} disabled={loading}>
            <RefreshCw aria-hidden="true" />
          </button>
        </header>

        {error ? <p className="context-room-form-error">{error}</p> : null}
        {loading && !preview ? <div className="context-room-duplicate-loading"><Loader2 aria-hidden="true" /> {t('contextRoom:duplicateCenter.checking')}</div> : null}

        {!preview ? (
          <div className="context-room-duplicate-list">
            {items.map((candidate) => (
              <article key={candidate.id}>
                <div className="context-room-duplicate-pair">
                  <b>{candidate.roomA.title}</b>
                  <ArrowRight aria-hidden="true" />
                  <b>{candidate.roomB.title}</b>
                </div>
                <div className="context-room-duplicate-meta">
                  <span data-confidence={candidate.confidence}>{confidenceLabel(candidate, t)}</span>
                  <small>{candidate.reasons[0] ?? t('contextRoom:duplicateCenter.compositeScore', { score: candidate.duplicateScore.toFixed(2) })}</small>
                </div>
                <footer>
                  <button type="button" onClick={() => void markSeparate(candidate)}><Split aria-hidden="true" /> {t('contextRoom:duplicateCenter.keepSeparate')}</button>
                  <button type="button" className="context-room-primary-button" onClick={() => void beginPreview(candidate)}><GitMerge aria-hidden="true" /> {t('contextRoom:duplicateCenter.viewMergeImpact')}</button>
                </footer>
              </article>
            ))}
            {!loading && items.length === 0 ? <div className="context-room-duplicate-empty"><Check aria-hidden="true" /><p>{t('contextRoom:duplicateCenter.empty')}</p></div> : null}
          </div>
        ) : (
          <div className="context-room-merge-preview">
            <label>
              <span>{t('contextRoom:duplicateCenter.keepAsPrimary')}</span>
              <select value={targetRoomId} onChange={(event) => void switchTarget(event.target.value)} disabled={Boolean(operation)}>
                <option value={selected?.roomAId}>{selected?.roomA.title}</option>
                <option value={selected?.roomBId}>{selected?.roomB.title}</option>
              </select>
            </label>

            <section className="context-room-merge-impact">
              <h3>{t('contextRoom:duplicateCenter.willMigrate')}</h3>
              <dl>{impactRows(preview).map(([label, count]) => <div key={label}><dt>{t(`contextRoom:duplicateCenter.impact.${label}`)}</dt><dd>{count}</dd></div>)}</dl>
            </section>

            <section className="context-room-merge-excluded">
              <h3>{t('contextRoom:duplicateCenter.willNotMigrate')}</h3>
              {preview.excluded.map((item) => <p key={item}>{item}</p>)}
            </section>

            {preview.conflicts.length ? <section className="context-room-merge-conflicts"><h3>{t('contextRoom:duplicateCenter.conflictHandling')}</h3>{preview.conflicts.map((item) => <p key={item}>{item}</p>)}</section> : null}

            {operation ? (
              <div className="context-room-merge-operation" data-status={operation.status}>
                {operation.status === 'completed' ? <Check aria-hidden="true" /> : operation.status === 'failed' ? <TriangleAlert aria-hidden="true" /> : <Loader2 aria-hidden="true" />}
                <div><b>{operation.status === 'completed' ? t('contextRoom:duplicateCenter.mergeCompleted') : operation.status === 'failed' ? t('contextRoom:duplicateCenter.mergeFailed') : t('contextRoom:duplicateCenter.merging')}</b><small>{operation.stage} · {operation.progress}%</small></div>
                {operation.status === 'failed'
                  ? <button type="button" onClick={() => void retryOperation()}>{t('contextRoom:duplicateCenter.retry')}</button>
                  : operation.status !== 'completed'
                    ? <button type="button" onClick={() => void refreshOperation()}>{t('contextRoom:duplicateCenter.refreshProgress')}</button>
                    : null}
              </div>
            ) : (
              <div className="context-room-merge-warning"><TriangleAlert aria-hidden="true" /><p>{t('contextRoom:duplicateCenter.warningIrreversible')}</p></div>
            )}

            <footer>
              <button type="button" onClick={() => { setPreview(null); setSelected(null); setOperation(null) }} disabled={loading}>{t('contextRoom:duplicateCenter.back')}</button>
              {operation?.status === 'failed' && !operation.commitReached
                ? <button type="button" onClick={() => void cancelOperation()} disabled={loading}>{t('contextRoom:duplicateCenter.cancelMerge')}</button>
                : null}
              {!operation ? <button type="button" className="context-room-danger-button" onClick={() => void confirmMerge()} disabled={loading}>{t('contextRoom:duplicateCenter.mergeInto', { title: preview.targetRoom.title })}</button> : null}
            </footer>
          </div>
        )}
      </div>
    </ReferenceDialog>
  )
}
