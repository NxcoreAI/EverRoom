import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tiptap/react', async () => {
  const actual = await vi.importActual<typeof import('@tiptap/react')>('@tiptap/react')
  return {
    ...actual,
    useEditorState: ({ editor, selector }: { editor: unknown; selector: (value: { editor: unknown }) => unknown }) =>
      selector({ editor }),
  }
})

vi.mock('@tiptap/pm/tables', () => ({
  TableMap: {
    get: vi.fn(() => ({
      width: 4,
      height: 3,
      positionAt: vi.fn((row: number, column: number) => 10 + row * 4 + column),
    })),
  },
}))

import { TiptapTableControls } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapTableControls'

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  x: left,
  y: top,
  toJSON: () => ({}),
})

describe('TiptapTableControls', () => {
  beforeEach(() => {
    class MockElement {
      parentElement: MockElement | null = null
      closest(): MockElement | null { return null }
      querySelector(): MockElement | null { return null }
    }
    class MockTableCellElement extends MockElement {
      constructor(
        private readonly row: MockElement,
        private readonly table: MockElement,
      ) { super() }
      override closest(selector: string): MockElement | null {
        if (selector === 'tr') return this.row
        if (selector === 'table') return this.table
        return this
      }
      getBoundingClientRect() { return rect(200, 160, 120, 48) }
    }
    vi.stubGlobal('Element', MockElement)
    vi.stubGlobal('HTMLTableCellElement', MockTableCellElement)
    vi.stubGlobal('Node', MockElement)
    vi.stubGlobal('window', {
      innerWidth: 1200,
      innerHeight: 800,
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1 },
      cancelAnimationFrame: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders table handles and executes extend and row menu commands', () => {
    const row = { getBoundingClientRect: () => rect(160, 160, 520, 48) }
    const table = { getBoundingClientRect: () => rect(160, 120, 520, 240) }
    const Cell = globalThis.HTMLTableCellElement as unknown as new (row: object, table: object) => Element
    const cell = new Cell(row, table)
    const restoredSelection = { type: 'text', anchor: 2 }
    const mappedBookmark = { resolve: vi.fn(() => restoredSelection) }
    const bookmark = { map: vi.fn(() => mappedBookmark) }
    const transaction = {
      doc: { content: { size: 24 } },
      mapping: { maps: [] },
      setSelection: vi.fn(),
    }
    const chain = {
      focus: vi.fn(),
      setCellSelection: vi.fn(),
      addRowBefore: vi.fn(),
      addRowAfter: vi.fn(),
      addColumnAfter: vi.fn(),
      command: vi.fn((callback: (props: { tr: typeof transaction }) => boolean) => {
        callback({ tr: transaction })
        return chain
      }),
      run: vi.fn(),
    }
    for (const method of ['focus', 'setCellSelection', 'addRowBefore', 'addRowAfter', 'addColumnAfter']) {
      chain[method as keyof typeof chain].mockReturnValue(chain)
    }
    const can = {
      addRowAfter: () => true,
      addColumnAfter: () => true,
      deleteRow: () => true,
      deleteColumn: () => true,
      mergeCells: () => false,
      splitCell: () => false,
      deleteTable: () => true,
    }
    const editor = {
      state: {
        doc: { content: { size: 20 } },
        selection: {
          from: 2,
          getBookmark: () => bookmark,
          $from: {
            depth: 2,
            node: (depth: number) => depth === 1
              ? { type: { spec: { tableRole: 'table' } } }
              : { type: { spec: {} } },
            start: () => 5,
          },
        },
      },
      view: { domAtPos: vi.fn(() => ({ node: cell })) },
      isActive: vi.fn((name: string) => name === 'table'),
      can: vi.fn(() => can),
      chain: vi.fn(() => chain),
      on: vi.fn(() => editor),
      off: vi.fn(() => editor),
    } as never

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapTableControls editor={editor} />)
    })

    expect(renderer.root.findByProps({ 'aria-label': '当前行菜单' })).toBeDefined()
    expect(renderer.root.findByProps({ 'aria-label': '当前列菜单' })).toBeDefined()
    act(() => renderer.root.findByProps({ 'aria-label': '在底部添加行' }).props.onClick())
    expect(chain.setCellSelection).toHaveBeenLastCalledWith({ anchorCell: 23 })
    act(() => renderer.root.findByProps({ 'aria-label': '在右侧添加列' }).props.onClick())
    expect(chain.setCellSelection).toHaveBeenLastCalledWith({ anchorCell: 18 })
    expect(chain.addRowAfter).toHaveBeenCalledOnce()
    expect(chain.addColumnAfter).toHaveBeenCalledOnce()
    expect(bookmark.map).toHaveBeenCalledTimes(2)
    expect(bookmark.map).toHaveBeenLastCalledWith(transaction.mapping)
    expect(mappedBookmark.resolve).toHaveBeenLastCalledWith(transaction.doc)
    expect(transaction.setSelection).toHaveBeenLastCalledWith(restoredSelection)

    window.innerHeight = 250
    act(() => renderer.root.findByProps({ 'aria-label': '当前行菜单' }).props.onClick({
      preventDefault: vi.fn(),
      currentTarget: { getBoundingClientRect: () => rect(132, 220, 24, 24) },
    }))
    expect(renderer.root.findByProps({ role: 'menu' }).props.style).toEqual({ left: 132, top: 54 })
    const addAbove = renderer.root.findAllByType('button').find((button) =>
      button.findAllByType('span').some((span) => span.children.join('') === '在上方插入行'))
    expect(addAbove).toBeDefined()
    act(() => addAbove!.props.onClick())
    expect(chain.addRowBefore).toHaveBeenCalledOnce()

    act(() => renderer.unmount())
  })
})
