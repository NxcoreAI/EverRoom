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
      showToast({ title: t('contextRoom:tiptapDocumentActions.markdownExported'), message: markdownExportFileName(documentName) })
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:tiptapDocumentActions.exportFailed'),
        message: error instanceof Error ? error.message : t('contextRoom:tiptapDocumentActions.unableToCreateMarkdownFile'),
      })
    }
  }

  const exportDocx = async () => {
    try {
      const fileName = docxExportFileName(documentName)
      const blob = await createDocxBlob(editor.getJSON(), documentName)
      downloadBlob(blob, fileName)
      showToast({ title: t('contextRoom:tiptapDocumentActions.wordDocumentExported'), message: fileName })
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:tiptapDocumentActions.exportFailed'),
        message: error instanceof Error ? error.message : t('contextRoom:tiptapDocumentActions.unableToCreateWordDocument'),
      })
    }
  }

  const exportPdf = async () => {
    setExportingPdf(true)
    try {
      const result = await exportEditorPdf(editor, documentName)
      if (!result.canceled) {
        showToast({ title: t('contextRoom:tiptapDocumentActions.pdfExported'), message: result.fileName })
      }
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:tiptapDocumentActions.exportFailed'),
        message: error instanceof Error ? error.message : t('contextRoom:tiptapDocumentActions.unableToCreatePdfFile'),
      })
    } finally {
      setExportingPdf(false)
    }
  }

  const deleteDocument = async () => {
    if (!backendDocument || !onDeleteDocument) return
    try {
      await onDeleteDocument(backendDocument)
      showToast({ title: t('contextRoom:tiptapDocumentActions.documentMovedToTrash') })
    } catch (error: unknown) {
      showToast({
        title: t('contextRoom:tiptapDocumentActions.failedToDeleteDocument'),
        message: error instanceof Error ? error.message : t('contextRoom:tiptapDocumentActions.tryAgainLater'),
      })
    }
  }

  const deleteDisabled = writing || saving || !backendDocument || !onDeleteDocument
  return (
    <div className="context-room-document-actions">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={t('contextRoom:tiptapDocumentActions.moreDocumentActions')} title={t('contextRoom:tiptapDocumentActions.moreActions')}>
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
                {t('contextRoom:tiptapDocumentActions.export')}
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
                    {t('contextRoom:tiptapDocumentActions.wordDocumentDocx')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item disabled={exportingPdf} onSelect={() => void exportPdf()}>
                    <FileText aria-hidden="true" />
                    {t('contextRoom:tiptapDocumentActions.pdfDocumentPdf')}
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator className="context-room-document-actions-separator" />
            <DropdownMenu.Item
              className="danger"
              disabled={deleteDisabled}
              title={writing
                ? t('contextRoom:tiptapDocumentActions.agentIsWritingThisDocumentCannotBeDeleted')
                : saving
                  ? t('contextRoom:tiptapDocumentActions.theDocumentIsSavingItCanBeDeleted')
                  : undefined}
              onSelect={() => setDeleteDialogOpen(true)}
            >
              <Trash2 aria-hidden="true" />
              {t('contextRoom:tiptapDocumentActions.deleteDocument')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ActionConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('contextRoom:tiptapDocumentActions.confirmDeleteDocument')}
        summary={t('contextRoom:tiptapDocumentActions.nameWillBeMovedToTrashYouCan', { name: documentName })}
        confirmLabel={t('contextRoom:tiptapDocumentActions.moveToTrash')}
        danger
        onConfirm={() => void deleteDocument()}
      />
    </div>
  )
}
