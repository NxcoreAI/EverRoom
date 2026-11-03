import {
  Download,
  ExternalLink,
  MoreHorizontal,
  PanelRightOpen,
  Stamp,
  Trash2,
} from 'lucide-react'

import type { RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'

/**
 * 产物页的行 / 卡片及其操作菜单（资料库改用 LibraryViews 的网格/列表）。
 *
 * 只做纯展示 + 点开回调；打开文件一律通过 `FileItemActions.onOpen`
 * （页面转交 WorkspacePageProps.onOpenFile → 气泡窗），本模块不碰任何 IPC。
 */

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

export function FileItemMenu({ item, actions, align = 'end' }: {
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

export function FileList({ items, actions }: {
  items: readonly RealOfficeFile[]
  actions: FileItemActions
}) {
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
