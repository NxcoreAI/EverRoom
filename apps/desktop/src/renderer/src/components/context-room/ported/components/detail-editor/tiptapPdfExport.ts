import type { Editor } from '@tiptap/react'

import type { ExportDocumentPdfResult } from '../../../../../../../shared/sources'

const PDF_EXPORT_ROOT_ID = 'context-room-pdf-export'

export function pdfExportFileName(documentName: string): string {
  const safeName = documentName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
  return `${safeName || '无标题文档'}.pdf`
}

function preparePrintRoot(editor: Editor, documentName: string): HTMLElement {
  document.getElementById(PDF_EXPORT_ROOT_ID)?.remove()

  const root = document.createElement('main')
  root.id = PDF_EXPORT_ROOT_ID
  root.className = 'context-room-pdf-export context-room-app'
  root.setAttribute('aria-label', documentName)

  const content = editor.view.dom.cloneNode(true) as HTMLElement
  content.classList.remove('ProseMirror-focused')
  content.removeAttribute('contenteditable')
  content.removeAttribute('spellcheck')
  content.querySelectorAll('[contenteditable]').forEach((element) => {
    element.removeAttribute('contenteditable')
  })
  content.querySelectorAll('[data-reference-focus]').forEach((element) => {
    element.removeAttribute('data-reference-focus')
  })

  root.append(content)
  document.body.append(root)
  return root
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export async function exportEditorPdf(
  editor: Editor,
  documentName: string,
): Promise<ExportDocumentPdfResult> {
  const api = window.nxcore?.documents
  if (!api) throw new Error('PDF 导出仅在桌面版中可用。')

  const root = preparePrintRoot(editor, documentName)
  try {
    await document.fonts.ready
    await nextPaint()
    return await api.exportPdf({ fileName: pdfExportFileName(documentName) })
  } finally {
    root.remove()
  }
}
