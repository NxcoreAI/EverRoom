import { ChevronRight, FolderOpen } from 'lucide-react'

import type { RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon, FolderGlyphIcon } from '@/office-proto/pages/parts'
import type { FileKind } from '@/office-proto/data'

import { FileItemMenu, type FileItemActions } from './fileItemViews'
import { LIBRARY_ROOT_LABEL, TMP_FOLDER_PATH, type LibraryRow } from './libraryTree'

/**
 * 资料页的两种视图：网格（Finder 式图标瓦片）与列表（文件管理器表格）。
 *
 * 布局照 everoffice 原型 `WsLibraryPage`：文件夹在前、文件在后；网格瓦片无边框、
 * 悬停浅底，列表是「图标 / 名称 / 本地位置 / 修改时间 / 大小 / 操作」六列。
 * 只做展示，进入文件夹与打开文件都通过回调交给页面。
 *
 * `.tmp/`（scratch）行：文件图标 + 「在访达中显示」动作，不支持打开/删除
 * （过程缓存随时被 GC，只读浏览）。
 */

export interface LibraryViewProps {
  rows: readonly LibraryRow[]
  actions: FileItemActions
  onEnterFolder: (path: string) => void
  onOpenFile: (item: RealOfficeFile) => void
  /** scratch 行的「在访达中显示」（参数为相对 `.tmp` 根的路径）。 */
  onRevealScratch?: (row: Extract<LibraryRow, { kind: 'scratch' }>) => void
}

/** scratch 文件的操作按钮（网格瓦片角标 / 列表行尾共用）。 */
function ScratchRevealButton({
  row, onReveal,
}: {
  row: Extract<LibraryRow, { kind: 'scratch' }>
  onReveal?: (row: Extract<LibraryRow, { kind: 'scratch' }>) => void
}) {
  if (!onReveal) return null
  return (
    <button
      type="button"
      className="wb-lib-scratch-reveal"
      title="在访达中显示"
      aria-label={`在访达中显示 ${row.name}`}
      onClick={(event) => {
        event.stopPropagation()
        onReveal(row)
      }}
    >
      <FolderOpen size={13} />
    </button>
  )
}

/** scratch 文件名 → 图标形态（FileKind 只有五值；其余统一按 md 文档图标）。 */
function scratchKindOf(name: string): FileKind {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.pptx')) return 'pptx'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md'
  return 'md'
}

/* ───────────────── 网格 ───────────────── */

export function LibraryGrid({ rows, actions, onEnterFolder, onOpenFile, onRevealScratch }: LibraryViewProps) {
  return (
    <ul className="wb-lib-grid">
      {rows.map((row) => (
        row.kind === 'folder' ? (
          <li key={`folder:${row.path}`}>
            <button
              type="button"
              className="wb-lib-tile"
              title={row.path === TMP_FOLDER_PATH ? `${TMP_FOLDER_PATH}（Agent 过程缓存，只读）` : row.path}
              onClick={() => onEnterFolder(row.path)}
            >
              <FolderGlyphIcon size={44} />
              <span className="wb-lib-tile-name">{row.name}</span>
              <span className="wb-lib-tile-meta">
                {row.path === TMP_FOLDER_PATH ? '临时文件' : `${row.fileCount} 项`}
              </span>
            </button>
          </li>
        ) : row.kind === 'scratch' ? (
          <li key={`scratch:${row.path}`} className="wb-lib-tile-wrap">
            <div className="wb-lib-tile wb-lib-tile-static" title={`${row.name}\n${row.location}`}>
              <FileTypeIcon kind={scratchKindOf(row.name)} size={46} />
              <span className="wb-lib-tile-name">{row.name}</span>
              <ScratchRevealButton row={row} onReveal={onRevealScratch} />
            </div>
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

/** scratch（.tmp 临时文件）行：只读，提供访达定位。 */
function ScratchRow({
  row, onReveal,
}: {
  row: Extract<LibraryRow, { kind: 'scratch' }>
  onReveal?: (row: Extract<LibraryRow, { kind: 'scratch' }>) => void
}) {
  return (
    <li className="wb-lib-row">
      <div className="wb-lib-row-main wb-lib-row-static" title={`${row.name}\n${row.location}`}>
        <FileTypeIcon kind={scratchKindOf(row.name)} size={36} />
        <span className="wb-lib-name">{row.name}</span>
        <span className="wb-lib-loc">{row.location}</span>
        <span className="wb-lib-time">{row.modifiedLabel}</span>
        <span className="wb-lib-size">{row.sizeLabel}</span>
      </div>
      <ScratchRevealButton row={row} onReveal={onReveal} />
    </li>
  )
}

export function LibraryList({ rows, actions, onEnterFolder, onOpenFile, onRevealScratch }: LibraryViewProps) {
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
          ) : row.kind === 'scratch' ? (
            <ScratchRow key={`scratch:${row.path}`} row={row} onReveal={onRevealScratch} />
          ) : (
            <FileRow key={row.item.file.id} row={row} actions={actions} onOpenFile={onOpenFile} />
          )
        ))}
      </ul>
    </div>
  )
}
