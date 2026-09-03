/** @vitest-environment happy-dom */
import type { ReactNode } from 'react'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StarterKit from '@tiptap/starter-kit'
import { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

vi.mock('@radix-ui/react-popover', () => ({
  Root: ({ children }: { children: ReactNode }) => <>{children}</>,
  Anchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: ReactNode }) => <div data-popover-content="">{children}</div>,
}))

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))

import {
  BlockIndexMark,
  BlockIndexMarkView,
  handleBlockIndexPaste,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/BlockIndexMark'
import {
  BLOCK_INDEX_MARK_NODE,
  toBlockIndexMarkNodeAttrs,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/blockIndexLink'
import { showToast } from '@/state/toast'

const editors: Editor[] = []

function createEditorWithMark(kind: 'document' | 'memory'): {
  editor: Editor
  node: ProseMirrorNode
  pos: number
} {
  const target = kind === 'memory'
    ? { kind, roomId: 'room-1', memoryId: 'room-1-memory-1' }
    : { kind, roomId: 'room-1', documentId: 'doc-2', blockId: 'block-7' }
  const editor = new Editor({
    extensions: [StarterKit, BlockIndexMark],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '宿主段落' },
          { type: BLOCK_INDEX_MARK_NODE, attrs: toBlockIndexMarkNodeAttrs({
            ...target,
            fallbackTitle: '来源',
            fallbackPreview: '预览文本',
          } as never) },
        ],
      }],
    },
  })
  editors.push(editor)
  let node: ProseMirrorNode | null = null
  let pos = -1
  editor.state.doc.descendants((candidate, candidatePos) => {
    if (candidate.type.name === BLOCK_INDEX_MARK_NODE) {
      node = candidate
      pos = candidatePos
      return false
    }
    return true
  })
  return { editor, node: node as ProseMirrorNode, pos }
}

function renderView({
  editor,
  node,
  pos,
  options,
}: {
  editor: Editor
  node: ProseMirrorNode
  pos: number
  options: Record<string, unknown>
}) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <BlockIndexMarkView
        editor={editor}
        node={node}
        getPos={() => pos}
        extension={{ options }} as never
        selected={false}
      />,
    )
  })
  return {
    root: () => renderer!.root,
    unmount: () => act(() => renderer!.unmount()),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('BlockIndexMarkView', () => {
  it('挂载即预热解析,hover 打开不重复解析', async () => {
    vi.useFakeTimers()
    const { editor, node, pos } = createEditorWithMark('document')
    const resolveReferences = vi.fn(async () => ({
      resolutions: [{
        roomId: 'room-1',
        documentId: 'doc-2',
        blockId: 'block-7',
        status: 'available',
        title: '目标文档',
        textPreview: '目标块内容',
        version: 3,
      }],
    }))
    const view = renderView({
      editor,
      node,
      pos,
      options: {
        sourceRoomId: 'room-1',
        resolveReferences,
        onNavigateDocument: vi.fn(),
      },
    })

    // 挂载后冲刷微任务:批处理解析完成,仅一次调用。
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveReferences).toHaveBeenCalledTimes(1)

    // hover → 180ms 后 open;已有解析结果时打开预览不得再发 IPC——防止
    // "渲染/effect 反复触发解析"的回归,也保证 hover 前内容就绪。
    await act(async () => {
      view.root().findByProps({ className: 'context-room-block-index-chip' }).props.onMouseEnter()
      await vi.advanceTimersByTimeAsync(220)
      await Promise.resolve()
    })
    expect(resolveReferences).toHaveBeenCalledTimes(1)

    // 解析结果进入预览卡。
    const content = view.root().findByProps({ 'data-popover-content': '' })
    const textMatches = content.findAll((element) => Array.isArray(element.children)
      && element.children.includes('目标文档'))
    expect(textMatches.length).toBeGreaterThan(0)

    view.unmount()
  })

  it('点击 chip 走文档跳转回调,携带解析结果', async () => {
    vi.useFakeTimers()
    const { editor, node, pos } = createEditorWithMark('document')
    const onNavigateDocument = vi.fn()
    const resolveReferences = vi.fn(async () => ({
      resolutions: [{
        roomId: 'room-1',
        documentId: 'doc-2',
        blockId: 'block-7',
        status: 'available',
        title: '目标文档',
        textPreview: '目标块内容',
        version: 3,
      }],
    }))
    const view = renderView({
      editor,
      node,
      pos,
      options: { sourceRoomId: 'room-1', resolveReferences, onNavigateDocument },
    })
    await act(async () => {
      view.root().findByProps({ className: 'context-room-block-index-chip' }).props.onMouseEnter()
      await vi.advanceTimersByTimeAsync(220)
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      view.root().findByProps({ className: 'context-room-block-index-chip' }).props.onClick()
    })
    expect(onNavigateDocument).toHaveBeenCalledTimes(1)
    expect(onNavigateDocument.mock.calls[0]![0]).toMatchObject({
      kind: 'document',
      roomId: 'room-1',
      documentId: 'doc-2',
      blockId: 'block-7',
    })
    expect(onNavigateDocument.mock.calls[0]![1]).toMatchObject({ status: 'available' })
    view.unmount()
  })

  it('记忆目标缺失时点击提示且不跳转;存在时走记忆跳转回调', () => {
    const { editor, node, pos } = createEditorWithMark('memory')
    const onNavigateMemory = vi.fn()
    const options = {
      sourceRoomId: 'room-1',
      getMemoryItems: () => [] as Array<{ id: string; content: string; type: string; status: string }>,
      onNavigateMemory,
    }
    const missing = renderView({ editor, node, pos, options })
    act(() => {
      missing.root().findByProps({ className: 'context-room-block-index-chip' }).props.onClick()
    })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(onNavigateMemory).not.toHaveBeenCalled()

    const present = renderView({
      editor,
      node,
      pos,
      options: {
        ...options,
        getMemoryItems: () => [{ id: 'room-1-memory-1', content: '偏好', type: '偏好', status: '已确认' }],
      },
    })
    act(() => {
      present.root().findByProps({ className: 'context-room-block-index-chip' }).props.onClick()
    })
    expect(onNavigateMemory).toHaveBeenCalledWith({
      kind: 'memory',
      roomId: 'room-1',
      memoryId: 'room-1-memory-1',
      fallbackTitle: '来源',
      fallbackPreview: '预览文本',
    })
    missing.unmount()
    present.unmount()
  })

  it('IPC 挂死时超时兜底,预览不会永远停在加载态', async () => {
    vi.useFakeTimers()
    const { editor, node, pos } = createEditorWithMark('document')
    const view = renderView({
      editor,
      node,
      pos,
      options: {
        sourceRoomId: 'room-1',
        // 永不 settle 的 resolver,模拟网关/IPC 挂死。
        resolveReferences: () => new Promise(() => {}),
      },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_100)
      await Promise.resolve()
      await Promise.resolve()
    })
    const content = view.root().findByProps({ 'data-popover-content': '' })
    const hasText = (text: string) => content.findAll((element) => Array.isArray(element.children)
      && element.children.includes(text)).length > 0
    // 超时后 loading 结束,展示插入时的兜底预览,而非"正在加载"。
    expect(hasText('预览文本')).toBe(true)
    view.unmount()
  })

  it('移除索引删除标记节点', () => {
    const { editor, node, pos } = createEditorWithMark('document')
    const view = renderView({
      editor,
      node,
      pos,
      options: { sourceRoomId: 'room-1' },
    })
    const popover = view.root().findByProps({ className: 'context-room-block-index-popover' })
    const actionButtons = popover.findAll((element) => typeof element.props.onClick === 'function')
    act(() => {
      actionButtons.at(-1)!.props.onClick()
    })
    expect(editor.getJSON().content?.[0]?.content?.some((child) => child.type === BLOCK_INDEX_MARK_NODE))
      .toBe(false)
    expect(editor.getJSON().content?.[0]?.content?.some((child) => child.type === 'text')).toBe(true)
    view.unmount()
  })
})

