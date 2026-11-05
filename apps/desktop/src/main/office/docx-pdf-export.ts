import { mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { logDesktop } from '../logging/desktop-logger'
import type { OfficePreviewRegistry } from './office-preview-registry'
import { convertOfficeFileToPdf } from './legacy-convert'

/**
 * word_export_pdf 的进程内改造：优先用 genoffice 渲染层（与编辑器内
 * 「导出 PDF」完全相同的编排：分页预览 → 按纸型分组 printToPDF →
 * pdf-lib 合并）把 docx 写成 PDF——无外部依赖、无需本机安装
 * LibreOffice。老运行时（未重建 genoffice）缺 exportDocsPdf 或渲染
 * 失败时回退 LibreOffice（soffice）转换，保持原有环境兼容。
 */

export type DocxPdfExportOutcome =
  | { ok: true; pdfPath: string; engine: 'genoffice' | 'libreoffice' }
  | { ok: false; message: string }

export async function exportDocxToPdf(options: {
  registry: OfficePreviewRegistry
  fileId: string
  storagePath: string
  originalName: string
  targetDir: string
  hints?: { roomId?: string | null; workspaceId?: string | null }
}): Promise<DocxPdfExportOutcome> {
  const { registry, fileId, storagePath, originalName, targetDir, hints } = options
  mkdirSync(targetDir, { recursive: true })

  const inProcess = await exportViaGenoffice(registry, fileId, originalName, targetDir, hints)
  if (inProcess) return inProcess

  return exportViaLibreOffice(storagePath, originalName, targetDir)
}

/** genoffice 渲染层路径：活实例或后台隐藏会话。null = 不可用/失败（调用方回退）。 */
async function exportViaGenoffice(
  registry: OfficePreviewRegistry,
  fileId: string,
  originalName: string,
  targetDir: string,
  hints?: { roomId?: string | null; workspaceId?: string | null },
): Promise<DocxPdfExportOutcome | null> {
  let target: string
  try {
    const base = basename(originalName, extname(originalName)) || 'document'
    target = join(targetDir, `${base}.pdf`)
  } catch {
    return null
  }
  let outcome: Awaited<ReturnType<OfficePreviewRegistry['exportDocxPdf']>>
  try {
    outcome = await registry.exportDocxPdf(fileId, target, hints)
  } catch (error) {
    logDesktop('office', 'warn', {
      event: 'office.export-pdf.genoffice-threw',
      fileId,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
  if (outcome.ok) {
    logDesktop('office', 'info', {
      event: 'office.export-pdf.genoffice-ok',
      fileId,
      path: outcome.path,
    })
    return { ok: true, pdfPath: outcome.path, engine: 'genoffice' }
  }
  // 'unsupported' = 老 genoffice 运行时：静默回退 LibreOffice。
  if (outcome.reason === 'unsupported') return null
  // 渲染会话本身的失败（文件损坏/加密/超上限）在 LibreOffice 下大概率同样
  // 失败，但 soffice 对畸形 OOXML 的容忍度不同——仍回退一次，让它给出
  // 自己的错误文案（与旧版行为一致），只在日志里记录 genoffice 侧原因。
  logDesktop('office', 'warn', {
    event: 'office.export-pdf.genoffice-failed',
    fileId,
    reason: outcome.reason,
    message: outcome.message ?? null,
  })
  return null
}

async function exportViaLibreOffice(
  storagePath: string,
  originalName: string,
  targetDir: string,
): Promise<DocxPdfExportOutcome> {
  const converted = await convertOfficeFileToPdf(storagePath, originalName, targetDir)
  if ('unavailable' in converted) {
    return {
      ok: false,
      message: '本机未安装 LibreOffice，且内置 PDF 引擎不可用，无法导出 PDF。请更新 EverRoom 或安装 LibreOffice 后重试。',
    }
  }
  return { ok: true, pdfPath: converted.pdfPath, engine: 'libreoffice' }
}
