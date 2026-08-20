import { ChevronLeft, FilePlus2, FileText, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { MemoryDocumentDto } from '../../../../../shared/memory'
import { MarkdownBody } from '../../context-room/ported/components/detail-panels/MarkdownBody'
import { MemoryMarkdown } from './MemoryMarkdown'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, useAsyncData } from './useMemoryData'
import { useLocale } from '@/i18n/LocaleContext'

/** 粘贴导入的字符上限（与 gateway / MemoryCore 的 2MB 一致）。 */
const MAX_IMPORT_CHARS = 2 * 1024 * 1024

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
          {confirming ? (
            <>
              <button type="button" className="mem-danger" disabled={deleting} onClick={remove}>{t('memory:document.confirmDelete')}</button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>{t('memory:document.cancel')}</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.7} />{t('memory:document.deleteDocument')}
            </button>
          )}
        </span>
      </div>
      {error ? <p className="mem-inline-error">{error}</p> : null}

      <section className="mem-doc-section">
        <h3>{t('memory:document.sourcePreview')}</h3>
        {preview.data ? (
          <div className="mem-doc-preview">
            <MemoryMarkdown markdown={preview.data.markdown} />
          </div>
        ) : preview.failure ? (
          // 无知识资产（callerRef 非文件 id，如 ingest/连接器直入 MemoryCore）时
          // 用分块原文拼接兜底，而不是整块报错。
          detail.data?.chunks.length ? (
            <div className="mem-doc-preview">
              <MarkdownBody markdown={detail.data.chunks.map((chunk) => chunk.content).join('\n\n')} />
            </div>
          ) : (
            <p className="mem-inline-error">{t('memory:document.sourcePreviewUnavailable', { error: memoryFailureText(preview.failure, t) })}</p>
          )
        ) : (
          <p className="mem-loading">{t('memory:document.loading')}</p>
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
  const [pasting, setPasting] = useState(false)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listDocuments(200),
    [reloadTick],
  )

  // 溯源跳转：原子记忆 → 文档详情
  useEffect(() => {
    if (focusDocumentId) setSelectedId(focusDocumentId)
  }, [focusDocumentId])

  const documents = data?.documents ?? []

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

  // 列表里找不到的 selectedId（换版/已删）自然落回列表渲染
  const selected = selectedId ? documents.find((doc) => doc.id === selectedId) ?? null : null
  if (selected) {
    return (
      <DocumentDetail
        document={selected}
        onBack={() => setSelectedId(null)}
        onDeleted={() => { setSelectedId(null); setReloadTick((tick) => tick + 1) }}
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
              <button type="button" className="mem-doc-card" onClick={() => setSelectedId(doc.id)}>
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
    </div>
  )
}