describe('handleBlockIndexPaste', () => {
  function createEditorWithParagraph(): Editor {
    const editor = new Editor({
      extensions: [StarterKit, BlockIndexMark],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '宿主段落' }] }],
      },
    })
    editors.push(editor)
    editor.commands.setTextSelection(3)
    return editor
  }

  const paste = (editor: Editor, text: string) => handleBlockIndexPaste(
    editor.view,
    { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } },
    { sourceRoomId: 'room-1' },
  )

  it('把粘贴的块链接挂载为当前块的索引标记', () => {
    const editor = createEditorWithParagraph()
    const consumed = paste(
      editor,
      'everroom://room/room-1/doc-2/block-7?title=%E7%9B%AE%E6%A0%87%E6%96%87%E6%A1%A3&preview=%E9%A2%84%E8%A7%88',
    )
    expect(consumed).toBe(true)
    const children = editor.getJSON().content?.[0]?.content ?? []
    expect(children[children.length - 1]).toMatchObject({
      type: BLOCK_INDEX_MARK_NODE,
      attrs: {
        kind: 'document',
        targetRoomId: 'room-1',
        targetDocumentId: 'doc-2',
        targetBlockId: 'block-7',
        fallbackTitle: '目标文档',
        fallbackPreview: '预览',
      },
    })
    // 原文本保留,标记落在段末。
    expect(children[0]).toMatchObject({ type: 'text', text: '宿主段落' })
  })

  it('重复粘贴同一目标被拦截,跨房间目标提示且不落文本', () => {
    const editor = createEditorWithParagraph()
    expect(paste(editor, 'everroom://room/room-1/doc-2/block-7')).toBe(true)
    expect(paste(editor, 'everroom://room/room-1/doc-2/block-7')).toBe(true)
    const marks = (editor.getJSON().content?.[0]?.content ?? [])
      .filter((child) => child.type === BLOCK_INDEX_MARK_NODE)
    expect(marks).toHaveLength(1)
    expect(showToast).toHaveBeenCalled()

    expect(paste(editor, 'everroom://room/room-9/doc-2/block-7')).toBe(true)
    expect((editor.getJSON().content?.[0]?.content ?? [])
      .filter((child) => child.type === BLOCK_INDEX_MARK_NODE)).toHaveLength(1)
  })

  it('普通文本粘贴不被拦截', () => {
    const editor = createEditorWithParagraph()
    expect(paste(editor, '普通文本')).toBe(false)
    expect(paste(editor, '[外部](https://example.com)')).toBe(false)
    expect((editor.getJSON().content?.[0]?.content ?? [])
      .some((child) => child.type === BLOCK_INDEX_MARK_NODE)).toBe(false)
  })
})
