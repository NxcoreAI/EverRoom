import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { TableMap } from '@tiptap/pm/tables'
import {
  Columns3,
  GripHorizontal,
  GripVertical,
  Merge,
  MoreHorizontal,
  PanelLeft,
  PanelTop,
  Plus,
  Rows3,
  Split,
  TableProperties,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { isTableHeaderAxisActive, toggleTableHeaderAxis } from './documentTableHeaders'

type TableMenuKind = 'row' | 'column' | 'cell' | 'table'

interface TableGeometry {
  table: DOMRect
  row: DOMRect
  cell: DOMRect
}

interface OpenMenu {
  kind: TableMenuKind
  left: number
  top: number
}

const TABLE_MENU_WIDTH = 200
const TABLE_MENU_HEIGHT: Record<TableMenuKind, number> = {
  row: 160,
  column: 160,
  cell: 114,
  table: 126,
}

function floatingMenuPosition(kind: TableMenuKind, anchor: DOMRect): Pick<OpenMenu, 'left' | 'top'> {
  const height = TABLE_MENU_HEIGHT[kind]
  const below = anchor.bottom + 6
  return {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - TABLE_MENU_WIDTH - 8)),
    top: below + height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - height - 6),
  }
}

function tableEdgeCellPosition(editor: Editor, edge: 'bottom' | 'right'): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const table = $from.node(depth)
    if (table.type.spec.tableRole !== 'table') continue

    const map = TableMap.get(table)
    if (map.width < 1 || map.height < 1) return null
    const row = edge === 'bottom' ? map.height - 1 : 0
    const column = edge === 'right' ? map.width - 1 : 0
    return $from.start(depth) + map.positionAt(row, column, table)
  }
  return null
}

function appendTableEdge(editor: Editor, edge: 'bottom' | 'right') {
  const position = tableEdgeCellPosition(editor, edge)
  if (position === null) return false
  const bookmark = editor.state.selection.getBookmark()
  const chain = editor.chain().focus().setCellSelection({ anchorCell: position })
  const appended = edge === 'bottom'
    ? chain.addRowAfter()
    : chain.addColumnAfter()
  return appended.command(({ tr }) => {
    tr.setSelection(bookmark.map(tr.mapping).resolve(tr.doc))
    return true
  }).run()
}

function closestCellAtPosition(editor: Editor, position: number): HTMLTableCellElement | null {
  for (const candidate of [position, Math.min(position + 1, editor.state.doc.content.size)]) {
    const dom = editor.view.domAtPos(candidate).node
    const element = dom instanceof Element ? dom : dom.parentElement
    if (!element) continue
    if (element instanceof HTMLTableCellElement) return element
    const closest = element.closest<HTMLTableCellElement>('td, th')
    if (closest) return closest
    const nested = element.querySelector<HTMLTableCellElement>('td, th')
    if (nested) return nested
  }
  return null
}

function tableGeometry(editor: Editor): TableGeometry | null {
  if (!editor.isActive('table')) return null
  const cell = closestCellAtPosition(editor, editor.state.selection.from)
  const row = cell?.closest<HTMLTableRowElement>('tr')
  const table = cell?.closest<HTMLTableElement>('table')
  if (!cell || !row || !table) return null
  return {
    table: table.getBoundingClientRect(),
    row: row.getBoundingClientRect(),
    cell: cell.getBoundingClientRect(),
  }
}

