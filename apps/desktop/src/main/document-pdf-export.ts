import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { BrowserWindow, dialog, ipcMain } from 'electron'

import type { ExportDocumentPdfInput, ExportDocumentPdfResult } from '../shared/sources'
import { createDocumentPdfHtml } from './document-pdf-template'
import { desktopText, getDesktopLocale } from './desktop-locale'

export const DOCUMENT_PDF_EXPORT_CHANNEL = 'documents:export-pdf'

const MAX_PDF_HTML_BYTES = 8 * 1024 * 1024
const MAX_PDF_TITLE_LENGTH = 120

function pdfExportInput(input: unknown): ExportDocumentPdfInput {
  if (!input || typeof input !== 'object') throw new Error(desktopText('error.pdf.invalidRequest'))
  const value = input as Partial<ExportDocumentPdfInput>
  if (typeof value.fileName !== 'string') throw new Error(desktopText('error.pdf.invalidFileName'))
  if (typeof value.title !== 'string' || value.title.length > MAX_PDF_TITLE_LENGTH) {
    throw new Error(desktopText('error.pdf.invalidTitle'))
  }
  if (
    typeof value.html !== 'string'
    || !value.html.trim()
    || Buffer.byteLength(value.html, 'utf8') > MAX_PDF_HTML_BYTES
  ) {
    throw new Error(desktopText('error.pdf.invalidContent'))
  }
  const safeName = basename(value.fileName)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 180)
  const fileName = safeName || desktopText('document.untitled')
  return {
    fileName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`,
    title: value.title.trim() || desktopText('document.untitled'),
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
      locale: getDesktopLocale(),
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
        throw new Error(desktopText('error.pdf.invalidSource'))
      }
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error(desktopText('error.pdf.invalidSource'))
      }

      const validatedInput = pdfExportInput(input)
      const selection = await dialog.showSaveDialog(owner, {
        title: desktopText('dialog.exportPdf.title'),
        defaultPath: validatedInput.fileName,
        buttonLabel: desktopText('dialog.exportPdf.button'),
        filters: [{ name: desktopText('dialog.exportPdf.pdfDocument'), extensions: ['pdf'] }],
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
