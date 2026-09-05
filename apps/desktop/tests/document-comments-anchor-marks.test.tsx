// @vitest-environment happy-dom
// 真实 tiptap 编辑器上验证评论锚点装饰链路：范围解析、装饰渲染（含 <u> 内）、
// 点击广播事件、面板挂载后自动同步装饰。
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StarterKit from '@tiptap/starter-kit'
import { Editor } from '@tiptap/react'
import type { LocalDocumentComment } from '../src/shared/sources'

import {
  CommentAnchors,
  COMMENT_ANCHOR_CLASS,
  COMMENT_ANCHOR_CLICKED_EVENT,
  commentAnchorPluginKey,
  resolveCommentRanges,
  setCommentAnchorRanges,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/commentAnchorDecorations'
import { StableBlockIds } from '../src/renderer/src/components/context-room/ported/components/detail-editor/StableBlockIds'
import { ImportedCommentsPanel } from '../src/renderer/src/components/context-room/ported/components/detail-editor/ImportedCommentsPanel'

const listMock = vi.fn()
const importHistoryMock = vi.fn()

const CONTENT = '<p data-block-id="blk-1">这是被块ID评论的普通段落。</p>'
  + '<p>前缀 <u>被下划线包裹的引用文本甲</u> 后缀。</p>'
  + '<p>前缀 <u>被下划线包裹的引用文本乙</u> 后缀。</p>'
  + '<p data-block-id="blk-other">没有评论的段落。</p>'

function localComment(overrides: Partial<LocalDocumentComment> & Pick<LocalDocumentComment, 'id'>): LocalDocumentComment {
  return {
    parentId: null,
    blockId: null,
    quotedText: null,
    body: `评论 ${overrides.id}`,
    authorName: '我',
    resolved: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

let host: HTMLElement
let editor: Editor

beforeEach(() => {
  listMock.mockReset()
  importHistoryMock.mockReset()
  listMock.mockResolvedValue({
    items: [
      localComment({ id: 'c-block', blockId: 'blk-1' }),
      localComment({ id: 'c-q1', quotedText: '被下划线包裹的引用文本甲' }),
      localComment({ id: 'c-q2', quotedText: '被下划线包裹的引用文本乙' }),
    ],
  })
  importHistoryMock.mockResolvedValue({ comments: [] })
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    documents: { listDocumentComments: listMock },
    externalDocuments: { importHistory: importHistoryMock },
  }
  host = document.createElement('div')
  document.body.append(host)
  editor = new Editor({
    element: host,
    extensions: [StarterKit, StableBlockIds, CommentAnchors],
    content: CONTENT,
  })
})

afterEach(() => {
  editor.destroy()
  host.remove()
})

describe('resolveCommentRanges', () => {
  it('resolves blockId to the block content and quotedText to the exact text range', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'a', blockId: 'blk-1', quotedText: null },
      { id: 'b', blockId: null, quotedText: '被下划线包裹的引用文本甲' },
    ])
    expect(ranges).toHaveLength(2)
    expect(editor.state.doc.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe('这是被块ID评论的普通段落。')
    expect(editor.state.doc.textBetween(ranges[1]!.from, ranges[1]!.to)).toBe('被下划线包裹的引用文本甲')
  })

  it('anchors blockId comments precisely to their quoted text inside the block', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'precise', blockId: 'blk-1', quotedText: '普通段落' },
      { id: 'fallback', blockId: 'blk-1', quotedText: '块里已经不存在的文字' },
    ])
    expect(ranges).toHaveLength(2)
    // 有引用文本且能在块内找到：精确到那几个字，而不是整块。
    expect(editor.state.doc.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe('普通段落')
    // 引用在块内找不到（也全局找不到）：退回整块。
    expect(editor.state.doc.textBetween(ranges[1]!.from, ranges[1]!.to)).toBe('这是被块ID评论的普通段落。')
  })

  it('anchors duplicate quotes to successive occurrences', () => {
    const doc = editor.state.doc
    const ranges = resolveCommentRanges(doc, [
      { id: 'dup-1', blockId: null, quotedText: '前缀' },
      { id: 'dup-2', blockId: null, quotedText: '前缀' },
    ])
    expect(ranges).toHaveLength(2)
    expect(ranges[0]!.from).toBeLessThan(ranges[1]!.from)
  })

  it('drops comments whose anchors cannot be resolved', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'missing', blockId: 'no-such-block', quotedText: '正文里不存在的一段引用' },
    ])
    expect(ranges).toHaveLength(0)
  })
})

