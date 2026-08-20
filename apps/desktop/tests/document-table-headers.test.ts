import { TableKit } from '@tiptap/extension-table'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'

import {
  isTableHeaderAxisActive,
  toggleTableHeaderAxis,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentTableHeaders'

const editors: Editor[] = []

function createTableEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TableKit],
    content: {
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: ['A', 'B'].map((text) => ({
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            })),
          },
          ...['1', '2'].map((prefix) => ({
            type: 'tableRow',
            content: ['A', 'B'].map((suffix) => ({
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `${prefix}${suffix}` }] }],
            })),
          })),
        ],
      }],
    },
  })
  editors.push(editor)
  return editor
}

function selectCell(editor: Editor, row: number, column: number) {
  const positions: number[][] = []
  let currentRow = -1
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'tableRow') {
      currentRow += 1
      positions[currentRow] = []
    } else if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      positions[currentRow].push(position)
    }
  })
  editor.commands.setTextSelection(positions[row][column] + 2)
}

function cellTypes(editor: Editor): string[][] {
  const rows: string[][] = []
  let currentRow = -1
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      currentRow += 1
      rows[currentRow] = []
    } else if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      rows[currentRow].push(node.type.name)
    }
  })
  return rows
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('document table headers', () => {
  it('adds and removes a header column without destroying the existing header row', () => {
    const editor = createTableEditor()
    selectCell(editor, 1, 0)

    expect(isTableHeaderAxisActive(editor.state, 'column')).toBe(false)
    expect(toggleTableHeaderAxis(editor, 'column')).toBe(true)
    expect(cellTypes(editor)).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableHeader', 'tableCell'],
      ['tableHeader', 'tableCell'],
    ])
    expect(isTableHeaderAxisActive(editor.state, 'column')).toBe(true)

    expect(toggleTableHeaderAxis(editor, 'column')).toBe(true)
    expect(cellTypes(editor)).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell'],
      ['tableCell', 'tableCell'],
    ])
  })

  it('adds and removes a header row without destroying the existing header column', () => {
    const editor = createTableEditor()
    selectCell(editor, 1, 0)
    toggleTableHeaderAxis(editor, 'column')
    selectCell(editor, 2, 1)

    expect(toggleTableHeaderAxis(editor, 'row')).toBe(true)
    expect(cellTypes(editor)).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableHeader', 'tableCell'],
      ['tableHeader', 'tableHeader'],
    ])

    expect(toggleTableHeaderAxis(editor, 'row')).toBe(true)
    expect(cellTypes(editor)).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableHeader', 'tableCell'],
      ['tableHeader', 'tableCell'],
    ])
  })
})
