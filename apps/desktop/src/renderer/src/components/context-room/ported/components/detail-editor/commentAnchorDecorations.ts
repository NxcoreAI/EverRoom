import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Extension, type Editor } from '@tiptap/react'

/**
 * 评论锚点装饰（ProseMirror inline decoration）：
 * 评论按"稳定块 id 优先、引用文本退化（同文按出现顺序依次锚定）"解析成文档坐标范围，
 * 以行内装饰渲染黄色下划线（class 区分于手动 <u> 下划线），随文档编辑自动映射，
 * 点击装饰范围广播 COMMENT_ANCHOR_CLICKED_EVENT（面板监听后展开/闪亮卡片）。
 * 装饰是视图层的，不写入文档内容。
 */

export const COMMENT_ANCHOR_CLASS = 'context-room-comment-anchor'
export const COMMENT_ANCHOR_CLICKED_EVENT = 'everroom:comment-anchor-clicked'

export interface CommentAnchorRange {
  id: string
  from: number
  to: number
}

interface CommentAnchorState {
  ranges: CommentAnchorRange[]
  decorations: DecorationSet
}

export const commentAnchorPluginKey = new PluginKey<CommentAnchorState>('commentAnchors')

const WHITESPACE = /[\s　]/

export function resolveCommentRanges(
  doc: ProseMirrorNode,
  comments: Array<{ id: string; blockId: string | null; quotedText: string | null }>,
): CommentAnchorRange[] {
  const blockRangeOf = new Map<string, { from: number; to: number }>()
  doc.descendants((node, pos) => {
    const id = typeof node.attrs?.id === 'string' ? node.attrs.id.trim() : ''
    if (id && !blockRangeOf.has(id)) blockRangeOf.set(id, { from: pos + 1, to: pos + node.nodeSize - 1 })
    return true
  })
  // 归一化全文（去空白）与字符→文档位置映射，供引用文本匹配。
  const chars: Array<{ char: string; pos: number }> = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    for (let index = 0; index < node.text.length; index += 1) {
      const char = node.text[index]!
      if (!WHITESPACE.test(char)) chars.push({ char, pos: pos + index })
    }
    return true
  })
  const normalizedFull = chars.map((entry) => entry.char).join('')
  const quoteCursor = new Map<string, number>()
  const normalizedQuote = (quotedText: string | null): string => (
    quotedText ? quotedText.replace(/[\s　]+/g, '').slice(0, 80) : ''
  )
  /** 全局引用匹配（同文按出现顺序依次消耗，跨块也精确）。 */
  const quoteAnywhere = (quotedText: string | null): { from: number; to: number } | null => {
    const quote = normalizedQuote(quotedText)
    if (quote.length < 2) return null
    const hit = normalizedFull.indexOf(quote, quoteCursor.get(quote) ?? 0)
    if (hit < 0) return null
    quoteCursor.set(quote, hit + quote.length)
    return { from: chars[hit]!.pos, to: chars[hit + quote.length - 1]!.pos + 1 }
  }
  /** 块内引用匹配：把范围精确到块内被评论的那几个字，而不是整块。 */
  const quoteInside = (window: { from: number; to: number }, quotedText: string | null): { from: number; to: number } | null => {
    const quote = normalizedQuote(quotedText)
    if (quote.length < 2) return null
    const start = chars.findIndex((entry) => entry.pos >= window.from)
    if (start < 0) return null
    let end = start
    while (end < chars.length && chars[end]!.pos < window.to) end += 1
    const windowText = chars.slice(start, end).map((entry) => entry.char).join('')
    const hit = windowText.indexOf(quote)
    if (hit < 0) return null
    return { from: chars[start + hit]!.pos, to: chars[start + hit + quote.length - 1]!.pos + 1 }
  }
  const result: CommentAnchorRange[] = []
  for (const comment of comments) {
    const block = comment.blockId ? blockRangeOf.get(comment.blockId) : undefined
    // 精确优先：块内引用文本 → 全局引用文本 → 整块兜底（引用彻底找不到才划整块）。
    let range: { from: number; to: number } | null = block ? quoteInside(block, comment.quotedText) : null
    if (!range) range = quoteAnywhere(comment.quotedText)
    if (!range && block) range = block
    if (range && range.from < range.to) result.push({ id: comment.id, from: range.from, to: range.to })
  }
  return result
}

function decorationsOf(doc: ProseMirrorNode, ranges: CommentAnchorRange[]): DecorationSet {
  return DecorationSet.create(doc, ranges.map((range) => Decoration.inline(
    range.from,
    range.to,
    { class: COMMENT_ANCHOR_CLASS, 'data-comment-id': range.id },
  )))
}

export function setCommentAnchorRanges(editor: Editor, ranges: CommentAnchorRange[]): void {
  const current = commentAnchorPluginKey.getState(editor.state)
  if (current
    && current.ranges.length === ranges.length
    && current.ranges.every((range, index) => range.id === ranges[index]!.id
      && range.from === ranges[index]!.from
      && range.to === ranges[index]!.to)) return
  editor.view.dispatch(editor.state.tr.setMeta(commentAnchorPluginKey, { type: 'set', ranges }))
}

export const CommentAnchors = Extension.create({
  name: 'commentAnchors',
  addProseMirrorPlugins() {
    return [new Plugin<CommentAnchorState>({
      key: commentAnchorPluginKey,
      state: {
        init: () => ({ ranges: [], decorations: DecorationSet.empty }),
        apply: (transaction, value) => {
          let next = value
          const meta = transaction.getMeta(commentAnchorPluginKey)
          if (meta?.type === 'set') {
            next = { ranges: meta.ranges as CommentAnchorRange[], decorations: decorationsOf(transaction.doc, meta.ranges) }
          }
          if (transaction.docChanged) {
            next = { ranges: next.ranges, decorations: next.decorations.map(transaction.mapping, transaction.doc) }
          }
          return next
        },
      },
      props: {
        decorations: (state) => commentAnchorPluginKey.getState(state)?.decorations,
        handleClick(view, pos) {
          const state = commentAnchorPluginKey.getState(view.state)
          if (!state) return false
          const hit = state.ranges.find((range) => pos >= range.from && pos <= range.to)
          if (!hit) return false
          window.dispatchEvent(new CustomEvent(COMMENT_ANCHOR_CLICKED_EVENT, { detail: { commentId: hit.id } }))
          return false
        },
      },
    })]
  },
})
