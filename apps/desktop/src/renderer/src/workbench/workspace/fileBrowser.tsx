import {
  AlertTriangle,
  Download,
  ExternalLink,
  FolderClosed,
  LayoutGrid,
  List,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
  Stamp,
  Search,
  Trash2,
} from 'lucide-react'

import { type FileCatalogDto } from '@/shared/ingest'

import type { RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { cn } from '../ui/cn'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { Button, EmptyState, IconButton, Spinner } from '../ui/primitives'

/**
 * 资料库 / 产物页共用的文件浏览件。
 *
 * 只做纯展示 + 前端筛选；打开文件一律通过 `FileItemActions.onOpen`（页面转交
 * WorkspacePageProps.onOpenFile → 气泡窗），本模块不碰任何 IPC。
 */

/* ───────────────── 来源筛选 ───────────────── */

export type SourceFilterKey = 'all' | 'manual' | 'local-folder' | 'connector' | 'agent'

export const SOURCE_FILTERS: ReadonlyArray<{ key: SourceFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'manual', label: '手动上传' },
  { key: 'local-folder', label: '本地文件夹' },
  { key: 'connector', label: '连接器' },
  { key: 'agent', label: 'Agent 生成' },
]

/** 产物页口径：只有这两类 sourceKind 算产物（`ROOM_ARTIFACT_SOURCE_KINDS`）。 */
export const ARTIFACT_SOURCE_KINDS: ReadonlyArray<FileCatalogDto['sourceKind']> = [
  'agent-generated',
  'artifact-imported',
]

export function isArtifactFile(item: RealOfficeFile): boolean {
  return ARTIFACT_SOURCE_KINDS.includes(item.catalog.sourceKind)
}

/**
 * sourceKind → 筛选项。
 * `web-clipper` / `artifact-imported` / `migration`（DB 有、DTO 无）不单列，
 * 只出现在「全部」里，避免造出不存在的分类；`legacy-upload` 归入手动上传。
 */
export function fileSourceGroup(catalog: FileCatalogDto): SourceFilterKey {
  switch (catalog.sourceKind) {
    case 'manual-upload':
    case 'legacy-upload':
      return 'manual'
    case 'local-folder':
      return 'local-folder'
    case 'connector':
      return 'connector'
    case 'agent-generated':
      return 'agent'
    default:
      return 'all'
  }
}

export function matchesSourceFilter(item: RealOfficeFile, filter: SourceFilterKey): boolean {
  if (filter === 'all') return true
  return fileSourceGroup(item.catalog) === filter
}

export function countSourceFilters(items: readonly RealOfficeFile[]): Record<SourceFilterKey, number> {
  const counts: Record<SourceFilterKey, number> = {
    all: items.length,
    manual: 0,
    'local-folder': 0,
    connector: 0,
    agent: 0,
  }
  for (const item of items) {
    const group = fileSourceGroup(item.catalog)
    if (group !== 'all') counts[group] += 1
  }
  return counts
}

/* ───────────────── 搜索 / 排序 / 分组 ───────────────── */

/** 搜索口径：文件名（含原始名）+ 相对路径 + 来源标签 + 标签词。 */
export function fileSearchText(item: RealOfficeFile): string {
  const catalog = item.catalog
  return [
    item.file.name,
    catalog.originalName,
    catalog.relativePath ?? '',
    catalog.sourceLabel,
    ...catalog.tags,
  ]
    .join('\n')
    .toLowerCase()
}

export function filterLibraryFiles(
  items: readonly RealOfficeFile[],
  query: string,
  filter: SourceFilterKey,
): RealOfficeFile[] {
  const keyword = query.trim().toLowerCase()
  return items.filter((item) => {
    if (!matchesSourceFilter(item, filter)) return false
    if (!keyword) return true
    return fileSearchText(item).includes(keyword)
  })
}

export function sortFilesByUpdatedDesc(items: readonly RealOfficeFile[]): RealOfficeFile[] {
  return [...items].sort((left, right) => {
    const leftAt = Date.parse(left.catalog.updatedAt)
    const rightAt = Date.parse(right.catalog.updatedAt)
    if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return 0
    return rightAt - leftAt
  })
}

