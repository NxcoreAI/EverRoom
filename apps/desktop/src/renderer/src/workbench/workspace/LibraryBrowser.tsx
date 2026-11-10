import { ChevronLeft, ChevronRight, LayoutGrid, List, Search, X } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import type { AgentScratchListing } from '@nxcore/agent-contract'
import type { RealOfficeFile } from '@/office-proto/data'

import { IconButton } from '../ui/primitives'
import type { FileViewMode } from './fileBrowser'
import type { FileItemActions } from './fileItemViews'
import {
  buildLibraryLevel,
  folderCrumbs,
  parentFolderOf,
  levelRows,
  LIBRARY_ROOT_LABEL,
  searchLibrary,
  buildScratchLevel,
  scratchRows,
  TMP_FOLDER_PATH,
  isTmpPath,
  type LibraryRow,
} from './libraryTree'
import { LibraryGrid, LibraryList } from './LibraryViews'

/**
 * 资料浏览器：顶部工具行（返回上一级 / 面包屑 / 搜索 / 网格·列表切换）+ 内容区。
 *
 * 布局照 everoffice 原型「资料」文件管理器：当前目录逐级进入，搜索是**全库**
 * 范围（忽略当前目录），搜索中强制列表视图并禁用视图切换。
 * 当前目录 / 搜索词 / 视图模式是本页局部状态，切走页面即重置（与原型一致）。
 *
 * `.tmp/`（Agent 过程缓存）作为根目录下的保留文件夹展示：scratch 由清单接口
 * 只读派生，不入文件库索引；里面的文件不能打开/删除，只支持在访达中定位。
 *
 * 访达拖放的落点在页面根节点（LibraryPage），空库/加载态也能拖；本组件只管浏览。
 */
export function LibraryBrowser({ items, actions, scratch, onRevealScratch }: {
  items: readonly RealOfficeFile[]
  actions: FileItemActions
  /** `.tmp/` 只读清单；null = 桥不可用/未绑定目录（不显示 .tmp 入口）。 */
  scratch: AgentScratchListing | null
  /** 在访达中定位 `.tmp` 里的文件（参数为相对 `.tmp` 根的路径）。 */
  onRevealScratch: (relativePath: string) => void
}) {
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<FileViewMode>('grid')

  const keyword = query.trim()
  const searching = keyword.length > 0
  const inTmp = isTmpPath(path)
  const level = useMemo(() => buildLibraryLevel(items, path), [items, path])
  const levelRowsList = useMemo(() => levelRows(level), [level])
  const scratchEntries = useMemo(
    () => (scratch?.present ? scratch.entries : []),
    [scratch],
  )
  const scratchLevel = useMemo(
    () => (inTmp ? buildScratchLevel(scratchEntries, path) : null),
    [inTmp, scratchEntries, path],
  )
  const hits = useMemo(() => (searching ? searchLibrary(items, keyword) : null), [items, keyword, searching])

  // 根目录额外挂 .tmp 文件夹（scratch 根存在且有内容时），排在普通目录前。
  const tmpFolderRow: LibraryRow[] = !inTmp && !searching && scratchEntries.length > 0
    ? [{
        kind: 'folder',
        path: TMP_FOLDER_PATH,
        name: TMP_FOLDER_PATH,
        fileCount: 0,
        location: LIBRARY_ROOT_LABEL,
      }]
    : []
  const rows: LibraryRow[] = hits
    ? [...hits.folders, ...hits.files]
    : inTmp && scratchLevel
      ? scratchRows(scratchLevel)
      : [...tmpFolderRow, ...levelRowsList]
  const crumbs = useMemo(() => folderCrumbs(level.path), [level.path])

  // 任何目录跳转（进入 / 返回 / 面包屑）都顺手清掉搜索词：
  // 搜索是全库结果，跳目录后再停在搜索态会让人以为看到的是该目录内容。
  const goTo = (target: string) => {
    setQuery('')
    setPath(target)
  }

  const viewProps = {
    rows,
    actions,
    onEnterFolder: goTo,
    onOpenFile: (item: RealOfficeFile) => actions.onOpen(item),
    onRevealScratch: (row: Extract<LibraryRow, { kind: 'scratch' }>) => onRevealScratch(
      row.path.slice(TMP_FOLDER_PATH.length + 1),
    ),
  }

  return (
    <div className="wb-lib">
      <div className="wb-lib-bar">
        <button
          type="button"
          className="wb-lib-back"
          title="返回上一级"
          aria-label="返回上一级"
          disabled={!level.path || searching}
          onClick={() => goTo(parentFolderOf(level.path))}
        >
          <ChevronLeft size={15} />
        </button>

        <nav className="wb-lib-crumbs" aria-label="当前位置">
          <button
            type="button"
            className={level.path ? undefined : 'is-current'}
            aria-current={level.path ? undefined : 'page'}
            onClick={() => goTo('')}
          >
            {LIBRARY_ROOT_LABEL}
          </button>
          {crumbs.map((crumb) => (
            <Fragment key={crumb.path}>
              <ChevronRight size={12} className="wb-lib-crumb-sep" aria-hidden="true" />
              <button
                type="button"
                className={crumb.path === level.path ? 'is-current' : undefined}
                aria-current={crumb.path === level.path ? 'page' : undefined}
                onClick={() => goTo(crumb.path)}
              >
                {crumb.name}
              </button>
            </Fragment>
          ))}
        </nav>

        <label className="wb-lib-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索文件与文件夹"
            aria-label="搜索文件与文件夹"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="wb-lib-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>

        <div className="wb-lib-views" role="group" aria-label="视图切换">
          <IconButton
            label="网格视图"
            size="sm"
            active={view === 'grid' && !searching}
            disabled={searching}
            icon={<LayoutGrid size={15} />}
            onClick={() => setView('grid')}
          />
          <IconButton
            label="列表视图"
            size="sm"
            active={view === 'list' || searching}
            disabled={searching}
            icon={<List size={15} />}
            onClick={() => setView('list')}
          />
        </div>
      </div>

      {inTmp && scratch?.truncated ? (
        <p className="wb-lib-note">临时文件超过清单上限，以下只显示前 {scratchEntries.length} 项。</p>
      ) : null}

      {rows.length > 0 ? (
        searching || view === 'list'
          ? <LibraryList {...viewProps} />
          : <LibraryGrid {...viewProps} />
      ) : (
        <p className="wb-lib-empty">
          {searching
            ? `没有匹配「${keyword}」的结果`
            : inTmp
              ? '此文件夹为空（临时文件由 Agent 使用过程产生，可能随时被清理）'
              : '此文件夹为空'}
        </p>
      )}
    </div>
  )
}
