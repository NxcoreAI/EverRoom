import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { BrowserWindow, dialog, ipcMain } from 'electron'

import type { ExportDocumentPdfInput, ExportDocumentPdfResult } from '../shared/sources'
import { createDocumentPdfHtml } from './document-pdf-template'

export const DOCUMENT_PDF_EXPORT_CHANNEL = 'documents:export-pdf'

const MAX_PDF_HTML_BYTES = 8 * 1024 * 1024
const MAX_PDF_TITLE_LENGTH = 120

function pdfExportInput(input: unknown): ExportDocumentPdfInput {
  if (!input || typeof input !== 'object') throw new Error('无效的 PDF 导出请求。')
  const value = input as Partial<ExportDocumentPdfInput>
  if (typeof value.fileName !== 'string') throw new Error('无效的 PDF 文件名。')
  if (typeof value.title !== 'string' || value.title.length > MAX_PDF_TITLE_LENGTH) {
    throw new Error('无效的 PDF 文档标题。')
  }
  if (
    typeof value.html !== 'string'
    || !value.html.trim()
    || Buffer.byteLength(value.html, 'utf8') > MAX_PDF_HTML_BYTES
  ) {
    throw new Error('PDF 文档内容为空或过大。')
  }
  const safeName = basename(value.fileName)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 180)
  const fileName = safeName || '无标题文档'
  return {
    fileName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`,
    title: value.title.trim() || '无标题文档',
    html: value.html,
  }
}

async function waitForDocumentAssets(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`
    Promise.race([
      Promise.all([
        document.fonts.ready,
        ...Array.from(document.images, (image) => image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true })
              image.addEventListener('error', resolve, { once: true })
            })),
      ]),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  `, true)
}

async function renderPdf(input: ExportDocumentPdfInput): Promise<Buffer> {
  const printWindow = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    const documentHtml = createDocumentPdfHtml({
      title: input.title,
      contentHtml: input.html,
    })
    const dataUrl = `data:text/html;base64,${Buffer.from(documentHtml, 'utf8').toString('base64')}`
    await printWindow.loadURL(dataUrl)
    await waitForDocumentAssets(printWindow)
    return await printWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    })
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
  }
}

export function registerDocumentPdfExportHandler(): void {
  ipcMain.handle(
    DOCUMENT_PDF_EXPORT_CHANNEL,
    async (event, input: unknown): Promise<ExportDocumentPdfResult> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) {
        throw new Error('无法验证 PDF 导出请求来源。')
      }
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('无法验证 PDF 导出请求来源。')
      }

      const validatedInput = pdfExportInput(input)
      const selection = await dialog.showSaveDialog(owner, {
        title: '导出 PDF',
        defaultPath: validatedInput.fileName,
        buttonLabel: '导出',
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (selection.canceled || !selection.filePath) return { canceled: true }

      const filePath = selection.filePath.toLowerCase().endsWith('.pdf')
        ? selection.filePath
        : `${selection.filePath}.pdf`

      const pdf = await renderPdf(validatedInput)
      await writeFile(filePath, pdf)
      return {
        canceled: false,
        filePath,
        fileName: basename(filePath),
      }
    },
  )
}
