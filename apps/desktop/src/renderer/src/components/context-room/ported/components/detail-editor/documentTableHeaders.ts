import type { Editor } from '@tiptap/react'
import type { EditorState } from '@tiptap/pm/state'
import { selectedRect } from '@tiptap/pm/tables'

export type TableHeaderAxis = 'row' | 'column'

function cellPositionsForAxis(state: EditorState, axis: TableHeaderAxis): {
  candidates: number[]
  headerType: NonNullable<EditorState['schema']['nodes'][string]>
  cellType: NonNullable<EditorState['schema']['nodes'][string]>
  tableStart: number
} | null {
  const headerType = state.schema?.nodes?.tableHeader
  const cellType = state.schema?.nodes?.tableCell
  if (!headerType || !cellType) return null

  let rect: ReturnType<typeof selectedRect>
  try {
    rect = selectedRect(state)
  } catch {
    return null
  }

  const targetRect = axis === 'row'
    ? { left: 0, top: rect.top, right: rect.map.width, bottom: rect.bottom }
    : { left: rect.left, top: 0, right: rect.right, bottom: rect.map.height }
  const targetPositions = rect.map.cellsInRect(targetRect)
  const preserved = new Set<number>()

  if (axis === 'row') {
    for (let column = 0; column < rect.map.width; column += 1) {
      const positions = rect.map.cellsInRect({
        left: column,
        top: 0,
        right: column + 1,
        bottom: rect.map.height,
      })
      if (positions.length > 0 && positions.every((position) => rect.table.nodeAt(position)?.type === headerType)) {
        for (const position of rect.map.cellsInRect({
          left: column,
          top: rect.top,
          right: column + 1,
          bottom: rect.bottom,
        })) preserved.add(position)
      }
    }
  } else {
    for (let row = 0; row < rect.map.height; row += 1) {
      const positions = rect.map.cellsInRect({
        left: 0,
        top: row,
        right: rect.map.width,
        bottom: row + 1,
      })
      if (positions.length > 0 && positions.every((position) => rect.table.nodeAt(position)?.type === headerType)) {
        for (const position of rect.map.cellsInRect({
          left: rect.left,
          top: row,
          right: rect.right,
          bottom: row + 1,
        })) preserved.add(position)
      }
    }
  }

  const editablePositions = targetPositions.filter((position) => !preserved.has(position))
  return {
    candidates: editablePositions.length > 0 ? editablePositions : targetPositions,
    headerType,
    cellType,
    tableStart: rect.tableStart,
  }
}

export function isTableHeaderAxisActive(state: EditorState, axis: TableHeaderAxis): boolean {
  const target = cellPositionsForAxis(state, axis)
  return Boolean(target?.candidates.length && target.candidates.every(
    (position) => state.doc.nodeAt(target.tableStart + position)?.type === target.headerType,
  ))
}

export function toggleTableHeaderAxis(editor: Editor, axis: TableHeaderAxis): boolean {
  return editor.commands.command(({ state, tr, dispatch }) => {
    const target = cellPositionsForAxis(state, axis)
    if (!target?.candidates.length) return false
    if (!dispatch) return true

    const nextType = target.candidates.every(
      (position) => tr.doc.nodeAt(target.tableStart + position)?.type === target.headerType,
    ) ? target.cellType : target.headerType

    for (const position of target.candidates) {
      const documentPosition = target.tableStart + position
      const cell = tr.doc.nodeAt(documentPosition)
      if (cell && cell.type !== nextType) tr.setNodeMarkup(documentPosition, nextType, cell.attrs)
    }
    return true
  })
}
