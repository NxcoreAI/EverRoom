import { generateHTML } from '@tiptap/html'
import type { Editor } from '@tiptap/react'
import i18n from '@/i18n/i18next'

import type { ExportDocumentPdfResult } from '../../../../../../../shared/sources'

export function pdfExportFileName(documentName: string, untitled = '无标题文档'): string {
  const safeName = documentName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
  return `${safeName || untitled}.pdf`
}

function staticDocumentHtml(editor: Editor): string {
  const container = document.createElement('div')
  container.innerHTML = generateHTML(editor.getJSON(), editor.extensionManager.extensions)
  container.querySelectorAll<HTMLElement>('[data-document-block-reference]').forEach((reference) => {
    const title = reference.dataset.fallbackTitle?.trim() || i18n.t('contextRoom:documentBlockReference.referencedDocument')
    const preview = reference.dataset.fallbackPreview?.trim() || i18n.t('contextRoom:documentBlockReference.previewUnavailable')
    const heading = document.createElement('strong')
    const summary = document.createElement('small')
    heading.textContent = title
    summary.textContent = preview
    reference.replaceChildren(heading, summary)
  })
  return container.innerHTML
}

export async function exportEditorPdf(
  editor: Editor,
  documentName: string,
  untitled = '无标题文档',
): Promise<ExportDocumentPdfResult> {
  const api = window.nxcore?.documents
  if (!api) throw new Error(i18n.t('contextRoom:tiptapDocumentActions.pdfExportDesktopOnly'))
  return api.exportPdf({
    fileName: pdfExportFileName(documentName, untitled),
    title: documentName.trim() || untitled,
    html: staticDocumentHtml(editor),
  })
}