function MenuButton({
  children,
  destructive = false,
  disabled = false,
  icon,
  onClick,
}: {
  children: ReactNode
  destructive?: boolean
  disabled?: boolean
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-destructive={String(destructive)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function TiptapTableControls({ editor }: { editor: Editor }) {
  const { t } = useLocale()
  const [geometry, setGeometry] = useState<TableGeometry | null>(() => tableGeometry(editor))
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const commandState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      active: currentEditor.isActive('table'),
      canAddRow: currentEditor.can().addRowAfter(),
      canAddColumn: currentEditor.can().addColumnAfter(),
      canDeleteRow: currentEditor.can().deleteRow(),
      canDeleteColumn: currentEditor.can().deleteColumn(),
      canMerge: currentEditor.can().mergeCells(),
      canSplit: currentEditor.can().splitCell(),
      canDeleteTable: currentEditor.can().deleteTable(),
      rowIsHeader: isTableHeaderAxisActive(currentEditor.state, 'row'),
      columnIsHeader: isTableHeaderAxisActive(currentEditor.state, 'column'),
    }),
  })

  useEffect(() => {
    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => setGeometry(tableGeometry(editor)))
    }
    const dismissAndUpdate = () => {
      setMenu(null)
      update()
    }
    editor.on('transaction', update)
    editor.on('selectionUpdate', update)
    window.addEventListener('resize', dismissAndUpdate)
    document.addEventListener('scroll', dismissAndUpdate, true)
    update()
    return () => {
      window.cancelAnimationFrame(frame)
      editor.off('transaction', update)
      editor.off('selectionUpdate', update)
      window.removeEventListener('resize', dismissAndUpdate)
      document.removeEventListener('scroll', dismissAndUpdate, true)
    }
  }, [editor])

  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  if (!commandState.active || !geometry) return null

  const openMenu = (kind: TableMenuKind, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      kind,
      ...floatingMenuPosition(kind, rect),
    })
  }
  const run = (command: () => void) => {
    command()
    setMenu(null)
  }

  return (
    <>
      <button
        type="button"
        className="context-room-tiptap-table-handle"
        data-orientation="row"
        aria-label={t('当前行菜单')}
        title={t('当前行菜单')}
        style={{ left: geometry.row.left - 28, top: geometry.row.top + geometry.row.height / 2 - 12 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => openMenu('row', event)}
      >
        <GripVertical />
      </button>
      <button
        type="button"
        className="context-room-tiptap-table-handle"
        data-orientation="column"
        aria-label={t('当前列菜单')}
        title={t('当前列菜单')}
        style={{ left: geometry.cell.left + geometry.cell.width / 2 - 12, top: geometry.table.top - 28 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => openMenu('column', event)}
      >
        <GripHorizontal />
      </button>
      <button
        type="button"
        className="context-room-tiptap-table-handle context-room-tiptap-table-cell-menu-trigger"
        aria-label={t('单元格菜单')}
        title={t('单元格菜单')}
        style={{ left: geometry.cell.right - 25, top: geometry.cell.top + 3 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => openMenu('cell', event)}
      >
        <MoreHorizontal />
      </button>
      <button
        type="button"
        className="context-room-tiptap-table-handle context-room-tiptap-table-menu-trigger"
        aria-label={t('表格菜单')}
        title={t('表格菜单')}
        style={{ left: geometry.table.left - 28, top: geometry.table.top - 28 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => openMenu('table', event)}
      >
        <TableProperties />
      </button>
      <button
        type="button"
        className="context-room-tiptap-table-extend"
        data-orientation="row"
        aria-label={t('在底部添加行')}
        title={t('在底部添加行')}
        disabled={!commandState.canAddRow}
        style={{ left: geometry.table.left, top: geometry.table.bottom + 5, width: geometry.table.width }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => appendTableEdge(editor, 'bottom')}
      >
        <Plus />
      </button>
      <button
        type="button"
        className="context-room-tiptap-table-extend"
        data-orientation="column"
        aria-label={t('在右侧添加列')}
        title={t('在右侧添加列')}
        disabled={!commandState.canAddColumn}
        style={{ left: geometry.table.right + 5, top: geometry.table.top, height: geometry.table.height }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => appendTableEdge(editor, 'right')}
      >
        <Plus />
      </button>

      {menu ? (
        <div
          ref={menuRef}
          className="context-room-tiptap-table-menu"
          role="menu"
          aria-label={t('{kind} 操作', { kind: menu.kind })}
          style={{ left: menu.left, top: menu.top }}
        >
          {menu.kind === 'row' ? (
            <>
              <MenuButton icon={<Plus />} onClick={() => run(() => { editor.chain().focus().addRowBefore().run() })}>{t('在上方插入行')}</MenuButton>
              <MenuButton icon={<Plus />} onClick={() => run(() => { editor.chain().focus().addRowAfter().run() })}>{t('在下方插入行')}</MenuButton>
              <MenuButton icon={<PanelTop />} onClick={() => run(() => { toggleTableHeaderAxis(editor, 'row') })}>{t(commandState.rowIsHeader ? '取消表头行' : '设为表头行')}</MenuButton>
              <span />
              <MenuButton destructive disabled={!commandState.canDeleteRow} icon={<Trash2 />} onClick={() => run(() => { editor.chain().focus().deleteRow().run() })}>{t('删除当前行')}</MenuButton>
            </>
          ) : null}
          {menu.kind === 'column' ? (
            <>
              <MenuButton icon={<Plus />} onClick={() => run(() => { editor.chain().focus().addColumnBefore().run() })}>{t('在左侧插入列')}</MenuButton>
              <MenuButton icon={<Plus />} onClick={() => run(() => { editor.chain().focus().addColumnAfter().run() })}>{t('在右侧插入列')}</MenuButton>
              <MenuButton icon={<PanelLeft />} onClick={() => run(() => { toggleTableHeaderAxis(editor, 'column') })}>{t(commandState.columnIsHeader ? '取消表头列' : '设为表头列')}</MenuButton>
              <span />
              <MenuButton destructive disabled={!commandState.canDeleteColumn} icon={<Trash2 />} onClick={() => run(() => { editor.chain().focus().deleteColumn().run() })}>{t('删除当前列')}</MenuButton>
            </>
          ) : null}
          {menu.kind === 'cell' ? (
            <>
              <MenuButton disabled={!commandState.canMerge} icon={<Merge />} onClick={() => run(() => { editor.chain().focus().mergeCells().run() })}>{t('合并所选单元格')}</MenuButton>
              <MenuButton disabled={!commandState.canSplit} icon={<Split />} onClick={() => run(() => { editor.chain().focus().splitCell().run() })}>{t('拆分单元格')}</MenuButton>
              <MenuButton icon={<Rows3 />} onClick={() => run(() => { editor.chain().focus().toggleHeaderCell().run() })}>{t('切换表头单元格')}</MenuButton>
            </>
          ) : null}
          {menu.kind === 'table' ? (
            <>
              <MenuButton icon={<Rows3 />} onClick={() => run(() => { toggleTableHeaderAxis(editor, 'row') })}>{t(commandState.rowIsHeader ? '取消表头行' : '设为表头行')}</MenuButton>
              <MenuButton icon={<Columns3 />} onClick={() => run(() => { toggleTableHeaderAxis(editor, 'column') })}>{t(commandState.columnIsHeader ? '取消表头列' : '设为表头列')}</MenuButton>
              <span />
              <MenuButton destructive disabled={!commandState.canDeleteTable} icon={<Trash2 />} onClick={() => run(() => { editor.chain().focus().deleteTable().run() })}>{t('删除表格')}</MenuButton>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
