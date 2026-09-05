import type {
  DocumentImportCommentDiffSummary,
  DocumentImportHistoryEntry,
  RoomDocument,
} from '@nxcore/agent-contract'
import { CloudDownload, GitCompareArrows, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { CandidateDiffDialog } from './CandidateDiffDialog'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'
import './ExternalDocumentDialogs.css'

/**
 * 版本管理面板的"外部导入"区：同一来源再次导入只产生候选版本；
 * "检查外部更新"与"应用此版本"是两个独立动作（方案 §4.2 / §5.3）。
 */
export function DocumentImportHistorySection({
  roomId,
  currentDocument,
  refreshSignal,
  onApplied,
}: {
  roomId: string
  currentDocument: RoomDocument
  refreshSignal: number
  onApplied?: () => void
}) {
  const { t } = useLocale()
  const [entries, setEntries] = useState<DocumentImportHistoryEntry[]>([])
  const [commentDiff, setCommentDiff] = useState<DocumentImportCommentDiffSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [diffEntryId, setDiffEntryId] = useState<string | null>(null)

  const external = window.nxcore?.externalDocuments

  const load = useCallback(() => {
    if (!external) return
    setLoading(true)
    void external.importHistory(roomId, currentDocument.id)
      .then((result) => {
        setEntries(result.entries)
        setCommentDiff(result.commentDiff)
      })
      .catch(() => {
        setEntries([])
        setCommentDiff(null)
      })
      .finally(() => setLoading(false))
  }, [currentDocument.id, external, roomId])

  useEffect(() => {
    load()
  }, [load, refreshSignal])

  if (loading && entries.length === 0) {
    return <div className="context-room-import-history context-room-import-history-loading">
      <Loader2 className="spin" aria-hidden="true" />
    </div>
  }
  if (entries.length === 0) return null

  const checkUpdate = async () => {
    if (!external) return
    setBusyKey('__check__')
    try {
      const result = await external.checkExternalUpdate(roomId, currentDocument.id)
      showToast({
        title: t('contextRoom:importHistory.candidateCreated'),
        message: result.relation === 'candidate'
          ? t('contextRoom:importHistory.compareThenApply')
          : t('contextRoom:importHistory.imported'),
      })
      load()
    } catch (error) {
      showToast({
        title: t('contextRoom:importHistory.checkFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyKey(null)
    }
  }

  const applyCandidate = async (entry: DocumentImportHistoryEntry) => {
    if (!external) return
    setBusyKey(entry.roomImportId)
    try {
      const result = await external.applyCandidate(entry.roomImportId)
      showToast({
        title: t('contextRoom:importHistory.appliedAsVersion', { version: String(result.version) }),
      })
      setDiffEntryId(null)
      onApplied?.()
      load()
    } catch (error) {
      showToast({
        title: t('contextRoom:importHistory.applyFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusyKey(null)
    }
  }

  const applyFromDiff = async (roomImportId: string) => {
    const entry = entries.find((candidate) => candidate.roomImportId === roomImportId)
    if (entry) await applyCandidate(entry)
  }

  return (
    <section className="context-room-import-history">
      <div className="context-room-history-list-heading">
        <span>{t('contextRoom:importHistory.title')}</span>
        <small>{t('contextRoom:importHistory.sourceCount', { count: entries.length })}</small>
      </div>
      {commentDiff && !commentDiff.comparable && (
        <p className="context-room-import-history-hint">{t('contextRoom:importHistory.commentsNotComparable')}</p>
      )}
      {commentDiff?.comparable && (
        <p className="context-room-import-history-hint">
          {t('contextRoom:importHistory.commentDiffSummary', {
            added: String(commentDiff.added),
            resolved: String(commentDiff.resolved),
            removed: String(commentDiff.removed),
          })}
        </p>
      )}
      <button
        type="button"
        className="context-room-import-history-check"
        disabled={busyKey !== null}
        onClick={() => void checkUpdate()}
      >
        {busyKey === '__check__' ? <Loader2 className="spin" aria-hidden="true" /> : <CloudDownload aria-hidden="true" />}
        {t('contextRoom:importHistory.checkExternalUpdate')}
      </button>
      <ul>
        {entries.map((entry) => (
          <li key={entry.roomImportId} data-relation={entry.relation}>
            <div className="context-room-import-history-entry">
              <span className="context-room-import-history-provider">{entry.provider}</span>
              <span className="context-room-import-history-title" title={entry.displayTitle}>{entry.displayTitle}</span>
              <span className="context-room-import-history-meta">
                {entry.relation === 'candidate' && entry.importedVersion === null
                  ? t('contextRoom:importHistory.pendingCandidate')
                  : `V${String(entry.importedVersion ?? 1)}`}
                {entry.commentsStatus !== 'complete' ? ` · ${t('contextRoom:importHistory.commentsMissing')}` : ''}
              </span>
            </div>
            {entry.relation === 'candidate' && entry.importedVersion === null && (
              <>
                <button
                  type="button"
                  className="context-room-import-history-diff"
                  disabled={busyKey !== null}
                  onClick={() => setDiffEntryId(entry.roomImportId)}
                >
                  <GitCompareArrows aria-hidden="true" />
                  {t('contextRoom:importHistory.compareDiff')}
                </button>
                <button
                  type="button"
                  className="context-room-import-history-apply"
                  disabled={busyKey !== null}
                  onClick={() => void applyCandidate(entry)}
                >
                  {busyKey === entry.roomImportId && <Loader2 className="spin" aria-hidden="true" />}
                  {t('contextRoom:importHistory.applyThisVersion')}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {diffEntryId && (
        <CandidateDiffDialog
          roomImportId={diffEntryId}
          currentDocument={currentDocument}
          onClose={() => setDiffEntryId(null)}
          onApply={applyFromDiff}
        />
      )}
    </section>
  )
}
