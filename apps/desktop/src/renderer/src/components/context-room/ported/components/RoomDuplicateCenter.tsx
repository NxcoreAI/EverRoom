import type { RoomDuplicateCandidate, RoomMergeOperation, RoomMergePreview } from '@nxcore/agent-contract'
import { ArrowRight, Check, GitMerge, Loader2, RefreshCw, Split, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ReferenceDialog } from './shared'

function confidenceLabel(candidate: RoomDuplicateCandidate): string {
  if (candidate.confidence === 'high') return '高度重复'
  if (candidate.confidence === 'medium') return '疑似重复'
  if (candidate.confidence === 'pending') return '等待判断'
  return '主题相关'
}

export function isMergeRecommendationCandidate(candidate: RoomDuplicateCandidate): boolean {
  return ['high', 'medium', 'pending'].includes(candidate.confidence)
}

function impactRows(preview: RoomMergePreview): Array<[string, number]> {
  return [
    ['文档', preview.impact.documents],
    ['外部资料', preview.impact.externalSources],
    ['Wiki 内容', preview.impact.wikiFiles],
    ['Room 记忆', preview.impact.localMemories + preview.impact.attributedMemories],
    ['Agent 运行', preview.impact.agentRuns],
    ['会话链接', preview.impact.sessionLinks],
    ['实体', preview.impact.entities],
    ['关系', preview.impact.relations],
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
      setError(cause instanceof Error ? cause.message : '重复 Room 加载失败')
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
      setError(cause instanceof Error ? cause.message : '合并影响预览失败')
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
      setError(cause instanceof Error ? cause.message : '合并影响预览失败')
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
      setError(cause instanceof Error ? cause.message : 'Room 合并启动失败')
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
    <ReferenceDialog open={open} onOpenChange={onOpenChange} title="重复 Room">
      <div className="context-room-duplicate-center">
        <header>
          <div>
            <span>知识整理</span>
            <h2>重复 Room</h2>
          </div>
          <button type="button" className="context-room-icon-button" onClick={() => void reload()} title="刷新候选" aria-label="刷新候选" disabled={loading}>
            <RefreshCw aria-hidden="true" />
          </button>
        </header>

        {error ? <p className="context-room-form-error">{error}</p> : null}
        {loading && !preview ? <div className="context-room-duplicate-loading"><Loader2 aria-hidden="true" /> 正在检查</div> : null}

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
                  <span data-confidence={candidate.confidence}>{confidenceLabel(candidate)}</span>
                  <small>{candidate.reasons[0] ?? `综合分 ${candidate.duplicateScore.toFixed(2)}`}</small>
                </div>
                <footer>
                  <button type="button" onClick={() => void markSeparate(candidate)}><Split aria-hidden="true" /> 保持分开</button>
                  <button type="button" className="context-room-primary-button" onClick={() => void beginPreview(candidate)}><GitMerge aria-hidden="true" /> 查看合并影响</button>
                </footer>
              </article>
            ))}
            {!loading && items.length === 0 ? <div className="context-room-duplicate-empty"><Check aria-hidden="true" /><p>当前没有需要处理的重复 Room</p></div> : null}
          </div>
        ) : (
          <div className="context-room-merge-preview">
            <label>
              <span>保留为主 Room</span>
              <select value={targetRoomId} onChange={(event) => void switchTarget(event.target.value)} disabled={Boolean(operation)}>
                <option value={selected?.roomAId}>{selected?.roomA.title}</option>
                <option value={selected?.roomBId}>{selected?.roomB.title}</option>
              </select>
            </label>

            <section className="context-room-merge-impact">
              <h3>将迁移到主 Room</h3>
              <dl>{impactRows(preview).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
            </section>

            <section className="context-room-merge-excluded">
              <h3>不会迁移</h3>
              {preview.excluded.map((item) => <p key={item}>{item}</p>)}
            </section>

            {preview.conflicts.length ? <section className="context-room-merge-conflicts"><h3>合并处理</h3>{preview.conflicts.map((item) => <p key={item}>{item}</p>)}</section> : null}

            {operation ? (
              <div className="context-room-merge-operation" data-status={operation.status}>
                {operation.status === 'completed' ? <Check aria-hidden="true" /> : operation.status === 'failed' ? <TriangleAlert aria-hidden="true" /> : <Loader2 aria-hidden="true" />}
                <div><b>{operation.status === 'completed' ? '合并完成' : operation.status === 'failed' ? '合并失败' : '正在合并'}</b><small>{operation.stage} · {operation.progress}%</small></div>
                {operation.status === 'failed'
                  ? <button type="button" onClick={() => void retryOperation()}>重试</button>
                  : operation.status !== 'completed'
                    ? <button type="button" onClick={() => void refreshOperation()}>刷新进度</button>
                    : null}
              </div>
            ) : (
              <div className="context-room-merge-warning"><TriangleAlert aria-hidden="true" /><p>确认后，来源 Room 将立即只读。合并完成后不可撤销。</p></div>
            )}

            <footer>
              <button type="button" onClick={() => { setPreview(null); setSelected(null); setOperation(null) }} disabled={loading}>返回</button>
              {operation?.status === 'failed' && !operation.commitReached
                ? <button type="button" onClick={() => void cancelOperation()} disabled={loading}>取消合并</button>
                : null}
              {!operation ? <button type="button" className="context-room-danger-button" onClick={() => void confirmMerge()} disabled={loading}>合并到「{preview.targetRoom.title}」</button> : null}
            </footer>
          </div>
        )}
      </div>
    </ReferenceDialog>
  )
}
