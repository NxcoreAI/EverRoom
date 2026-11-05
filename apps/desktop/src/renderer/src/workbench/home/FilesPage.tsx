import { FolderOpen, LayoutGrid, List, RotateCw, Search, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { type FileKind, type RealOfficeFile, kindMeta } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { workbenchToast } from '../shell/toast'
import { cn } from '../ui/cn'
import { ConfirmModal } from '../ui/modal'
import { Button, EmptyState, PageHeader } from '../ui/primitives'
import { FileTableHead, FileTableRow, type FileRowActions } from './fileTable'
import { HomeSkeleton } from './parts'
import { useFileLibrary } from './useFileLibrary'

type ViewMode = 'list' | 'grid'
type KindFilter = 'all' | FileKind

const ALL_KINDS = 'all'
/** 一次装载的目录条数上限（`files.list` 的分页大小）：超出时页面会说明只列最近这些。 */
const LOAD_LIMIT = 200

/** 类型筛选标签的顺序与原型 `FileTable` 一致：全部 / 文档 / 表格 / 演示 / PDF / Markdown。 */
const KIND_ORDER: readonly FileKind[] = ['docx', 'xlsx', 'pptx', 'pdf', 'md']

/**
 * 所有文件页，布局照 everoffice 原型 `pages/AllFilesView.tsx` + `FileTable`：
 *
 * 页头（标题 + 「共 N 个文件」+ 导入）→ 工具行（类型标签 / 文件名搜索 / 列表·网格切换）
 * → 无外框平铺表格（表头 + 文件行：图标 / 文件名 / 修改时间 / 大小 / 操作）。
 *
 * 原型里「网格视图暂未开放」和行尾「⋯」只弹 toast；这里两者都是真功能：
 * 网格是文件瓦片，行菜单能打开原应用、导出定位、删除。
 * 来源筛选标签是本端曾有的扩展，原型没有这一行，已按原型去除。
 */
export function FilesPage() {
  const openFileInWorkspace = useWorkbenchStore((state) => state.openFileInWorkspace)
  const files = useFileLibrary(LOAD_LIMIT)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>(ALL_KINDS)
  const [view, setView] = useState<ViewMode>('list')
  const [importing, setImporting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RealOfficeFile | null>(null)
  const [deleting, setDeleting] = useState(false)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.items.filter((item) => {
      if (kind !== ALL_KINDS && item.file.kind !== kind) return false
      return !keyword || item.file.name.toLowerCase().includes(keyword)
    })
  }, [files.items, kind, query])

  const canImport = typeof window.nxcore?.files?.pickAndImport === 'function'

  const handleImport = async () => {
    if (importing || !canImport) return
    setImporting(true)
    try {
      const outcomes = await window.nxcore!.files.pickAndImport()
      const imported = outcomes?.length ?? 0
      if (imported > 0) {
        workbenchToast(`已导入 ${imported} 个文件`)
        files.reload()
      }
    } catch (error) {
      workbenchToast(error instanceof Error && error.message ? error.message : '导入文件失败')
    } finally {
      setImporting(false)
    }
  }

  /** 交给系统默认应用打开（不受支持/旧格式转换失败时的兜底）。 */
  const openOriginal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.openOriginal !== 'function') {
      workbenchToast('桌面端文件能力不可用')
      return
    }
    try {
      const result = await api.openOriginal(item.catalog.id, item.catalog.originalName, item.catalog.contentHash)
      workbenchToast(result.openedWith === 'office' ? `已打开「${item.file.name}」` : '已用系统默认应用打开')
    } catch {
      workbenchToast('打开失败，请稍后重试')
    }
  }

  const exportReveal = async (item: RealOfficeFile) => {
    const api = window.nxcore?.files
    if (!api || typeof api.exportReveal !== 'function') {
      workbenchToast('桌面端文件能力不可用')
      return
    }
    try {
      await api.exportReveal(item.catalog.id, item.catalog.originalName)
      workbenchToast('已导出到「下载/EverOffice」并定位到文件管理器')
    } catch {
      workbenchToast('导出失败，请稍后重试')
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    const api = window.nxcore?.files
    if (!api || typeof api.delete !== 'function') {
      workbenchToast('桌面端文件能力不可用')
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    try {
      await api.delete(target.catalog.id)
      workbenchToast(`已删除「${target.file.name}」`)
      setPendingDelete(null)
      files.reload()
    } catch {
      workbenchToast('删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  const rowActions: FileRowActions = {
    onOpen: (item) => openFileInWorkspace(item.file),
    onOpenOriginal: (item) => { void openOriginal(item) },
    onExportReveal: (item) => { void exportReveal(item) },
    onDelete: (item) => setPendingDelete(item),
  }

  // 页头副标题与原型同款句式：只说「共 N 个文件」（见 PageHead hint）。
  const subtitle = files.state === 'ready'
    ? files.total > files.items.length
      ? `共 ${files.total} 个文件，其中 ${files.items.length} 个可在此打开（按最近更新排序）。`
      : `共 ${files.items.length} 个文件`
    : files.state === 'loading'
      ? '正在读取资料…'
      : '资料暂不可用。'

  /** 工具行左侧的类型标签（原型 `Seg`：胶囊裸标签，不带计数徽标）。 */
  const kindTabs: Array<{ key: KindFilter; label: string }> = [
    { key: ALL_KINDS, label: '全部' },
    ...KIND_ORDER.map((item) => ({ key: item as KindFilter, label: kindMeta[item].label })),
  ]

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title="所有文件"
        subtitle={subtitle}
        actions={(
          <Button
            variant="primary"
            icon={<Upload size={15} />}
            disabled={!canImport || importing}
            title={canImport ? '导入本地文件' : '桌面文件服务未就绪，暂时无法导入'}
            onClick={() => { void handleImport() }}
          >
            {importing ? '导入中…' : '导入文件'}
          </Button>
        )}
      />

      {files.state === 'loading' ? <HomeSkeleton rows={5} /> : null}

      {files.state === 'unavailable' ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title="资料暂不可用"
          description="桌面文件服务没有响应。重试一次；仍然失败请重启 EverOffice。"
          action={<Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={files.reload}>重试</Button>}
        />
      ) : null}

      {files.state === 'ready' && files.items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title="资料还没有文件"
          description="导入本地文档，或从连接器同步资料，之后就能在这里打开。"
          action={canImport ? (
            <Button variant="primary" size="sm" icon={<Upload size={13} />} onClick={() => { void handleImport() }}>
              导入文件
            </Button>
          ) : null}
        />
      ) : null}

      {files.state === 'ready' && files.items.length > 0 ? (
        <div className="wb-home-filetbl">
          <div className="wb-home-filetbl-bar">
            <div className="wb-home-ft-seg" role="tablist" aria-label="按类型筛选">
              {kindTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={kind === tab.key}
                  className={cn('wb-home-ft-seg-btn', kind === tab.key && 'active')}
                  onClick={() => setKind(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="wb-home-ft-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索文件"
                placeholder="搜索文件名…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  className="wb-home-ft-search-clear"
                  type="button"
                  title="清空"
                  aria-label="清空搜索"
                  onClick={() => setQuery('')}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <div className="wb-home-ft-views" role="group" aria-label="文件视图">
              <button
                type="button"
                className={cn(view === 'list' && 'active')}
                title="列表视图"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <List size={15} />
              </button>
              <button
                type="button"
                className={cn(view === 'grid' && 'active')}
                title="网格视图"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <LayoutGrid size={15} />
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="wb-home-filetbl-empty">没有匹配的文件。</div>
          ) : view === 'list' ? (
            <>
              <FileTableHead />
              {filtered.map((item) => (
                <FileTableRow key={item.file.id} item={item} actions={rowActions} iconSize={36} />
              ))}
            </>
          ) : (
            <div className="wb-home-filetbl-grid">
              <div className="wb-home-file-grid">
                {filtered.map((item) => (
                  <button
                    key={item.file.id}
                    type="button"
                    className="wb-home-file-tile"
                    title={item.file.name}
                    onClick={() => openFileInWorkspace(item.file)}
                  >
                    <FileTypeIcon kind={item.file.kind} size={38} />
                    <span className="wb-home-file-tile-name">{item.file.name}</span>
                    <span className="wb-home-file-tile-meta">
                      {[item.catalog.sourceLabel, item.file.updatedLabel].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {files.state === 'ready' && files.total > LOAD_LIMIT ? (
        <p className="wb-home-footnote">
          文件较多，这里只列出最近的 {LOAD_LIMIT} 个。
        </p>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(next) => { if (!next) setPendingDelete(null) }}
        title="删除文件？"
        description={pendingDelete
          ? `「${pendingDelete.file.name}」会从资料移除，相关项目空间里也不再可见。`
          : undefined}
        confirmLabel={deleting ? '删除中…' : '删除'}
        busy={deleting}
        onConfirm={() => { void confirmDelete() }}
      />
    </div>
  )
}
