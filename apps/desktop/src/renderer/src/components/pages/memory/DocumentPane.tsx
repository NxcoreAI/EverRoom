import { ChevronLeft, ChevronRight, FilePlus2, FileText, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { MemoryDocumentDto } from '../../../../../shared/memory'
import { MarkdownBody } from '../../context-room/ported/components/detail-panels/MarkdownBody'
import { MemoryMarkdown } from './MemoryMarkdown'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, scrollPaneToTop, useAsyncData } from './useMemoryData'
import { useLocale } from '@/i18n/LocaleContext'

/** 粘贴导入的字符上限（与 gateway / MemoryCore 的 2MB 一致）。 */
const MAX_IMPORT_CHARS = 2 * 1024 * 1024
/** 文档列表每页条数（走 gateway 分页，不再一次拉全量）。 */
const PAGE_SIZE = 30

const TYPE_LABELS: Record<string, string> = {
  episodic: 'memory:document.episodic',
  persona: 'memory:document.persona',
  instruction: 'memory:document.instruction',
  work_fact: 'memory:document.fact',
  work_task: 'memory:document.task',
  work_method: 'memory:document.method',
  work_artifact: 'memory:document.artifact',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.(md|markdown)$/i, '').trim() || filename
}

/** 单文档详情：md 全文预览（知识资产链路）+ 分块锚点 + 派生记忆。 */
function DocumentDetail({ document, onBack, onDeleted }: {
  document: MemoryDocumentDto
  onBack: () => void
  onDeleted: () => void
}) {
  const { locale, t } = useLocale()
  const detail = useAsyncData(() => window.nxcore!.memory.getDocument(document.id), [document.id])
  const callerRef = detail.data?.document.callerRef
  // 原文预览经 caller_ref（= 知识资产 file id）走 knowledge 既有链路。
  // 资产 id 格式固定（file-/parsed- + 12 hex）；其他 callerRef（如 connector:…）
  // 不发请求，直接走分块兜底，避免 404 触发全局错误弹窗。
  const assetFileId = callerRef && /^(file|parsed)-[0-9a-f]{12}$/.test(callerRef) ? callerRef : null
  const preview = useAsyncData(
    () => assetFileId
      ? window.nxcore!.knowledge.readFileMarkdown(assetFileId)
      : Promise.resolve(null),
    [assetFileId],
  )
  // 预览材料：资产原文 > 分块拼接（非文件来源文档的兜底）。
  // assetFileId=null 的 loader 即空 resolve（data/failure 均 null），不能当"加载中"。
  const chunkFallback = detail.data?.chunks.length
    ? detail.data.chunks.map((chunk) => chunk.content).join('\n\n')
    : null
  const previewMarkdown = preview.data?.markdown
    ?? (assetFileId === null ? chunkFallback : null)
  const previewLoading = assetFileId !== null && !preview.data && !preview.failure
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setDeleting(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteDocument(document.id)
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:document.deleteFailed'))
      setConfirming(false)
    } finally {
      setDeleting(false)
    }
  }

  const derivedCount = detail.data?.document.derivedMemoryCount
    ?? detail.data?.memories.length
    ?? document.derivedMemoryCount
    ?? 0

  return (
    <div className="mem-doc-detail">
      <div className="mem-toolbar">
        <button type="button" className="mem-doc-back" onClick={onBack}>
          <ChevronLeft aria-hidden="true" strokeWidth={1.7} />{t('memory:document.backToList')}
        </button>
        <span className="mem-doc-title">{document.title}</span>
        <span className="mem-doc-meta">
          {t('memory:document.versionChunksDerived', { version: document.version, chunks: document.chunkCount, count: detail.data?.document.derivedMemoryCount ?? '…' })}
          · {formatDate(document.updatedAt, locale)}
        </span>
        <span className="mem-toolbar-actions">
          <button type="button" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" strokeWidth={1.7} />{t('memory:document.deleteDocument')}
          </button>
        </span>
      </div>
      {error ? <p className="mem-inline-error">{error}</p> : null}

      {confirming ? (
        <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setConfirming(false)
        }}>
          <section className="evidence-dialog mem-doc-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="mem-doc-delete-title">
            <header className="evidence-dialog-head">
              <div>
                <span className="mem-ledger-detail-kind">{t('memory:document.deleteDocument')}</span>
                <h2 id="mem-doc-delete-title">{document.title || t('memory:document.untitledDocument')}</h2>
              </div>
            </header>
            <div className="mem-doc-delete-body">
              <p className="mem-doc-delete-warning">
                {t('memory:document.deleteCascadeHint', {
                  version: document.version,
                  chunks: document.chunkCount,
                  memories: derivedCount,
                })}
              </p>
              {derivedCount > 0 ? (
                <ul className="mem-doc-delete-loss">
                  {(detail.data?.memories ?? []).slice(0, 5).map((memory) => (
                    <li key={memory.id}>
                      <span className="mem-type-badge" data-type={memory.type}>{t(typeLabel(memory.type))}</span>
                      <span className="mem-atomic-text">{memory.content}</span>
                    </li>
                  ))}
                  {derivedCount > 5 ? (
                    <li className="mem-doc-delete-more">{t('memory:document.deleteMoreMemories', { count: derivedCount - 5 })}</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
            <footer className="mem-doc-delete-foot">
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>{t('memory:document.cancel')}</button>
              <button type="button" className="mem-danger" disabled={deleting} onClick={() => void remove()}>
                {deleting ? t('memory:document.deleting') : t('memory:document.confirmDelete')}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <section className="mem-doc-section">
        <h3>{t('memory:document.sourcePreview')}</h3>
        {previewMarkdown ? (
          <div className="mem-doc-preview">
            <MarkdownBody markdown={previewMarkdown} />
          </div>
        ) : preview.failure ? (
          // 资产原文请求失败（清理/丢失）时用分块原文拼接兜底，而不是整块报错。
          chunkFallback ? (
            <div className="mem-doc-preview">
              <MarkdownBody markdown={chunkFallback} />
            </div>
          ) : (
            <p className="mem-inline-error">{t('memory:document.sourcePreviewUnavailable', { error: memoryFailureText(preview.failure, t) })}</p>
          )
        ) : previewLoading ? (
          <p className="mem-loading">{t('memory:document.loading')}</p>
        ) : (
          <p className="mem-inline-error">{t('memory:document.sourcePreviewUnavailable', { error: t('memory:document.noChunks') })}</p>
        )}
      </section>

      <section className="mem-doc-section">
        <h3>{t('memory:document.chunkAnchors', { count: detail.data?.chunks.length ?? 0 })}</h3>
        <ul className="mem-doc-chunks">
          {(detail.data?.chunks ?? []).map((chunk) => (
            <li key={chunk.messageId} className="mem-doc-chunk">
              <header>
                <span className="mem-doc-chunk-path">{chunk.headingPath || t('memory:document.untitledSection')}</span>
                <small>{t('memory:document.chunkSourceLines', { chunk: chunk.chunkIndex + 1, start: chunk.lineStart, end: chunk.lineEnd })}</small>
              </header>
              <MemoryMarkdown markdown={chunk.content} compact />
            </li>
          ))}
        </ul>
      </section>

      <section className="mem-doc-section">
        <h3>{t('memory:document.derivedAtomicMemories', { count: detail.data?.memories.length ?? 0 })}</h3>
        {!detail.loading && (detail.data?.memories.length ?? 0) === 0 ? (
          <p className="mem-doc-hint">{t('memory:document.noDerivedMemoriesYet')}</p>
        ) : (
          <ul className="mem-doc-memories">
            {(detail.data?.memories ?? []).map((memory) => (
              <li key={memory.id}>
                <span className="mem-type-badge" data-type={memory.type}>{t(typeLabel(memory.type))}</span>
                <span className="mem-atomic-text">{memory.content}</span>
                <span className="mem-time">{formatDate(memory.updatedAt, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export function DocumentPane({ focusDocumentId }: { focusDocumentId?: string | null }) {
  const { locale, t } = useLocale()
  const [reloadTick, setReloadTick] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<MemoryDocumentDto | null>(null)
  const [page, setPage] = useState(0)
  const [pasting, setPasting] = useState(false)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listDocuments(PAGE_SIZE, page * PAGE_SIZE),
    [reloadTick, page],
  )

  // 溯源跳转：原子记忆 → 文档详情。目标可能不在当前页：先在页内找，
  // 找不到直接用跳转传来的最小信息渲染详情（详情数据自己拉取）。
  useEffect(() => {
    if (focusDocumentId) {
      setSelectedDoc((current) => current?.id === focusDocumentId ? current : {
        id: focusDocumentId,
        title: '',
        callerRef: '',
        version: 0,
        sessionId: '',
        chunkCount: 0,
        derivedMemoryCount: null,
        createdAt: '',
        updatedAt: '',
      })
      setSelectedId(focusDocumentId)
    }
  }, [focusDocumentId])

  const documents = data?.documents ?? []
  const total = data?.total ?? 0
  // 页内点击时用行数据（有标题/版本）；溯源跳转占位由详情自己补全
  const openDocument = (doc: MemoryDocumentDto) => {
    setSelectedDoc(doc)
    setSelectedId(doc.id)
  }

  const reportImport = (filename: string, result: { deduplicated: boolean; replacedVersions: number; version: string }) => {
    if (result.deduplicated) setNotice(t('memory:document.contentUnchanged', { filename, version: result.version }))
    else if (result.replacedVersions > 0) setNotice(t('memory:document.versionUpgraded', { filename, version: result.version }))
    else setNotice(t('memory:document.imported', { filename, version: result.version }))
  }

  const importEntry = async (title: string, markdown: string, filename?: string) => {
    const result = await window.nxcore!.memory.importMarkdown({ title, markdown, filename })
    reportImport(title, result)
  }

  const importPicked = async () => {
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const picked = await window.nxcore!.memory.pickMarkdownFiles()
      for (const entry of picked) {
        if ('error' in entry) {
          setError((prev) => (prev ? `${prev}\n${entry.filename}：${entry.error}` : `${entry.filename}：${entry.error}`))
          continue
        }
        try {
          await importEntry(titleFromFilename(entry.filename), entry.markdown, entry.filename)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : t('memory:document.importFailed')
          setError((prev) => (prev ? `${prev}\n${entry.filename}：${message}` : `${entry.filename}：${message}`))
        }
      }
      setReloadTick((tick) => tick + 1)
    } finally {
      setImporting(false)
    }
  }

  const importPaste = async () => {
    const markdown = pasteText.trim()
    const title = pasteTitle.trim() || t('memory:document.untitledDocument')
    if (!markdown) return
    if (markdown.length > MAX_IMPORT_CHARS) {
      setError(t('memory:document.contentExceedsLimit', { size: (markdown.length / 1024 / 1024).toFixed(1) }))
      return
    }
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      await importEntry(title, markdown)
      setPasting(false)
      setPasteTitle('')
      setPasteText('')
      setReloadTick((tick) => tick + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:document.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{memoryFailureText(failure, t)}</div>

  // 选中项（页内点击带完整行数据；溯源跳转的最小占位由详情拉取补全）
  if (selectedId && selectedDoc) {
    return (
      <DocumentDetail
        document={selectedDoc}
        onBack={() => { setSelectedId(null); setSelectedDoc(null) }}
        onDeleted={() => {
          setSelectedId(null)
          setSelectedDoc(null)
          setReloadTick((tick) => tick + 1)
        }}
      />
    )
  }

  return (
    <div className="mem-documents">
      <div className="mem-toolbar">
        <span className="mem-count">{t('memory:document.documentCount', { count: data?.total ?? 0 })}</span>
        <span className="mem-toolbar-actions">
          <button type="button" onClick={() => setPasting((value) => !value)} disabled={importing}>
            <FilePlus2 aria-hidden="true" strokeWidth={1.7} />{t('memory:document.pasteMarkdown')}
          </button>
          <button type="button" onClick={importPicked} disabled={importing}>
            <Upload aria-hidden="true" strokeWidth={1.7} />{t('memory:document.selectMarkdownFiles')}
          </button>
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)} disabled={loading}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={loading ? 'mem-spin' : undefined} />{t('memory:document.refresh')}
          </button>
        </span>
      </div>

      {pasting ? (
        <div className="mem-doc-paste">
          <input
            type="text"
            value={pasteTitle}
            placeholder={t('memory:document.titlePlaceholder')}
            maxLength={512}
            onChange={(event) => setPasteTitle(event.target.value)}
          />
          <textarea
            value={pasteText}
            placeholder={t('memory:document.markdownPlaceholder')}
            rows={8}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <div className="mem-doc-paste-actions">
            <button
              type="button"
              className="mem-primary"
              disabled={importing || !pasteText.trim()}
              onClick={importPaste}
            >
              {t('memory:document.importAsMemoryDocument')}
            </button>
            <button type="button" disabled={importing} onClick={() => setPasting(false)}>{t('memory:document.cancel')}</button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="mem-doc-notice">{notice}</p> : null}
      {error ? <p className="mem-inline-error">{error}</p> : null}

      {!loading && documents.length === 0 ? (
        <MemoryEmptyView
          title={t('memory:document.noImportedDocuments')}
          hint={t('memory:document.importHint')}
        />
      ) : (
        <ul className="mem-doc-list">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button type="button" className="mem-doc-card" onClick={() => openDocument(doc)}>
                <FileText aria-hidden="true" strokeWidth={1.7} />
                <span className="mem-doc-card-body">
                  <span className="mem-doc-card-title">{doc.title}</span>
                  <small>
                    {t('memory:document.versionChunksDerived', { version: doc.version, chunks: doc.chunkCount, count: doc.derivedMemoryCount ?? '—' })} · {formatDate(doc.updatedAt, locale)}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {documents.length > 0 ? (
        <div className="mem-ledger-pager">
          <button type="button" disabled={page === 0 || loading} onClick={() => { setPage((current) => current - 1); scrollPaneToTop() }}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.8} />{t('memory:ledger.prevPage')}
          </button>
          <span>{t('memory:ledger.pageRange', {
            start: total === 0 ? 0 : page * PAGE_SIZE + 1,
            end: Math.min((page + 1) * PAGE_SIZE, total),
            total,
          })}</span>
          <button type="button" disabled={page >= Math.ceil(total / PAGE_SIZE) - 1 || loading} onClick={() => { setPage((current) => current + 1); scrollPaneToTop() }}>
            {t('memory:ledger.nextPage')}<ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
