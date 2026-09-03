import type {
  ExternalDocumentPreview,
  ExternalDocumentProvider,
  ExternalDocumentSearchResultItem,
} from '@nxcore/agent-contract'
import { Loader2, Search, X } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'
import './ExternalDocumentDialogs.css'

/**
 * "从飞书 / Notion 导入" 面板（OpenConnector 只读通道）。预览即落不可变快照；
 * "加入 Room" 通过 Document Commit Service 创建本地文档版本 1。同一来源再次
 * 导入由版本管理界面以候选版本方式处理，不覆盖当前文档。
 */
export function ExternalImportDialog({
  open,
  onClose,
  roomId,
  onImported,
}: {
  open: boolean
  onClose: () => void
  roomId: string
  onImported?: (documentId: string) => void
}) {
  const { t } = useLocale()
  const [provider, setProvider] = useState<ExternalDocumentProvider>('feishu')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [items, setItems] = useState<ExternalDocumentSearchResultItem[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ExternalDocumentPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)

  const external = window.nxcore?.externalDocuments

  const search = async () => {
    if (!external || !query.trim()) return
    setSearching(true)
    setSearchError(null)
    setItems([])
    setPreview(null)
    try {
      const response = await external.importSearch(provider, query.trim())
      setItems(response.items)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      setSearching(false)
    }
  }

  const loadPreview = async (remoteDocumentId: string) => {
    if (!external) return
    setPreviewing(true)
    setPreview(null)
    try {
      setPreview(await external.importPreview(provider, remoteDocumentId))
    } catch (error) {
      showToast({
        title: t('contextRoom:externalImportDialog.previewFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setPreviewing(false)
    }
  }

  const joinRoom = async () => {
    if (!external || !preview) return
    setCommitting(true)
    try {
      const result = await external.importCommit({ runId: preview.runId, roomId })
      showToast({
        title: result.relation === 'candidate'
          ? t('contextRoom:externalImportDialog.candidateCreated')
          : t('contextRoom:externalImportDialog.importedAsVersion1'),
      })
      onImported?.(result.documentId)
      onClose()
    } catch (error) {
      showToast({
        title: t('contextRoom:externalImportDialog.commitFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setCommitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="context-room-external-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('contextRoom:externalImportDialog.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{t('contextRoom:externalImportDialog.title')}</h2>
          <button type="button" className="dialog-close" aria-label={t('contextRoom:externalImportDialog.close')} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="context-room-external-import-body">
          <div className="context-room-external-import-provider">
            {(['feishu', 'notion'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={provider === candidate ? 'active' : ''}
                onClick={() => {
                  setProvider(candidate)
                  setItems([])
                  setPreview(null)
                }}
              >
                {candidate === 'feishu'
                  ? t('contextRoom:externalImportDialog.feishu')
                  : t('contextRoom:externalImportDialog.notion')}
              </button>
            ))}
          </div>
          <div className="context-room-external-import-search">
            <input
              type="text"
              value={query}
              placeholder={t('contextRoom:externalImportDialog.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void search()
              }}
            />
            <button type="button" className="primary" disabled={searching || !query.trim()} onClick={() => void search()}>
              {searching ? <Loader2 className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
              {t('contextRoom:externalImportDialog.search')}
            </button>
          </div>
          {searchError && <p className="context-room-external-import-error">{searchError}</p>}
          {items.length > 0 && !preview && (
            <ul className="context-room-external-import-results">
              {items.map((item) => (
                <li key={item.remoteDocumentId}>
                  <button type="button" onClick={() => void loadPreview(item.remoteDocumentId)}>
                    <strong>{item.title}</strong>
                    <span>{item.updatedAt ?? item.remoteDocumentId}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {previewing && <p className="context-room-external-import-hint"><Loader2 className="spin" aria-hidden="true" /> {t('contextRoom:externalImportDialog.loadingPreview')}</p>}
          {preview && (
            <div className="context-room-external-import-preview">
              <h3>{preview.title}</h3>
              {preview.sourceUrl && (
                <p className="context-room-external-import-hint">
                  <a href={preview.sourceUrl} target="_blank" rel="noreferrer">{preview.sourceUrl}</a>
                </p>
              )}
              <p className="context-room-external-import-comments" data-status={preview.commentsStatus}>
                {preview.commentsStatus === 'complete'
                  ? t('contextRoom:externalImportDialog.commentsLoaded', { count: String(preview.comments.length) })
                  : t('contextRoom:externalImportDialog.commentsUnavailable')}
              </p>
              {preview.warnings.map((warning) => (
                <p key={warning.code} className="context-room-external-import-warning">⚠ {warning.message}</p>
              ))}
              <pre className="context-room-external-import-excerpt">{preview.bodyExcerpt}</pre>
              <p className="context-room-external-import-hint">
                {t('contextRoom:externalImportDialog.joinHint')}
              </p>
              <footer>
                <button type="button" className="secondary" onClick={() => setPreview(null)}>
                  {t('contextRoom:externalImportDialog.backToResults')}
                </button>
                <button type="button" className="primary" disabled={committing} onClick={() => void joinRoom()}>
                  {committing && <Loader2 className="spin" aria-hidden="true" />}
                  {t('contextRoom:externalImportDialog.joinRoom')}
                </button>
              </footer>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
