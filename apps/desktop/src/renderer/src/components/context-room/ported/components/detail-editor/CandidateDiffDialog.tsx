import type { RoomDocument } from '@nxcore/agent-contract'
import { Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import './ExternalDocumentDialogs.css'

interface DiffView {
  candidateTitle: string
  currentTitle: string
  appliedVersion: number | null
  hunks: Array<{ type: 'ctx' | 'add' | 'del'; text: string }>
  commentsComparable: boolean
}

/**
 * 候选版本 diff 视图（方案 §4.2/§5.3）：应用前对比"外部更新候选"与当前文档，
 * 行级着色（绿增/红删）；评论不可比较时显式说明，不产生虚假差异。
 */
export function CandidateDiffDialog({
  roomImportId,
  currentDocument,
  onClose,
  onApply,
}: {
  roomImportId: string
  currentDocument: RoomDocument
  onClose: () => void
  onApply?: (roomImportId: string) => Promise<void>
}) {
  const { t } = useLocale()
  const [view, setView] = useState<DiffView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.nxcore?.externalDocuments.importDiff(roomImportId)
      .then((result) => {
        if (!cancelled) setView(result as DiffView)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [roomImportId])

  const changed = view?.hunks.filter((hunk) => hunk.type !== 'ctx').length ?? 0

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="context-room-candidate-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('contextRoom:candidateDiff.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{t('contextRoom:candidateDiff.title')}</h2>
          <button type="button" className="dialog-close" aria-label={t('contextRoom:candidateDiff.close')} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="context-room-candidate-diff-body">
          {!view && !error && (
            <p className="context-room-candidate-diff-hint">
              <Loader2 className="spin" aria-hidden="true" /> {t('contextRoom:candidateDiff.loading')}
            </p>
          )}
          {error && <p className="context-room-import-warning">{error}</p>}
          {view && (
            <>
              <div className="context-room-candidate-diff-sides">
                <span title={view.candidateTitle}>{view.candidateTitle}</span>
                <span title={view.currentTitle}>{view.currentTitle} · V{String(currentDocument.version)}</span>
              </div>
              <p className="context-room-candidate-diff-summary">
                {changed === 0
                  ? t('contextRoom:candidateDiff.noChanges')
                  : t('contextRoom:candidateDiff.changedLines', { count: String(changed) })}
                {!view.commentsComparable && ` · ${t('contextRoom:candidateDiff.commentsNotComparable')}`}
              </p>
              <pre className="context-room-candidate-diff-hunks">
                {view.hunks.map((hunk, index) => (
                  <span key={index} className={`context-room-candidate-diff-hunk hunk-${hunk.type}`}>
                    {hunk.type === 'add' ? '+ ' : hunk.type === 'del' ? '- ' : '  '}{hunk.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
              <footer>
                <button type="button" className="secondary" onClick={onClose}>
                  {t('contextRoom:candidateDiff.close')}
                </button>
                {view.appliedVersion === null && onApply && (
                  <button
                    type="button"
                    className="primary"
                    disabled={applying}
                    onClick={() => void onApply(roomImportId)}
                  >
                    {applying && <Loader2 className="spin" aria-hidden="true" />}
                    {t('contextRoom:importHistory.applyThisVersion')}
                  </button>
                )}
              </footer>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
