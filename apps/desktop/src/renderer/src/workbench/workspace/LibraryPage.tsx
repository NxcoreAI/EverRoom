import { FilePlus2, FileText, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import type { RealOfficeFile } from '@/office-proto/data'

import { ConfirmModal } from '../ui/modal'
import { EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileImportButton,
  FileLibraryLoading,
  FileLibraryUnavailable,
} from './fileBrowser'
import type { FileItemActions } from './fileItemViews'
import { LibraryBrowser } from './LibraryBrowser'
import { useFileLibrary } from './useFileLibrary'
import { useLibraryDropZone } from './useLibraryDropZone'
import './library.css'

/**
 * 资料库页：本工作空间专属的文件管理器（返回上一级 / 面包屑 / 搜索 / 网格·列表）。
 *
 * 布局照 everoffice 原型「资料库」：目录层级由 `relativePath` 派生，网格里文件夹
 * 在前、文件在后，列表是「名称 / 本地位置 / 修改时间 / 大小 / 操作」六列。
 * 文件入库时带 workspaceId（手动导入按当前空间，Agent 产物按其会话所属空间），
 * 本页只拉 `workspace.id` 名下的文件；存量文件迁移后归默认工作区。
 * 打开文件一律走注入的 onOpenFile → 工作空间右侧气泡窗；本页自己不挂编辑器。
 * 访达拖文件进内容区直接导入本空间（与「导入文件」按钮同一条 importPathsOnce 链路）。
 */

/** 导入结果摘要 → toast 文案（按钮导入与拖放导入共用）。 */
function summarizeImport(summary: { imported: number; failed: number; skipped: number }): string {
  const parts: string[] = []
  if (summary.imported > 0) parts.push(`已导入 ${summary.imported} 个文件`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (summary.skipped > 0) parts.push(`${summary.skipped} 个跳过`)
  return parts.join('，') || '没有可导入的文件'
}
export function LibraryPage({ workspace, onOpenFile, onToast }: WorkspacePageProps) {
  const library = useFileLibrary(workspace.id)
  const [pendingDelete, setPendingDelete] = useState<RealOfficeFile | null>(null)
  const [deleting, setDeleting] = useState(false)

  const openOriginal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.openOriginal !== 'function') {
      onToast('桌面端文件能力不可用')
      return
    }
    try {
      const result = await api.openOriginal(item.catalog.id, item.catalog.originalName, item.catalog.contentHash, {
        workspaceId: workspace.id,
      })
      if (result.openedWith === 'office') onToast(`已在内置 Office 预览中打开「${item.file.name}」`)
      else onToast('已用系统默认应用打开')
    } catch {
      onToast('打开失败，请稍后重试')
    }
  }

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      onToast('桌面端文件能力不可用')
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      onToast('已导出到「下载/EverRoom」并定位到文件管理器')
    } catch {
      onToast('导出失败，请稍后重试')
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    const api = window.nxcore?.files
    if (!api || typeof api.delete !== 'function') {
      onToast('桌面端文件能力不可用')
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    try {
      await api.delete(target.catalog.id)
      onToast(`已删除「${target.file.name}」`)
      setPendingDelete(null)
      library.refresh()
    } catch {
      onToast('删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  const handleImport = async () => {
    if (library.importing) return
    try {
      const summary = await library.importFiles()
      if (!summary) {
        onToast('文件库不可用，无法导入')
        return
      }
      if (summary.kind === 'cancelled') {
        onToast('已取消导入')
        return
      }
      onToast(summarizeImport(summary))
    } catch {
      onToast('导入失败，请稍后重试')
    }
  }

  /** 访达拖放导入：结果摘要与按钮导入同一套文案。 */
  const handleDropFiles = async (files: File[]) => {
    if (library.importing) {
      onToast('正在导入中，请稍候')
      return
    }
    try {
      const summary = await library.importDroppedFiles(files)
      if (!summary) {
        onToast('文件库不可用，无法导入')
        return
      }
      if (summary.kind === 'cancelled') return
      onToast(summarizeImport(summary))
    } catch {
      onToast('导入失败，请稍后重试')
    }
  }

  /**
   * 把本空间资料库里的 Word/PDF 设为「论文排版模版」。
   *
   * 排版工具按工作区隔离：在这里设一次，打开本空间任意 docx 后在 AI 面板
   * 「排版」里就能直接选它——不必再走面板里的磁盘选择框重复上传。
   */
  const setThesisTemplate = async (item: RealOfficeFile) => {
    const thesis = window.nxcore?.thesisFormat
    if (!thesis || typeof thesis.setFromLibrary !== 'function') {
      onToast('桌面端排版能力不可用')
      return
    }
    onToast(`正在解析「${item.file.name}」为排版模版…`)
    try {
      const result = await thesis.setFromLibrary(workspace.id, item.catalog.id)
      const gaps = Array.isArray(result.factGaps) ? result.factGaps.filter(Boolean) : []
      if (gaps.length > 0) {
        onToast(`已设为排版模版，但有信息没解析出来：${gaps.join('；')}`)
      } else {
        onToast(`已设为「${workspace.name}」的论文排版模版`)
      }
    } catch {
      onToast('设为排版模版失败，请稍后重试')
    }
  }

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
    onSetThesisTemplate: (item) => { void setThesisTemplate(item) },
    onDelete: (item) => setPendingDelete(item),
  }

  // 访达拖放：落点是页面根节点——空库/加载/不可用态也能拖，不只在有内容的浏览器里。
  const { dragActive, dragProps } = useLibraryDropZone((files) => { void handleDropFiles(files) })

  return (
    <div
      className={dragActive ? 'wb-wspage wb-library-page is-dragover' : 'wb-wspage wb-library-page'}
      {...dragProps}
    >
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">资料库</h1>
        <div className="wb-file-head-actions">
          <IconButton
            label="刷新文件库"
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
            disabled={library.refreshing}
          />
          <FileImportButton importing={library.importing} onClick={() => { void handleImport() }} />
        </div>
      </header>

      {library.state === 'loading' ? <FileLibraryLoading /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && library.items.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<FileText size={18} />}
          title={library.total === 0 ? '本空间还没有文件' : '没有可在此打开的文件'}
        />
      ) : null}

      {library.state === 'ready' && library.items.length > 0 ? (
        <LibraryBrowser items={library.items} actions={actions} />
      ) : null}

      {/* 拖放悬停提示：只在拖着文件悬停期间出现，pointer-events:none 防抖动 */}
      {dragActive ? (
        <div className="wb-lib-dropzone" aria-hidden="true">
          <FilePlus2 size={22} aria-hidden="true" />
          <p>{library.importing ? '正在导入…' : '松手导入到资料库'}</p>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null) }}
        title={pendingDelete ? `删除「${pendingDelete.file.name}」？` : '删除文件？'}
        description="会从文件库删除该文件及其解析产物，操作不可撤销。"
        confirmLabel={deleting ? '删除中…' : '删除'}
        busy={deleting}
        onConfirm={() => { void confirmDelete() }}
      />
    </div>
  )
}
