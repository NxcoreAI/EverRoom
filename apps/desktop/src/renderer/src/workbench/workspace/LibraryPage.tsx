import { FileText, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { RealOfficeFile } from '@/office-proto/data'

import { ConfirmModal } from '../ui/modal'
import { EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileGrid,
  FileImportButton,
  FileLibraryLoading,
  FileLibraryUnavailable,
  FileList,
  FileNoMatches,
  FileToolbar,
  SOURCE_FILTERS,
  countSourceFilters,
  filterLibraryFiles,
  groupFilesByDirectory,
  type FileItemActions,
  type FileViewMode,
  type SourceFilterKey,
} from './fileBrowser'
import { useFileLibrary } from './useFileLibrary'
import './library.css'

/**
 * 资料库页：本工作空间专属的文件管理器（搜索 / 来源筛选 / 列表·网格 / 相对目录分组）。
 *
 * 文件入库时带 workspaceId（手动导入按当前空间，Agent 产物按其会话所属空间），
 * 本页只拉 `workspace.id` 名下的文件；存量文件迁移后归默认工作区。
 * 打开文件一律走注入的 onOpenFile → 工作空间右侧气泡窗；本页自己不挂编辑器。
 */
export function LibraryPage({ workspace, onOpenFile, onToast }: WorkspacePageProps) {
  const library = useFileLibrary(workspace.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SourceFilterKey>('all')
  const [view, setView] = useState<FileViewMode>('list')
  const [pendingDelete, setPendingDelete] = useState<RealOfficeFile | null>(null)
  const [deleting, setDeleting] = useState(false)

  const filtered = useMemo(
    () => filterLibraryFiles(library.items, query, filter),
    [library.items, query, filter],
  )
  const counts = useMemo(() => countSourceFilters(library.items), [library.items])
  const filters = useMemo(
    () => SOURCE_FILTERS.map((option) => ({ ...option, count: counts[option.key] })),
    [counts],
  )
  // 目录分组只在「全部 + 未搜索」时用，搜索/筛选后平铺更符合预期。
  const groups = useMemo(
    () => (filter === 'all' && !query.trim() ? groupFilesByDirectory(filtered) : undefined),
    [filter, filtered, query],
  )

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
      const parts: string[] = []
      if (summary.imported > 0) parts.push(`已导入 ${summary.imported} 个文件`)
      if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
      if (summary.skipped > 0) parts.push(`${summary.skipped} 个跳过`)
      onToast(parts.join('，') || '没有可导入的文件')
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

  const clearFilters = () => {
    setQuery('')
    setFilter('all')
  }

  const showToolbar = library.state === 'ready' && library.items.length > 0

  return (
    <div className="wb-wspage wb-library-page">
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

      {showToolbar ? (
        <FileToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          filter={filter}
          onFilterChange={setFilter}
          view={view}
          onViewChange={setView}
        />
      ) : null}

      {library.state === 'loading' ? <FileLibraryLoading /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && library.items.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<FileText size={18} />}
          title={library.total === 0 ? '本空间还没有文件' : '没有可在此打开的文件'}
        />
      ) : null}

      {library.state === 'ready' && library.items.length > 0 && filtered.length === 0 ? (
        <FileNoMatches onClear={clearFilters} />
      ) : null}

      {library.state === 'ready' && filtered.length > 0 ? (
        view === 'list' ? (
          <FileList items={filtered} groups={groups} actions={actions} />
        ) : (
          <FileGrid items={filtered} actions={actions} />
        )
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
