/** @vitest-environment happy-dom */
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StarterKit from '@tiptap/starter-kit'
import { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))

import {
  BlockIndexMark,
  BlockIndexMarkView,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/BlockIndexMark'
import {
  BLOCK_INDEX_MARK_NODE,
  toBlockIndexMarkNodeAttrs,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/blockIndexLink'

// 这里刻意不 mock @radix-ui/react-popover:用真 Radix + 真 DOM 渲染验证
// hover → 打开 → 保持打开 → 移出关闭 的完整链路。此前 Radix 被整体 mock,
// 焦点抢占/自动关闭一类的问题在单测里不可见。

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const editors: Editor[] = []
let roots: Root[] = []
let containers: HTMLElement[] = []

function createEditorWithMark(): { editor: Editor; node: ProseMirrorNode; pos: number } {
  const editor = new Editor({
    extensions: [StarterKit, BlockIndexMark],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '宿主段落' },
          { type: BLOCK_INDEX_MARK_NODE, attrs: toBlockIndexMarkNodeAttrs({
            kind: 'document',
            roomId: 'room-1',
            documentId: 'doc-2',
            blockId: 'block-7',
            fallbackTitle: '来源',
            fallbackPreview: '预览文本',
          }) },
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

const chipElement = () => document.querySelector<HTMLElement>('.context-room-block-index-chip')
const popoverInBody = () => document.querySelector('.context-room-block-index-popover')
const wrapperElement = () => document.querySelector<HTMLElement>('.context-room-block-index-mark')

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  for (const container of containers.splice(0)) container.remove()
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('BlockIndexMarkView popover (real Radix)', () => {
  it('hover 打开预览卡并保持打开,移出后关闭', async () => {
    vi.useFakeTimers()
    const { editor, node, pos } = createEditorWithMark()
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

    const container = document.createElement('div')
    document.body.appendChild(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <BlockIndexMarkView
          editor={editor}
          node={node}
          getPos={() => pos}
          extension={{ options: { sourceRoomId: 'room-1', resolveReferences } }} as never
          selected={false}
        />,
      )
    })
    expect(chipElement()).not.toBeNull()
    expect(popoverInBody()).toBeNull()

    // 挂载预热解析。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveReferences).toHaveBeenCalledTimes(1)

    // hover(mouseover 由 React 合成 mouseenter)180ms 后打开,
    // 预览卡经 Radix Portal 渲染进 document.body。
    await act(async () => {
      chipElement()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(220)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(popoverInBody()).not.toBeNull()

    // 停留 1s:不得因焦点抢占/自动关闭而消失,也不再重复解析。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.resolve()
    })
    expect(popoverInBody()).not.toBeNull()
    expect(resolveReferences).toHaveBeenCalledTimes(1)
    expect(popoverInBody()?.textContent).toContain('目标文档')
    // 预览打开期间宿主块保持高亮标记(CSS :has 消费)。
    expect(wrapperElement()?.getAttribute('data-preview-open')).toBe('true')

    // 移出 120ms 后关闭。
    await act(async () => {
      chipElement()!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(popoverInBody()).toBeNull()
    expect(wrapperElement()?.getAttribute('data-preview-open')).toBeNull()
  })
})
