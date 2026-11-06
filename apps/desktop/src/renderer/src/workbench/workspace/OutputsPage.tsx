import { FolderOpen, PackageOpen, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { RealOfficeFile } from '@/office-proto/data'

import { Button, EmptyState, IconButton } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import {
  FileLibraryLoading,
  FileLibraryUnavailable,
  FileNoMatches,
  FileToolbar,
  fileSearchText,
  isArtifactFile,
  sortFilesByUpdatedDesc,
  type FileViewMode,
  type FileFilterOption,
} from './fileBrowser'
import { type FileItemActions } from './fileItemViews'
import { folderLabel, folderOf, type LibraryRow } from './libraryTree'
import { LibraryGrid, LibraryList } from './LibraryViews'
import { useFileLibrary } from './useFileLibrary'
import './library.css'

type ArtifactFilter = 'all' | 'agent-generated' | 'artifact-imported'

/**
 * 产物页：本工作空间里 `sourceKind ∈ {agent-generated, artifact-imported}` 的文件。
 *
 * Agent 生成的产物在入库时带其会话所属的 workspaceId，产物导入按当前空间归属；
 * 本页只拉 `workspace.id` 名下的产物，与资料同一套隔离口径。
 * 点开走注入的 onOpenFile → 气泡窗。
 *
 * 列表排序 UI 与资料页一致（以资料为主）：网格/列表复用 LibraryViews 的
 * 同一套瓦片与六列表格（表头「修改时间」带倒序指示），行序同为更新时间倒序；
 * 本页多出的只是来源筛选 chips（筛选不是排序）。
 */
export function OutputsPage({ workspace, onOpenFile, onToast, onOpenPage, onNewWork }: WorkspacePageProps) {
  const library = useFileLibrary(workspace.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [view, setView] = useState<FileViewMode>('grid')

  const artifacts = useMemo(
    () => sortFilesByUpdatedDesc(library.items.filter(isArtifactFile)),
    [library.items],
  )
  const counts = useMemo(() => ({
    all: artifacts.length,
    'agent-generated': artifacts.filter((item) => item.catalog.sourceKind === 'agent-generated').length,
    'artifact-imported': artifacts.filter((item) => item.catalog.sourceKind === 'artifact-imported').length,
  }), [artifacts])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return artifacts.filter((item) => {
      if (filter !== 'all' && item.catalog.sourceKind !== filter) return false
      return !keyword || fileSearchText(item).includes(keyword)
    })
  }, [artifacts, filter, query])

  // 复用资料页的列表/网格：产物没有文件夹，全部行都是文件行，
  // 位置列与资料同口径（relativePath 派生，根目录显示「资料」）。
  const rows = useMemo(
    () => filtered.map((item): LibraryRow => ({
      kind: 'file',
      item,
      location: folderLabel(folderOf(item)),
    })),
    [filtered],
  )

  const filters: ReadonlyArray<FileFilterOption<ArtifactFilter>> = [
    { key: 'all', label: '全部产物', count: counts.all },
    { key: 'agent-generated', label: 'Agent 生成', count: counts['agent-generated'] },
    { key: 'artifact-imported', label: '产物导入', count: counts['artifact-imported'] },
  ]

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      onToast('桌面端文件能力不可用')
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      onToast('已导出到「下载/EverOffice」并定位到文件管理器')
    } catch {
      onToast('导出失败，请稍后重试')
    }
  }

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

  const actions: FileItemActions = {
    onOpen: (item) => onOpenFile(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
  }

  return (
    <div className="wb-wspage wb-outputs-page">
      <header className="wb-wspage-head">
        <h1 className="wb-wspage-title">产物</h1>
        <div className="wb-file-head-actions">
          <IconButton
            label="刷新产物"
            icon={<RefreshCw size={15} className={library.refreshing ? 'ui-spin' : undefined} />}
            onClick={library.refresh}
            disabled={library.refreshing}
          />
          <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={() => onOpenPage('library')}>
            去资料
          </Button>
        </div>
      </header>

      {library.state === 'ready' && artifacts.length > 0 ? (
        <FileToolbar
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          filter={filter}
          onFilterChange={setFilter}
          view={view}
          onViewChange={setView}
          searchPlaceholder="搜索产物"
          filterAriaLabel="产物来源筛选"
        />
      ) : null}

      {library.state === 'loading' ? <FileLibraryLoading /> : null}
      {library.state === 'unavailable' ? <FileLibraryUnavailable onRetry={library.refresh} /> : null}

      {library.state === 'ready' && artifacts.length === 0 ? (
        <EmptyState
          className="wb-file-state"
          icon={<PackageOpen size={18} />}
          title="还没有产物"
          action={<Button variant="ghost" onClick={onNewWork}>新建工作</Button>}
        />
      ) : null}

      {library.state === 'ready' && artifacts.length > 0 && filtered.length === 0 ? (
        <FileNoMatches onClear={() => { setQuery(''); setFilter('all') }} />
      ) : null}

      {library.state === 'ready' && filtered.length > 0 ? (
        view === 'list' ? (
          <LibraryList rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} />
        ) : (
          <LibraryGrid rows={rows} actions={actions} onEnterFolder={() => {}} onOpenFile={(item) => actions.onOpen(item)} />
        )
      ) : null}
    </div>
  )
}
