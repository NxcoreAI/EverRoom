import { ChevronLeft, FilePlus2, FileText, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'

import { MarkdownBody } from '../../context-room/ported/components/detail-panels/MarkdownBody'
import type { MemoryDocumentDto } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, useAsyncData } from './useMemoryData'

/** 粘贴导入的字符上限（与 gateway / MemoryCore 的 2MB 一致）。 */
const MAX_IMPORT_CHARS = 2 * 1024 * 1024

const TYPE_LABELS: Record<string, string> = {
  episodic: '情景',
  persona: '人格',
  instruction: '指令',
  work_fact: '事实',
  work_task: '任务',
  work_method: '方法',
  work_artifact: '产物',
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
  const detail = useAsyncData(() => window.nxcore!.memory.getDocument(document.id), [document.id])
  const callerRef = detail.data?.document.callerRef
  // 原文预览经 caller_ref（= 知识资产 file id）走 knowledge 既有链路。
  const preview = useAsyncData(
    () => callerRef
      ? window.nxcore!.knowledge.readFileMarkdown(callerRef)
      : Promise.resolve(null),
    [callerRef],
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
      setError(cause instanceof Error ? cause.message : '删除失败。')
      setConfirming(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mem-doc-detail">
      <div className="mem-toolbar">
        <button type="button" className="mem-doc-back" onClick={onBack}>
          <ChevronLeft aria-hidden="true" strokeWidth={1.7} />返回列表
        </button>
        <span className="mem-doc-title">{document.title}</span>
        <span className="mem-doc-meta">
          v{document.version} · {document.chunkCount} 块 · 派生 {detail.data?.document.derivedMemoryCount ?? '…'} 条
          · {formatDate(document.updatedAt)}
        </span>
        <span className="mem-toolbar-actions">
          {confirming ? (
            <>
              <button type="button" className="mem-danger" disabled={deleting} onClick={remove}>确认删除</button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>取消</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.7} />删除文档
            </button>
          )}
        </span>
      </div>
      {error ? <p className="mem-inline-error">{error}</p> : null}

      <section className="mem-doc-section">
        <h3>原文预览</h3>
        {preview.failure ? (
          <p className="mem-inline-error">原文预览不可用（{preview.failure.message}）</p>
        ) : preview.data ? (
          <div className="mem-doc-preview">
            <MarkdownBody markdown={preview.data.markdown} />
          </div>
        ) : (
          <p className="mem-loading">加载中…</p>
        )}
      </section>

      <section className="mem-doc-section">
        <h3>分块锚点（{detail.data?.chunks.length ?? 0}）</h3>
        <ul className="mem-doc-chunks">
          {(detail.data?.chunks ?? []).map((chunk) => (
            <li key={chunk.messageId} className="mem-doc-chunk">
              <header>
                <span className="mem-doc-chunk-path">{chunk.headingPath || '（无标题小节）'}</span>
                <small>第 {chunk.chunkIndex + 1} 块 · 原文第 {chunk.lineStart}–{chunk.lineEnd} 行</small>
              </header>
              <pre>{chunk.content}</pre>
            </li>
          ))}
        </ul>
      </section>

      <section className="mem-doc-section">
        <h3>派生原子记忆（{detail.data?.memories.length ?? 0}）</h3>
        {!detail.loading && (detail.data?.memories.length ?? 0) === 0 ? (
          <p className="mem-doc-hint">尚未提炼出原子记忆——首次导入后异步提炼需要一点时间，稍后刷新可见。</p>
        ) : (
          <ul className="mem-doc-memories">
            {(detail.data?.memories ?? []).map((memory) => (
              <li key={memory.id}>
                <span className="mem-type-badge" data-type={memory.type}>{typeLabel(memory.type)}</span>
                <span className="mem-atomic-text">{memory.content}</span>
                <span className="mem-time">{formatDate(memory.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export function DocumentPane({ focusDocumentId }: { focusDocumentId?: string | null }) {
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
    if (result.deduplicated) setNotice(`「${filename}」内容未变化，已导入版本保持 ${result.version}。`)
    else if (result.replacedVersions > 0) setNotice(`「${filename}」已升版至 ${result.version}，旧版记忆已级联清除。`)
    else setNotice(`「${filename}」已导入（${result.version}）。`)
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
          const message = cause instanceof Error ? cause.message : '导入失败。'
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
    const title = pasteTitle.trim() || '未命名文档'
    if (!markdown) return
    if (markdown.length > MAX_IMPORT_CHARS) {
      setError(`内容超过 2MB 上限（当前 ${(markdown.length / 1024 / 1024).toFixed(1)}MB）。`)
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
      setError(cause instanceof Error ? cause.message : '导入失败。')
    } finally {
      setImporting(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{failure.message}</div>

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
        <span className="mem-count">共 {data?.total ?? 0} 份文档（同名重导自动升版）</span>
        <span className="mem-toolbar-actions">
          <button type="button" onClick={() => setPasting((value) => !value)} disabled={importing}>
            <FilePlus2 aria-hidden="true" strokeWidth={1.7} />粘贴 md
          </button>
          <button type="button" onClick={importPicked} disabled={importing}>
            <Upload aria-hidden="true" strokeWidth={1.7} />选择 .md 文件
          </button>
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)} disabled={loading}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={loading ? 'mem-spin' : undefined} />刷新
          </button>
        </span>
      </div>

      {pasting ? (
        <div className="mem-doc-paste">
          <input
            type="text"
            value={pasteTitle}
            placeholder="文档标题（用于记忆场景命名与判重）"
            maxLength={512}
            onChange={(event) => setPasteTitle(event.target.value)}
          />
          <textarea
            value={pasteText}
            placeholder="粘贴 Markdown 全文（≤2MB）……"
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
              导入为记忆文档
            </button>
            <button type="button" disabled={importing} onClick={() => setPasting(false)}>取消</button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="mem-doc-notice">{notice}</p> : null}
      {error ? <p className="mem-inline-error">{error}</p> : null}

      {!loading && documents.length === 0 ? (
        <MemoryEmptyView
          title="暂无导入文档"
          hint="把 md 文档导入为记忆来源：MemoryCore 会按标题切块、提炼原子记忆，并支持双向溯源。"
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
                    v{doc.version} · {doc.chunkCount} 块 · 派生 {doc.derivedMemoryCount ?? '—'} 条 · {formatDate(doc.updatedAt)}
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
