import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/react'
import { ExternalLink, FileText, X } from 'lucide-react'
import { useEffect } from 'react'

import type { MarkdownPreview } from '../../../../../shared/sources'
import { parseMarkdownDocument } from '../../context-room/ported/components/detail-editor/markdownImport'
import { formatDate } from './sourceFormatters'

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  TaskList,
  TaskItem.configure({ nested: true }),
]

export function MarkdownPreviewDialog({ preview, onClose, onShowFile }: {
  preview: MarkdownPreview
  onClose: () => void
  onShowFile?: () => void
}) {
  const editor = useEditor({
    extensions,
    content: parseMarkdownDocument(preview.content),
    editable: false,
    editorProps: { attributes: { class: 'markdown-preview-document' } },
  })

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="evidence-dialog markdown-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-preview-title">
        <header className="evidence-dialog-head">
          <div>
            <span>Markdown 预览</span>
            <h2 id="markdown-preview-title">{preview.fileName}</h2>
            <small>{preview.relativePath} · {formatDate(preview.modifiedAt)}</small>
          </div>
          <span className="evidence-dialog-actions">
            {onShowFile ? <button type="button" className="icon-button" title="打开来源" aria-label="打开来源" onClick={onShowFile}><ExternalLink aria-hidden="true" strokeWidth={1.8} /></button> : null}
            <button type="button" className="icon-button" title="关闭" aria-label="关闭 Markdown 预览" onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
          </span>
        </header>
        <div className="markdown-preview-body">
          {editor ? <EditorContent editor={editor} /> : <div className="evidence-viewer-state"><FileText aria-hidden="true" />正在准备预览...</div>}
        </div>
      </section>
    </div>
  )
}
