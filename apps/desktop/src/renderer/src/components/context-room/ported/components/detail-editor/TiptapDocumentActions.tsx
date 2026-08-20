import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { RoomDocument } from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { ChevronRight, Download, Ellipsis, FileText, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import { showToast } from '../../../../../state/toast'
import { ActionConfirmDialog } from '../../components/shared'
import { createDocxBlob, docxExportFileName } from './tiptapDocxExport'
import { exportEditorPdf } from './tiptapPdfExport'

export function markdownExportFileName(documentName: string): string {
  const safeName = documentName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
  return `${safeName || '无标题文档'}.md`
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function downloadMarkdown(editor: Editor, documentName: string): void {
  downloadBlob(
    new Blob([editor.getMarkdown()], { type: 'text/markdown;charset=utf-8' }),
    markdownExportFileName(documentName),
  )
}

export function TiptapDocumentActions({
  editor,
  documentName,
  backendDocument,
  writing,
  saving,
  onDeleteDocument,
}: {
  editor: Editor
  documentName: string
  backendDocument: RoomDocument | null
  writing: boolean
  saving: boolean
  onDeleteDocument?: (document: RoomDocument) => Promise<void>
}) {
  const { t } = useLocale()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)

  const exportMarkdown = () => {
    try {
      downloadMarkdown(editor, documentName)
      showToast({ title: t('已导出 Markdown'), message: markdownExportFileName(documentName) })
    } catch (error: unknown) {
      showToast({
        title: t('导出失败'),
        message: error instanceof Error ? error.message : t('无法生成 Markdown 文件'),
      })
    }
  }

  const exportDocx = async () => {
    try {
      const fileName = docxExportFileName(documentName)
      const blob = await createDocxBlob(editor.getJSON(), documentName)
      downloadBlob(blob, fileName)
      showToast({ title: t('已导出 Word 文档'), message: fileName })
    } catch (error: unknown) {
      showToast({
        title: t('导出失败'),
        message: error instanceof Error ? error.message : t('无法生成 Word 文档'),
      })
    }
  }

  const exportPdf = async () => {
    setExportingPdf(true)
    try {
      const result = await exportEditorPdf(editor, documentName)
      if (!result.canceled) {
        showToast({ title: t('已导出 PDF'), message: result.fileName })
      }
    } catch (error: unknown) {
      showToast({
        title: t('导出失败'),
        message: error instanceof Error ? error.message : t('无法生成 PDF 文件'),
      })
    } finally {
      setExportingPdf(false)
    }
  }

  const deleteDocument = async () => {
    if (!backendDocument || !onDeleteDocument) return
    try {
      await onDeleteDocument(backendDocument)
      showToast({ title: t('文档已移到回收站') })
    } catch (error: unknown) {
      showToast({
        title: t('删除文档失败'),
        message: error instanceof Error ? error.message : t('请稍后重试'),
      })
    }
  }

  const deleteDisabled = writing || saving || !backendDocument || !onDeleteDocument
  return (
    <div className="context-room-document-actions">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={t('文档更多操作')} title={t('更多操作')}>
            <Ellipsis aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="context-room-card-menu context-room-document-actions-menu"
            sideOffset={6}
            align="end"
          >
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>
                <Download aria-hidden="true" />
                {t('导出')}
                <ChevronRight className="context-room-document-actions-submenu-icon" aria-hidden="true" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  className="context-room-card-menu context-room-document-actions-menu"
                  sideOffset={4}
                >
                  <DropdownMenu.Item onSelect={exportMarkdown}>
                    <FileText aria-hidden="true" />
                    Markdown (.md)
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => void exportDocx()}>
                    <FileText aria-hidden="true" />
                    {t('Word 文档 (.docx)')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item disabled={exportingPdf} onSelect={() => void exportPdf()}>
                    <FileText aria-hidden="true" />
                    {t('PDF 文档 (.pdf)')}
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator className="context-room-document-actions-separator" />
            <DropdownMenu.Item
              className="danger"
              disabled={deleteDisabled}
              title={writing
                ? t('Agent 正在写入，暂时不能删除')
                : saving
                  ? t('文档正在保存，稍后即可删除')
                  : undefined}
              onSelect={() => setDeleteDialogOpen(true)}
            >
              <Trash2 aria-hidden="true" />
              {t('删除文档')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ActionConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('删除文档？')}
        summary={t('“{name}”将移到回收站，你仍可以在回收站中恢复。', { name: documentName })}
        confirmLabel={t('移到回收站')}
        danger
        onConfirm={() => void deleteDocument()}
      />
    </div>
  )
}
