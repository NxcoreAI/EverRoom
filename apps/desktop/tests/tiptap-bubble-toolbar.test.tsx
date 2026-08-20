import type { ReactNode } from 'react'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom')
  return { ...actual, createPortal: (children: ReactNode) => children }
})

vi.mock('@tiptap/react', async () => {
  const actual = await vi.importActual<typeof import('@tiptap/react')>('@tiptap/react')
  return {
    ...actual,
    useEditorState: ({ editor, selector }: { editor: unknown; selector: (value: { editor: unknown }) => unknown }) =>
      selector({ editor }),
  }
})

vi.mock('../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapSelectionRewrite', () => ({
  clearSelectionRewritePromptDecoration: vi.fn(),
  showSelectionRewritePromptDecoration: vi.fn(() => true),
}))

import { TiptapBubbleToolbar } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapBubbleToolbar'

describe('TiptapBubbleToolbar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function createEditor({
    image = false,
    imageAttributes = {},
  }: {
    image?: boolean
    imageAttributes?: Record<string, unknown>
  } = {}) {
    const selectionListeners = new Set<() => void>()
    const run = vi.fn(() => true)
    const chain = {
      focus: vi.fn(() => chain),
      setNodeSelection: vi.fn(() => chain),
      updateAttributes: vi.fn(() => chain),
      deleteSelection: vi.fn(() => chain),
      toggleBold: vi.fn(() => chain),
      toggleItalic: vi.fn(() => chain),
      toggleUnderline: vi.fn(() => chain),
      toggleStrike: vi.fn(() => chain),
      toggleCode: vi.fn(() => chain),
      extendMarkRange: vi.fn(() => chain),
      setLink: vi.fn(() => chain),
      unsetLink: vi.fn(() => chain),
      run,
    }
    const editor = {
      state: { selection: { from: 7, empty: !image } },
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'selectionUpdate') selectionListeners.add(listener)
        return editor
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (event === 'selectionUpdate') selectionListeners.delete(listener)
        return editor
      }),
      getAttributes: vi.fn((name: string) => name === 'image' ? imageAttributes : { href: 'https://example.com' }),
      isActive: vi.fn((name: string) => name === 'image' && image),
      chain: vi.fn(() => chain),
    }
    return { chain, editor, selectionListeners }
  }

  it('closes the link editor when the text selection changes', () => {
    const selectionListeners = new Set<() => void>()
    const editor = {
      state: { selection: {} },
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'selectionUpdate') selectionListeners.add(listener)
        return editor
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (event === 'selectionUpdate') selectionListeners.delete(listener)
        return editor
      }),
      getAttributes: vi.fn(() => ({ href: 'https://example.com' })),
      isActive: vi.fn(() => false),
      can: vi.fn(() => ({
        addRowBefore: () => false,
        addRowAfter: () => false,
        deleteRow: () => false,
        addColumnBefore: () => false,
        addColumnAfter: () => false,
        deleteColumn: () => false,
        mergeCells: () => false,
        splitCell: () => false,
        deleteTable: () => false,
      })),
    } as never

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TiptapBubbleToolbar editor={editor} documentId="doc-1" onAskAi={vi.fn()} />)
    })

    act(() => {
      renderer.root.findByProps({ 'aria-label': '添加链接' }).props.onClick()
    })
    expect(renderer.root.findAllByProps({ className: 'context-room-tiptap-bubble-link' })).toHaveLength(1)

    act(() => {
      for (const listener of selectionListeners) listener()
    })
    expect(renderer.root.findAllByProps({ className: 'context-room-tiptap-bubble-link' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'aria-label': '添加链接' })).toBeDefined()

    act(() => renderer.unmount())
  })

  it('shows image actions and restores the original dimensions', () => {
    const { chain, editor } = createEditor({
      image: true,
      imageAttributes: { src: 'nxcore-document-asset://doc/image.png', width: 320, height: 180 },
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TiptapBubbleToolbar editor={editor as never} documentId="doc-1" onAskAi={vi.fn()} />,
      )
    })

    expect(renderer.root.findByProps({ 'aria-label': '替换图片' })).toBeDefined()
    expect(renderer.root.findByProps({ 'aria-label': '替代文本' })).toBeDefined()
    expect(renderer.root.findByProps({ 'aria-label': '放大预览' })).toBeDefined()
    expect(renderer.root.findByProps({ 'aria-label': '恢复原始尺寸' })).toBeDefined()
    expect(renderer.root.findByProps({ 'aria-label': '删除图片' })).toBeDefined()

    act(() => renderer.root.findByProps({ 'aria-label': '恢复原始尺寸' }).props.onClick())
    expect(chain.setNodeSelection).toHaveBeenCalledWith(7)
    expect(chain.updateAttributes).toHaveBeenCalledWith('image', { width: null, height: null })
    expect(chain.run).toHaveBeenCalled()
  })

  it('opens and closes a full image preview without changing the document', () => {
    const keydownListeners = new Set<(event: KeyboardEvent) => void>()
    vi.stubGlobal('document', {
      body: { style: { overflow: '' } },
      addEventListener: vi.fn((event: string, listener: (event: KeyboardEvent) => void) => {
        if (event === 'keydown') keydownListeners.add(listener)
      }),
      removeEventListener: vi.fn((event: string, listener: (event: KeyboardEvent) => void) => {
        if (event === 'keydown') keydownListeners.delete(listener)
      }),
    })
    const { chain, editor } = createEditor({
      image: true,
      imageAttributes: {
        src: 'nxcore-document-asset://doc/image.png',
        alt: '架构图',
      },
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TiptapBubbleToolbar editor={editor as never} documentId="doc-1" onAskAi={vi.fn()} />,
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '放大预览' }).props.onClick())
    expect(renderer.root.findByProps({ role: 'dialog', 'aria-label': '图片预览' })).toBeDefined()
    expect(renderer.root.findByProps({
      src: 'nxcore-document-asset://doc/image.png',
      alt: '架构图',
    })).toBeDefined()
    expect(chain.updateAttributes).not.toHaveBeenCalled()

    act(() => renderer.root.findByProps({ 'aria-label': '放大图片' }).props.onClick())
    expect(renderer.root.findByType('output').children.join('')).toBe('125%')
    expect(renderer.root.findByProps({ role: 'dialog', 'aria-label': '图片预览' }).props['data-scale']).toBe(1.25)
    act(() => renderer.root.findByProps({ 'aria-label': '缩小图片' }).props.onClick())
    expect(renderer.root.findByType('output').children.join('')).toBe('100%')

    act(() => renderer.root.findByProps({ 'aria-label': '放大图片' }).props.onClick())
    act(() => renderer.root.findByProps({ 'aria-label': '恢复适配大小' }).props.onClick())
    expect(renderer.root.findByType('output').children.join('')).toBe('100%')

    act(() => renderer.root.findByProps({ 'aria-label': '关闭图片预览' }).props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog', 'aria-label': '图片预览' })).toHaveLength(0)
  })

  it('updates image alternative text and deletes the selected image', () => {
    const { chain, editor } = createEditor({
      image: true,
      imageAttributes: { alt: '旧说明' },
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TiptapBubbleToolbar editor={editor as never} documentId="doc-1" onAskAi={vi.fn()} />,
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '替代文本' }).props.onClick())
    const altInput = renderer.root.findByProps({ 'aria-label': '图片替代文本' })
    expect(altInput.props.value).toBe('旧说明')
    act(() => altInput.props.onChange({ target: { value: '新说明' } }))
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }))
    expect(chain.updateAttributes).toHaveBeenCalledWith('image', { alt: '新说明' })

    act(() => renderer.root.findByProps({ 'aria-label': '删除图片' }).props.onClick())
    expect(chain.deleteSelection).toHaveBeenCalled()
    expect(chain.run).toHaveBeenCalled()
  })

  it('stores a replacement locally and clears the previous dimensions', async () => {
    const { chain, editor } = createEditor({
      image: true,
      imageAttributes: { width: 320, height: 180 },
    })
    const storeImage = vi.fn(async () => ({
      assetId: 'asset-2',
      src: 'nxcore-document-asset://doc/replacement.png',
      mimeType: 'image/png' as const,
      bytes: 3,
    }))
    vi.stubGlobal('window', { nxcore: { documents: { storeImage } } })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TiptapBubbleToolbar editor={editor as never} documentId="doc-1" onAskAi={vi.fn()} />,
      )
    })

    act(() => renderer.root.findByProps({ 'aria-label': '替换图片' }).props.onClick())
    const file = new File([new Uint8Array([1, 2, 3])], '替换图.png', { type: 'image/png' })
    const input = renderer.root.findByProps({ type: 'file' })
    await act(async () => {
      input.props.onChange({
        target: { files: [file] },
        currentTarget: { value: 'selected' },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(storeImage).toHaveBeenCalledWith('doc-1', expect.objectContaining({
      fileName: '替换图.png',
      mimeType: 'image/png',
    }))
    expect(chain.updateAttributes).toHaveBeenCalledWith('image', {
      src: 'nxcore-document-asset://doc/replacement.png',
      alt: '替换图',
      width: null,
      height: null,
    })
  })

})
