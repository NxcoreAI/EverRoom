import type {
  ExternalDocumentListItem,
  ExternalDocumentPreview,
  ExternalDocumentProvider,
} from '@nxcore/agent-contract'
import { BookOpen, FileText, FolderOpen, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'
import { MarkdownBody } from '../detail-panels/MarkdownBody'
import './ExternalDocumentDialogs.css'

/**
 * "从飞书 / Notion 导入" 面板（OpenConnector 只读通道）。文档列表与连接器页
 * 同源（importList 按连接全量列举）：打开先回显列举缓存，"重新获取"手动全量
 * 刷新；本地过滤替代远端搜索。预览即落不可变快照，"加入 Room" 走 Document
 * Commit Service 创建本地文档版本 1；同一来源再次导入由版本管理界面以候选
 * 版本方式处理，不覆盖当前文档。
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
  const { locale, t } = useLocale()
  const [provider, setProvider] = useState<ExternalDocumentProvider>('feishu')
  const [items, setItems] = useState<ExternalDocumentListItem[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<ExternalDocumentPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)

  const external = window.nxcore?.externalDocuments

  // 打开/切换平台：重置过滤与预览态（列表由缓存回显 effect 填充）。
  useEffect(() => {
    if (!open) return
    setPreview(null)
    setFilter('')
    setListError(null)
  }, [open, provider])

  const loadList = useCallback(async () => {
    if (!external) return
    setLoading(true)
    setListError(null)
    try {
      const response = await external.importList(provider)
      setItems(response.items)
      setFetchedAt(response.fetchedAt ?? new Date().toISOString())
      setTruncated(response.truncated)
      setWarnings(response.warnings.map((warning) => warning.message))
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [external, provider])

  // 缓存秒显（imported 徽标由服务端按当前库重算，导入后无需重拉）；
  // 无缓存时自动全量拉一次，之后由"重新获取"手动刷新。
  useEffect(() => {
    if (!open || !external) return
    let cancelled = false
    void external.importList(provider, undefined, true)
      .then((response) => {
        if (cancelled) return
        if (response.fetchedAt && response.items.length > 0) {
          setItems(response.items)
          setFetchedAt(response.fetchedAt)
          setTruncated(response.truncated)
          setWarnings(response.warnings.map((warning) => warning.message))
        } else {
          void loadList()
        }
      })
      .catch(() => {
        if (!cancelled) void loadList()
      })
    return () => {
      cancelled = true
    }
  }, [open, provider, external, loadList])

  const visibleItems = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) => item.title.toLowerCase().includes(keyword)
      || (item.wikiSpaceName ?? '').toLowerCase().includes(keyword))
  }, [items, filter])

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

  const originIcon = (origin: ExternalDocumentListItem['origin']) =>
    origin === 'wiki' ? <BookOpen aria-hidden="true" /> : origin === 'drive' ? <FolderOpen aria-hidden="true" /> : <FileText aria-hidden="true" />

  if (!open) return null

  const metaOf = (item: ExternalDocumentListItem): string => [
    t({
      drive: 'contextRoom:externalImportDialog.originDrive',
      wiki: 'contextRoom:externalImportDialog.originWiki',
      page: 'contextRoom:externalImportDialog.originPage',
    }[item.origin]),
    item.wikiSpaceName,
    item.updatedAt
      ? new Date(item.updatedAt).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
      : null,
  ].filter(Boolean).join(' · ')

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
                onClick={() => setProvider(candidate)}
              >
                {candidate === 'feishu'
                  ? t('contextRoom:externalImportDialog.feishu')
                  : t('contextRoom:externalImportDialog.notion')}
              </button>
            ))}
          </div>
          {!preview && (
            <>
              <div className="context-room-external-import-toolbar">
                <button
                  type="button"
                  className="context-room-external-import-refresh"
                  disabled={loading}
                  onClick={() => void loadList()}
                >
                  {loading ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {t('contextRoom:externalImportDialog.refresh')}
                </button>
                <span className="context-room-external-import-meta">
                  {fetchedAt
                    ? t('contextRoom:externalImportDialog.listMeta', {
                      count: String(items.length),
                      time: new Date(fetchedAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    })
                    : items.length > 0
                      ? t('contextRoom:externalImportDialog.listMetaNoTime', { count: String(items.length) })
                      : ''}
                </span>
                <div className="context-room-external-import-filter">
                  <Search aria-hidden="true" />
                  <input
                    type="text"
                    value={filter}
                    placeholder={t('contextRoom:externalImportDialog.filterPlaceholder')}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {filter ? (
                    <button type="button" onClick={() => setFilter('')} aria-label={t('contextRoom:externalImportDialog.close')}>
                      <X aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
              {listError ? <p className="context-room-external-import-error">{listError}</p> : null}
              {listError?.includes('IMPORT_CONNECTION_REQUIRED') ? (
                <p className="context-room-external-import-hint">{t('contextRoom:externalImportDialog.connectionHint')}</p>
              ) : null}
              {truncated || warnings.length > 0 ? (
                <p className="context-room-external-import-warning">
                  ⚠ {[truncated ? t('contextRoom:externalImportDialog.listTruncated') : null, ...warnings].filter(Boolean).join('；')}
                </p>
              ) : null}
              {items.length > 0 ? (
                <ul className="context-room-external-import-results">
                  {visibleItems.map((item) => (
                    <li key={item.remoteDocumentId}>
                      <button type="button" onClick={() => void loadPreview(item.remoteDocumentId)}>
                        <span className="context-room-external-import-item-title">
                          <span className="context-room-external-import-item-origin" data-origin={item.origin}>
                            {originIcon(item.origin)}
                          </span>
                          <strong>{item.title}</strong>
                          {item.imported ? <em>{t('contextRoom:externalImportDialog.importedBadge')}</em> : null}
                        </span>
                        <span className="context-room-external-import-item-meta">{metaOf(item)}</span>
                      </button>
                    </li>
                  ))}
                  {visibleItems.length === 0 ? (
                    <li className="context-room-external-import-filter-empty">
                      {t('contextRoom:externalImportDialog.filterNoMatch', { query: filter.trim() })}
                    </li>
                  ) : null}
                </ul>
              ) : loading ? (
                <p className="context-room-external-import-hint">
                  <Loader2 className="spin" aria-hidden="true" /> {t('contextRoom:externalImportDialog.loadingList')}
                </p>
              ) : !listError ? (
                <div className="context-room-external-import-empty">
                  <FileText aria-hidden="true" />
                  <p>{t('contextRoom:externalImportDialog.listEmpty')}</p>
                  <button type="button" className="primary" onClick={() => void loadList()}>
                    {t('contextRoom:externalImportDialog.loadDocuments')}
                  </button>
                </div>
              ) : null}
            </>
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
              <div className="context-room-external-import-excerpt">
                <MarkdownBody markdown={preview.bodyExcerpt} />
              </div>
              <p className="context-room-external-import-hint">
                {t('contextRoom:externalImportDialog.joinHint')}
              </p>
              <footer>
                <button type="button" className="secondary" onClick={() => setPreview(null)}>
                  {t('contextRoom:externalImportDialog.backToResults')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    showToast({ title: t('contextRoom:externalImportDialog.snapshotOnlySaved') })
                    onClose()
                  }}
                >
                  {t('contextRoom:externalImportDialog.snapshotOnly')}
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
