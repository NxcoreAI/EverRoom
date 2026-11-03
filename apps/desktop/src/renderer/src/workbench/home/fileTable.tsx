import { Download, ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react'

import type { RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'

/**
 * 「最近」与「所有文件」共用的文件表：表头 + 行（图标 / 文件名 / 修改时间 / 大小 / 更多）。
 *
 * 布局照 everoffice 原型 `FileTable`（`office-proto/pages/parts.tsx`）：表头与行共用
 * 同一份 grid 模板（列宽在 home.css 的 `.wb-home-filetbl*`），整行可点进文件标签，
 * 行尾「⋯」只放本端真实能力——用原应用打开 / 导出定位 / 删除文件，
 * 原型里那三个只弹 toast 的占位项不照搬。
 */

export interface FileRowActions {
  /** 打开文件（进窗口级文件标签）。 */
  onOpen: (item: RealOfficeFile) => void
  /** 交给系统默认应用打开（转换失败/不受支持格式时的兜底）。 */
  onOpenOriginal?: (item: RealOfficeFile) => void
  /** 导出到「下载/EverRoom」并在文件管理器中定位。 */
  onExportReveal?: (item: RealOfficeFile) => void
  /** 删除文件（调用方自己弹二次确认）。 */
  onDelete?: (item: RealOfficeFile) => void
}

/** 表头：列名与空单元格的占位必须和行同构，否则列会错开。 */
export function FileTableHead() {
  return (
    <div className="wb-home-filetbl-head" aria-hidden="true">
      <span />
      <span>文件名</span>
      <span>修改时间</span>
      <span>大小</span>
      <span />
    </div>
  )
}

export function FileTableRow({
  item, actions, menu = true,
}: {
  item: RealOfficeFile
  actions: FileRowActions
  /** 「最近」分栏里行尾不放菜单（列宽窄、入口也不在那一屏）。 */
  menu?: boolean
}) {
  return (
    <div className="wb-home-filerow" title={item.file.name}>
      <FileTypeIcon kind={item.file.kind} size={26} />
      <span className="wb-home-filerow-name">{item.file.name}</span>
      <span className="wb-home-filerow-time">{item.file.updatedLabel}</span>
      <span className="wb-home-filerow-size">{item.file.sizeLabel}</span>
      <span className="wb-home-filerow-actions">
        {menu ? <FileRowMenu item={item} actions={actions} /> : null}
      </span>
      {/* 覆盖整行的透明按钮：整行可点，又不把菜单按钮嵌进另一个按钮里。 */}
      <button
        type="button"
        className="wb-home-filerow-open"
        aria-label={`打开 ${item.file.name}`}
        onClick={() => actions.onOpen(item)}
      />
    </div>
  )
}

function FileRowMenu({ item, actions }: { item: RealOfficeFile; actions: FileRowActions }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        {/* 原生 button：Radix Trigger 的 asChild 需要转发 ref 才能定位浮层。 */}
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--sm"
          aria-label={`${item.file.name} 的操作`}
          title="更多操作"
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<ExternalLink size={14} />} onSelect={() => actions.onOpen(item)}>
          打开
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
