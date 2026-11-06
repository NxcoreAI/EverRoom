import { AlertTriangle, LayoutGrid, List, Plus, Search, X } from 'lucide-react'

import type { RealOfficeFile } from '@/office-proto/data'

import { cn } from '../ui/cn'
import { Button, EmptyState, IconButton, Spinner } from '../ui/primitives'
import { isArtifactSourceKind } from './artifactKind'

/**
 * 资料页 / 产物页共用的浏览件：搜索/排序纯函数、工具条、加载与空态、导入按钮。
 * 资料的网格与列表在 LibraryViews.tsx（产物页也复用它们，两页同一套列表排序 UI）；
 * 行内操作菜单在 fileItemViews.tsx。
 *
 * 只做纯展示 + 前端派生；打开文件一律通过页面的回调（→ 气泡窗），本模块不碰 IPC。
 */

/* ───────────────── 产物口径 ───────────────── */

/**
 * 产物页口径：只有 `agent-generated` / `artifact-imported` 算产物。
 * 判据本体在 `artifactKind.ts`（概览动态也用它，避免两处各写一遍）。
 */
export function isArtifactFile(item: RealOfficeFile): boolean {
  return isArtifactSourceKind(item.catalog.sourceKind)
}

/* ───────────────── 搜索 / 排序 ───────────────── */

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
      {/* 与资料页工具行同构：筛选 chips 在左（对应资料的位置区），搜索靠右、
          视图切换在尾——搜索框与切换按钮直接复用 .wb-lib-* 样式，保证两页一致。 */}
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

      <label className="wb-lib-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="wb-lib-search-clear"
            title="清空搜索"
            aria-label="清空搜索"
            onClick={() => onQueryChange('')}
          >
            <X size={12} />
          </button>
        ) : null}
      </label>

      <div className="wb-lib-views" role="group" aria-label="视图切换">
        <IconButton
          label="网格视图"
          size="sm"
          active={view === 'grid'}
          icon={<LayoutGrid size={15} />}
          onClick={() => onViewChange('grid')}
        />
        <IconButton
          label="列表视图"
          size="sm"
          active={view === 'list'}
          icon={<List size={15} />}
          onClick={() => onViewChange('list')}
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
      title="资料暂不可用"
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

/* ───────────────── 页头按钮组（可选复用） ───────────────── */

export function FileImportButton({ importing, onClick }: { importing: boolean; onClick: () => void }) {
  return (
    <Button variant="primary" icon={<Plus size={15} />} disabled={importing} onClick={onClick}>
      {importing ? '导入中…' : '导入文件'}
    </Button>
  )
}
