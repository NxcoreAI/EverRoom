import { ChevronRight } from 'lucide-react'

import type { RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon, FolderGlyphIcon } from '@/office-proto/pages/parts'

import { FileItemMenu, type FileItemActions } from './fileItemViews'
import { LIBRARY_ROOT_LABEL, type LibraryRow } from './libraryTree'

/**
 * 资料库的两种视图：网格（Finder 式图标瓦片）与列表（文件管理器表格）。
 *
 * 布局照 everoffice 原型 `WsLibraryPage`：文件夹在前、文件在后；网格瓦片无边框、
 * 悬停浅底，列表是「图标 / 名称 / 本地位置 / 修改时间 / 大小 / 操作」六列。
 * 只做展示，进入文件夹与打开文件都通过回调交给页面。
 */

export interface LibraryViewProps {
  rows: readonly LibraryRow[]
  actions: FileItemActions
  onEnterFolder: (path: string) => void
  onOpenFile: (item: RealOfficeFile) => void
}

/* ───────────────── 网格 ───────────────── */

export function LibraryGrid({ rows, actions, onEnterFolder, onOpenFile }: LibraryViewProps) {
  return (
    <ul className="wb-lib-grid">
      {rows.map((row) => (
        row.kind === 'folder' ? (
          <li key={`folder:${row.path}`}>
            <button
              type="button"
              className="wb-lib-tile"
              title={row.path}
              onClick={() => onEnterFolder(row.path)}
            >
              <FolderGlyphIcon size={44} />
              <span className="wb-lib-tile-name">{row.name}</span>
              <span className="wb-lib-tile-meta">{row.fileCount} 项</span>
            </button>
          </li>
        ) : (
          <li key={row.item.file.id} className="wb-lib-tile-wrap">
            <button
              type="button"
              className="wb-lib-tile"
              title={row.location === LIBRARY_ROOT_LABEL ? row.item.file.name : `${row.item.file.name}\n${row.location}`}
              onClick={() => onOpenFile(row.item)}
            >
              <FileTypeIcon kind={row.item.file.kind} size={46} />
              <span className="wb-lib-tile-name">{row.item.file.name}</span>
              <span className="wb-lib-tile-meta">{row.item.file.updatedLabel}</span>
            </button>
            <FileItemMenu item={row.item} actions={actions} align="start" />
          </li>
        )
      ))}
    </ul>
  )
}

/* ───────────────── 列表 ───────────────── */

function FolderRow({
  row, onEnterFolder,
}: {
  row: Extract<LibraryRow, { kind: 'folder' }>
  onEnterFolder: (path: string) => void
}) {
  return (
    <li className="wb-lib-row">
      <button
        type="button"
        className="wb-lib-row-main"
        title={row.path}
        onClick={() => onEnterFolder(row.path)}
      >
        <FolderGlyphIcon size={36} />
        <span className="wb-lib-name">{row.name}</span>
        <span className="wb-lib-loc">{row.location}</span>
        <span className="wb-lib-time">—</span>
        <span className="wb-lib-size">{row.fileCount} 项</span>
      </button>
      <ChevronRight size={14} className="wb-lib-enter" aria-hidden="true" />
    </li>
  )
}

function FileRow({
  row, actions, onOpenFile,
}: {
  row: Extract<LibraryRow, { kind: 'file' }>
  actions: FileItemActions
  onOpenFile: (item: RealOfficeFile) => void
}) {
  const { item } = row
  return (
    <li className="wb-lib-row">
      <button
        type="button"
        className="wb-lib-row-main"
        title={row.location === LIBRARY_ROOT_LABEL ? item.file.name : `${item.file.name}\n${row.location}`}
        onClick={() => onOpenFile(item)}
      >
        <FileTypeIcon kind={item.file.kind} size={36} />
        <span className="wb-lib-name">{item.file.name}</span>
        <span className="wb-lib-loc">{row.location}</span>
        <span className="wb-lib-time">{item.file.updatedLabel}</span>
        <span className="wb-lib-size">{item.file.sizeLabel}</span>
      </button>
      <FileItemMenu item={item} actions={actions} />
    </li>
  )
}

export function LibraryList({ rows, actions, onEnterFolder, onOpenFile }: LibraryViewProps) {
  return (
    <div className="wb-lib-list">
      <div className="wb-lib-head" aria-hidden="true">
        <span />
        <span>名称</span>
        <span>本地位置</span>
        <span>修改时间</span>
        <span>大小</span>
        <span />
      </div>
      <ul className="wb-lib-rows">
        {rows.map((row) => (
          row.kind === 'folder' ? (
            <FolderRow key={`folder:${row.path}`} row={row} onEnterFolder={onEnterFolder} />
          ) : (
            <FileRow key={row.item.file.id} row={row} actions={actions} onOpenFile={onOpenFile} />
          )
        ))}
      </ul>
    </div>
  )
}