describe('comment anchor decorations', () => {
  it('renders inline decoration spans (including inside <u>) after setCommentAnchorRanges', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'c-block', blockId: 'blk-1', quotedText: null },
      { id: 'c-q1', blockId: null, quotedText: '被下划线包裹的引用文本甲' },
    ])
    setCommentAnchorRanges(editor, ranges)
    expect(host.querySelectorAll(`.${COMMENT_ANCHOR_CLASS}`)).toHaveLength(2)
    // 引用文本在 <u> 内：装饰 span 渲染在 u 里，其自身黄色下划线覆盖 u 的正文色下划线。
    const underline = host.querySelector('u')
    expect(underline?.querySelector(`.${COMMENT_ANCHOR_CLASS}`)).toBeTruthy()
    expect(underline?.querySelector(`.${COMMENT_ANCHOR_CLASS}`)?.getAttribute('data-comment-id')).toBe('c-q1')
  })

  it('broadcasts a click event with the comment id when clicking inside a decorated range', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'c-q1', blockId: null, quotedText: '被下划线包裹的引用文本甲' },
    ])
    setCommentAnchorRanges(editor, ranges)
    const fired: string[] = []
    const listener = (event: Event): void => {
      fired.push((event as CustomEvent<{ commentId?: string }>).detail.commentId ?? '')
    }
    window.addEventListener(COMMENT_ANCHOR_CLICKED_EVENT, listener)
    triggerAnchorClick(editor, ranges[0]!.from)
    window.removeEventListener(COMMENT_ANCHOR_CLICKED_EVENT, listener)
    expect(fired).toEqual(['c-q1'])
  })

  it('maps decorations through edits without re-resolving', () => {
    const ranges = resolveCommentRanges(editor.state.doc, [
      { id: 'c-block', blockId: 'blk-1', quotedText: null },
    ])
    setCommentAnchorRanges(editor, ranges)
    // 在被评论段落前面插入整段：块起点后移，装饰随文档映射（PM 自动 map）。
    editor.chain().insertContentAt(0, '<p>新的首段</p>').run()
    expect(commentAnchorsAt(editor).length).toBeGreaterThan(0)
    const next = resolveCommentRanges(editor.state.doc, [
      { id: 'c-block', blockId: 'blk-1', quotedText: null },
    ])
    expect(next[0]!.from).toBeGreaterThan(ranges[0]!.from)
  })
})

function commentAnchorsAt(ed: Editor): HTMLElement[] {
  return [...ed.view.dom.querySelectorAll(`.${COMMENT_ANCHOR_CLASS}`)]
}

/** 直接调评论装饰插件的 handleClick（someProp 会先命中 StarterKit 等其他插件的同名 prop）。 */
function triggerAnchorClick(ed: Editor, pos: number): void {
  const plugin = ed.state.plugins.find((candidate) => (candidate.spec as { key?: unknown }).key === commentAnchorPluginKey)
  const handleClick = (plugin?.spec.props as { handleClick?: (view: unknown, pos: number, event: unknown) => boolean } | undefined)?.handleClick
  handleClick?.(ed.view, pos, {})
}

describe('ImportedCommentsPanel drives decorations', () => {
  it('syncs decorations from real comments while collapsed and opens on anchor click', async () => {
    const onOpen = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ImportedCommentsPanel
          editor={editor}
          roomId="room-1"
          documentId="doc-1"
          collapsed
          onOpen={onOpen}
          onClose={() => {}}
        />,
      )
    })
    expect(renderer.toJSON()).toBeNull()
    // 面板把三条评论解析成装饰并写入编辑器。
    expect(commentAnchorsAt(editor)).toHaveLength(3)

    // 点击装饰范围（收起态）→ onOpen（面板展开）。
    triggerAnchorClick(editor, 2)
    await act(async () => {})
    expect(onOpen).toHaveBeenCalled()
  })
})