/** 相对路径的父目录；`docs/a.docx` → `docs`，根目录文件 → ''。 */
export function directoryOf(relativePath: string | null): string {
  if (!relativePath) return ''
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

export interface FileGroup {
  /** 目录名（根目录为空串）。 */
  key: string
  label: string
  items: RealOfficeFile[]
}

/** 按来源内相对目录分组，保留传入顺序（调用方先按更新时间倒序）。 */
export function groupFilesByDirectory(items: readonly RealOfficeFile[]): FileGroup[] {
  const groups = new Map<string, RealOfficeFile[]>()
  for (const item of items) {
    const dir = directoryOf(item.catalog.relativePath)
    const bucket = groups.get(dir)
    if (bucket) bucket.push(item)
    else groups.set(dir, [item])
  }
  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    label: key || '文件库根目录',
    items: groupItems,
  }))
}

/* ───────────────── 工具条 ───────────────── */

export interface FileFilterOption<K extends string> {
  key: K
  label: string
  count?: number
}

export type FileViewMode = 'list' | 'grid'

export function FileToolbar<K extends string>({
  query, onQueryChange, filters, filter, onFilterChange, view, onViewChange,
  searchPlaceholder = '搜索文件', filterAriaLabel = '来源筛选',
}: {
  query: string
  onQueryChange: (query: string) => void
  filters: ReadonlyArray<FileFilterOption<K>>
  filter: K
  onFilterChange: (filter: K) => void
  view: FileViewMode
  onViewChange: (view: FileViewMode) => void
  searchPlaceholder?: string
  filterAriaLabel?: string
}) {
  return (
    <div className="wb-file-toolbar">
      <label className="wb-file-search">
        <Search size={14} className="wb-file-search-icon" aria-hidden="true" />
        <input
          className="ui-input"
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>

      <div className="wb-file-filters" role="group" aria-label={filterAriaLabel}>
        {filters.map((option) => {
          const active = option.key === filter
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={active}
              className={cn('wb-file-chip', active && 'is-active')}
              onClick={() => onFilterChange(option.key)}
            >
              {option.label}
              {typeof option.count === 'number' ? <span className="wb-file-chip-count">{option.count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="wb-file-viewtoggle" role="group" aria-label="视图切换">
        <IconButton
          label="列表视图"
          size="sm"
          active={view === 'list'}
          icon={<List size={15} />}
          onClick={() => onViewChange('list')}
        />
        <IconButton
          label="网格视图"
          size="sm"
          active={view === 'grid'}
          icon={<LayoutGrid size={15} />}
          onClick={() => onViewChange('grid')}
        />
      </div>
    </div>
  )
}

/* ───────────────── 加载 / 不可用 / 空态 ───────────────── */

export function FileLibraryLoading({ label = '读取中…' }: { label?: string }) {
  return (
    <div className="wb-file-loading" role="status">
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  )
}

export function FileLibraryUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <EmptyState
      className="wb-file-state is-unavailable"
      icon={<AlertTriangle size={18} />}
      title="文件库暂不可用"
      action={onRetry ? <Button variant="secondary" onClick={onRetry}>重试</Button> : null}
    />
  )
}

export function FileNoMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      className="wb-file-state"
      icon={<Search size={18} />}
      title="没有匹配的文件"
      action={<Button variant="secondary" onClick={onClear}>清除搜索与筛选</Button>}
    />
  )
}

/* ───────────────── 行操作菜单 ───────────────── */

export interface FileItemActions {
  /** 交给注入的 onOpenFile → 工作空间右侧气泡窗。 */
  onOpen: (item: RealOfficeFile) => void
  onOpenOriginal?: (item: RealOfficeFile) => void
  onExportReveal?: (item: RealOfficeFile) => void
  /** 把资料库文件设为当前工作区的论文排版模版（AI 面板「排版」里可见）。 */
  onSetThesisTemplate?: (item: RealOfficeFile) => void
  onDelete?: (item: RealOfficeFile) => void
}

/** 论文模版只收 Word/PDF（与网关 thesis-format 解析入口一致）。 */
function canBeThesisTemplate(item: RealOfficeFile): boolean {
  return /\.(docx?|pdf)$/i.test(item.file.name)
}

function FileItemMenu({ item, actions, align = 'end' }: {
  item: RealOfficeFile
  actions: FileItemActions
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        {/* 用原生 button（而非 IconButton）：Radix Trigger asChild 需要转发 ref 才能定位浮层。 */}
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--sm wb-file-menu-trigger"
          aria-label={`${item.file.name} 的操作`}
          title="更多操作"
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align={align}>
        <MenuItem icon={<PanelRightOpen size={14} />} onSelect={() => actions.onOpen(item)}>
          在气泡窗打开
        </MenuItem>
        {actions.onOpenOriginal ? (
          <MenuItem icon={<ExternalLink size={14} />} onSelect={() => actions.onOpenOriginal?.(item)}>
            用原应用打开
          </MenuItem>
        ) : null}
        {actions.onExportReveal ? (
          <MenuItem icon={<Download size={14} />} onSelect={() => actions.onExportReveal?.(item)}>
            导出定位
          </MenuItem>
        ) : null}
        {actions.onSetThesisTemplate && canBeThesisTemplate(item) ? (
          <MenuItem icon={<Stamp size={14} />} onSelect={() => actions.onSetThesisTemplate?.(item)}>
            设为论文排版模版
          </MenuItem>
        ) : null}
        {actions.onDelete ? (
          <>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => actions.onDelete?.(item)}>
              删除文件…
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  )
}

/* ───────────────── 列表 ───────────────── */

function FileRow({ item, actions }: { item: RealOfficeFile; actions: FileItemActions }) {
  const path = item.catalog.relativePath
  return (
    <li className="wb-file-row">
      <button
        type="button"
        className="wb-file-row-main"
        title={path ? `${item.file.name}\n${path}` : item.file.name}
        onClick={() => actions.onOpen(item)}
      >
        <FileTypeIcon kind={item.file.kind} size={26} />
        <span className="wb-file-row-name">
          <span className="wb-file-row-title">{item.file.name}</span>
          <span className="wb-file-row-path">{path || '文件库根目录'}</span>
        </span>
        <span className="wb-file-row-source">{item.catalog.sourceLabel}</span>
        <span className="wb-file-row-time">{item.file.updatedLabel}</span>
        <span className="wb-file-row-size">{item.file.sizeLabel}</span>
      </button>
      <FileItemMenu item={item} actions={actions} />
    </li>
  )
}

export function FileList({ items, groups, actions }: {
  items: readonly RealOfficeFile[]
  /** 传了就按目录分组渲染；不传则是平铺（搜索结果 / 产物页）。 */
  groups?: readonly FileGroup[]
  actions: FileItemActions
}) {
  if (groups && groups.length > 0) {
    return (
      <div className="wb-file-list">
        {groups.map((group) => (
          <section className="wb-file-group" key={group.key || '__root'}>
            <h2 className="wb-file-group-head">
              <FolderClosed size={14} aria-hidden="true" />
              <span className="wb-file-group-label">{group.label}</span>
              <span className="wb-file-group-count">{group.items.length}</span>
            </h2>
            <ul className="wb-file-rows">
              {group.items.map((item) => <FileRow key={item.file.id} item={item} actions={actions} />)}
            </ul>
          </section>
        ))}
      </div>
    )
  }
  return (
    <div className="wb-file-list">
      <ul className="wb-file-rows">
        {items.map((item) => <FileRow key={item.file.id} item={item} actions={actions} />)}
      </ul>
    </div>
  )
}

/* ───────────────── 网格 ───────────────── */

function FileCard({ item, actions }: { item: RealOfficeFile; actions: FileItemActions }) {
  const path = item.catalog.relativePath
  return (
    <li className="wb-file-card">
      <button
        type="button"
        className="wb-file-card-main"
        title={path ? `${item.file.name}\n${path}` : item.file.name}
        onClick={() => actions.onOpen(item)}
      >
        <FileTypeIcon kind={item.file.kind} size={32} />
        <span className="wb-file-card-name">{item.file.name}</span>
        <span className="wb-file-card-path">{path || '文件库根目录'}</span>
        <span className="wb-file-card-meta">
          <span>{item.catalog.sourceLabel}</span>
          <span>{item.file.updatedLabel}</span>
          <span>{item.file.sizeLabel}</span>
        </span>
      </button>
      <FileItemMenu item={item} actions={actions} align="start" />
    </li>
  )
}

export function FileGrid({ items, actions }: {
  items: readonly RealOfficeFile[]
  actions: FileItemActions
}) {
  return (
    <ul className="wb-file-grid">
      {items.map((item) => <FileCard key={item.file.id} item={item} actions={actions} />)}
    </ul>
  )
}

/* ───────────────── 页头按钮组（可选复用） ───────────────── */

export function FileImportButton({ importing, onClick }: { importing: boolean; onClick: () => void }) {
  return (
    <Button variant="primary" icon={<Plus size={15} />} disabled={importing} onClick={onClick}>
      {importing ? '导入中…' : '导入文件'}
    </Button>
  )
}
