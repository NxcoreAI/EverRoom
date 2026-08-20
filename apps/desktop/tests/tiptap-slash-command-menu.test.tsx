import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TiptapSlashCommandMenu } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapSlashCommandMenu'

function createEditor(query: string, coords = { left: 16, top: 16, bottom: 32 }) {
  const listeners = new Map<string, Set<() => void>>()
  const chain = {
    focus: vi.fn(),
    deleteRange: vi.fn(),
    insertTable: vi.fn(),
    setImage: vi.fn(),
    setParagraph: vi.fn(),
    setHeading: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleTaskList: vi.fn(),
    toggleBlockquote: vi.fn(),
    setCodeBlock: vi.fn(),
    setHorizontalRule: vi.fn(),
    run: vi.fn(),
  }
  for (const method of [
    'focus',
    'deleteRange',
    'insertTable',
    'setImage',
    'setParagraph',
    'setHeading',
    'toggleBulletList',
    'toggleOrderedList',
    'toggleTaskList',
    'toggleBlockquote',
    'setCodeBlock',
    'setHorizontalRule',
  ]) {
    chain[method as keyof typeof chain].mockReturnValue(chain)
  }
  const editor = {
    state: {
      selection: {
        empty: true,
        from: query.length + 1,
        to: query.length + 1,
        $from: {
          parentOffset: query.length + 1,
          parent: { textBetween: () => `/${query}` },
        },
      },
    },
    chain: vi.fn(() => chain),
    on: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set<() => void>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return editor
    }),
    off: vi.fn(),
    view: {
      dom: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      coordsAtPos: vi.fn(() => coords),
    },
  } as never
  return { editor, chain }
}

function option(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByProps({ role: 'option' })
}

type ReactTestInstance = TestRenderer.ReactTestInstance

describe('TiptapSlashCommandMenu insertion commands', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('inserts a three by three table with a header row', () => {
    vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 })
    const { editor, chain } = createEditor('表格')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />)
    })

    act(() => option(renderer).props.onClick())
    expect(renderer.root.findAllByProps({ role: 'gridcell' })).toHaveLength(64)
    act(() => renderer.root.findByProps({ 'aria-label': '3 行 3 列' }).props.onClick())

    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 0, to: 3 })
    expect(chain.insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true })
    expect(chain.run).toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('applies the keyboard-selected format before the editor can insert a newline', () => {
    vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 })
    const { editor, chain } = createEditor('')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />)
    })
    const editorDom = (editor as unknown as {
      view: { dom: { addEventListener: ReturnType<typeof vi.fn> } }
    }).view.dom
    const keydownRegistration = editorDom.addEventListener.mock.calls.find(([event]) => event === 'keydown')
    const handleKeyDown = keydownRegistration?.[1] as (event: KeyboardEvent) => void
    const arrowEvent = {
      key: 'ArrowDown',
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent
    const enterEvent = {
      key: 'Enter',
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent

    act(() => {
      handleKeyDown(arrowEvent)
      handleKeyDown(enterEvent)
    })

    expect(keydownRegistration?.[2]).toBe(true)
    expect(arrowEvent.preventDefault).toHaveBeenCalledOnce()
    expect(arrowEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(enterEvent.preventDefault).toHaveBeenCalledOnce()
    expect(enterEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(chain.deleteRange).toHaveBeenCalledWith(expect.objectContaining({ from: 0, to: 1 }))
    expect(chain.setHeading).toHaveBeenCalledWith({ level: 1 })
    expect(chain.run).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it('keeps the table size picker inside the viewport near the bottom edge', () => {
    vi.stubGlobal('window', { innerHeight: 320, innerWidth: 280 })
    const { editor } = createEditor('表格', { left: 240, top: 276, bottom: 292 })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />)
    })

    act(() => option(renderer).props.onClick())
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(dialog.props.style).toEqual({ left: 20, top: 8 })
    act(() => renderer.unmount())
  })

  it('opens the local file picker directly from the image command', () => {
    vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 })
    const { editor } = createEditor('图片')
    const clickFileInput = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />, {
        createNodeMock: (element) => element.type === 'input' && element.props.type === 'file'
          ? { click: clickFileInput }
          : null,
      })
    })

    act(() => option(renderer).props.onClick())

    expect(clickFileInput).toHaveBeenCalledOnce()
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('stores a local image and inserts only its asset URL', async () => {
    const storeImage = vi.fn(async () => ({
      assetId: 'asset-1',
      src: 'nxcore-document-asset://local/document/image.png',
      mimeType: 'image/png' as const,
      bytes: 8,
    }))
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      nxcore: { documents: { storeImage } },
    })
    const { editor, chain } = createEditor('图片')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />, {
        createNodeMock: (element) => element.type === 'input' && element.props.type === 'file'
          ? { click: vi.fn() }
          : null,
      })
    })
    act(() => option(renderer).props.onClick())

    const fileInput = renderer.root.findByProps({ type: 'file' })
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    await act(async () => fileInput.props.onChange({
      target: { files: [{ name: 'photo.png', type: 'image/png', size: 8, arrayBuffer: async () => bytes }] },
      currentTarget: { value: 'photo.png' },
    }))

    expect(storeImage).toHaveBeenCalledWith('doc-1', {
      fileName: 'photo.png',
      mimeType: 'image/png',
      bytes,
    })
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 0, to: 3 })
    expect(chain.setImage).toHaveBeenCalledWith({
      src: 'nxcore-document-asset://local/document/image.png',
      alt: 'photo',
    })
    act(() => renderer.unmount())
  })

  it('does not reuse the insertion range after a canceled file picker', () => {
    vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 })
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))
    const { editor, chain } = createEditor('图片')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapSlashCommandMenu editor={editor} documentId="doc-1" />, {
        createNodeMock: (element) => element.type === 'input' && element.props.type === 'file'
          ? { click: vi.fn() }
          : null,
      })
    })
    act(() => option(renderer).props.onClick())
    const fileInput = renderer.root.findByProps({ type: 'file' })
    act(() => fileInput.props.onChange({
      target: { files: [] },
      currentTarget: { value: 'photo.png' },
    }))
    act(() => fileInput.props.onChange({
      target: { files: [{ name: 'photo.png', type: 'image/png', size: 8, arrayBuffer }] },
      currentTarget: { value: 'photo.png' },
    }))
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(chain.setImage).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
