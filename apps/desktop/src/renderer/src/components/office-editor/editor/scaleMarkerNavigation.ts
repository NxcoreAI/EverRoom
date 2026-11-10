import type { Editor } from '@tiptap/react'
import { findDocumentBlockElement } from './documentBlockNavigation'

/**
 * 刻度线点击跳转：TOC items 的 pos 是扩展防抖更新前的旧值（流式写入期间
 * 漂移大），点击时按 data-toc-id/id 重新解析最新位置；滚动不依赖
 * selection.scrollIntoView 的最小滚动（标题只会停在视口中下部），改为
 * 手动平滑滚动把标题锚到阅读区顶部。
 */

/** 标题距阅读区顶部的呼吸间距。 */
const SECTION_JUMP_TOP_OFFSET_PX = 16

export function resolveSectionHeadingPos(
  doc: Editor['state']['doc'],
  tocId: string,
  fallbackPos: number,
): number {
  let resolved: number | null = null
  doc.descendants((node, pos) => {
    if (resolved !== null) return false
    if (node.type.name === 'heading' && (node.attrs['data-toc-id'] === tocId || node.attrs.id === tocId)) {
      resolved = pos
      return false
    }
    return true
  })
  return resolved ?? fallbackPos
}

export function jumpToSectionHeading(editor: Editor, tocId: string, fallbackPos: number): void {
  const pos = resolveSectionHeadingPos(editor.state.doc, tocId, fallbackPos)
  const scrollContainer = editor.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
  const target = scrollContainer ? findDocumentBlockElement(editor.view.dom, tocId) : null
  if (!scrollContainer || !target) {
    // 找不到锚点（如 DOM 尚未渲染）：退回官方行为。
    editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run()
    return
  }
  editor.chain().focus().setTextSelection(pos + 1).run()
  const offset = target.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top - SECTION_JUMP_TOP_OFFSET_PX
  if (Math.abs(offset) < 1) return
  scrollContainer.scrollTo({ top: scrollContainer.scrollTop + offset, behavior: 'smooth' })
}
