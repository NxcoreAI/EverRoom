import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/react'
import { ExternalLink, FileText, X } from 'lucide-react'
import { useEffect } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

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
  const { locale, t } = useLocale()
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
            <span>{t('surface:markdownPreviewDialog.markdownPreview')}</span>
            <h2 id="markdown-preview-title">{preview.fileName}</h2>
            <small>{preview.relativePath} · {formatDate(preview.modifiedAt, locale, t)}</small>
          </div>
          <span className="evidence-dialog-actions">
            {onShowFile ? <button type="button" className="icon-button" title={t('surface:markdownPreviewDialog.openSource')} aria-label={t('surface:markdownPreviewDialog.openSource')} onClick={onShowFile}><ExternalLink aria-hidden="true" strokeWidth={1.8} /></button> : null}
            <button type="button" className="icon-button" title={t('surface:markdownPreviewDialog.close')} aria-label={t('surface:markdownPreviewDialog.closeMarkdownPreview')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
          </span>
        </header>
        <div className="markdown-preview-body">
          {editor ? <EditorContent editor={editor} /> : <div className="evidence-viewer-state"><FileText aria-hidden="true" />{t('surface:markdownPreviewDialog.preparingPreview')}</div>}
        </div>
      </section>
    </div>
  )
}
