import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { BrowserWindow, dialog, ipcMain } from 'electron'

import type { ExportDocumentPdfInput, ExportDocumentPdfResult } from '../shared/sources'

export const DOCUMENT_PDF_EXPORT_CHANNEL = 'documents:export-pdf'

function pdfFileName(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error('无效的 PDF 导出请求。')
  const value = input as Partial<ExportDocumentPdfInput>
  if (typeof value.fileName !== 'string') throw new Error('无效的 PDF 文件名。')
  const safeName = basename(value.fileName)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 180)
  const fileName = safeName || '无标题文档'
  return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`
}

export function registerDocumentPdfExportHandler(): void {
  ipcMain.handle(
    DOCUMENT_PDF_EXPORT_CHANNEL,
    async (event, input: unknown): Promise<ExportDocumentPdfResult> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) {
        throw new Error('无法验证 PDF 导出请求来源。')
      }

      const fileName = pdfFileName(input)
      const selection = await dialog.showSaveDialog(owner, {
        title: '导出 PDF',
        defaultPath: fileName,
        buttonLabel: '导出',
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (selection.canceled || !selection.filePath) return { canceled: true }

      const filePath = selection.filePath.toLowerCase().endsWith('.pdf')
        ? selection.filePath
        : `${selection.filePath}.pdf`

      const pdf = await event.sender.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        generateDocumentOutline: true,
      })
      await writeFile(filePath, pdf)
      return {
        canceled: false,
        filePath,
        fileName: basename(filePath),
      }
    },
  )
}
