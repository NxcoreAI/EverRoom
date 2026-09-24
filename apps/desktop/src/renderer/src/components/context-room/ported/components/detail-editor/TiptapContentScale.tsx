import type { Editor } from '@tiptap/react'
import type { TableOfContentData, TableOfContentDataItem } from '@tiptap/extension-table-of-contents'
import { ChevronLeft, ChevronRight, ListTree } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { jumpToSectionHeading } from './scaleMarkerNavigation'

/**
 * 文档大纲入口：收起态是编辑器左上角的展开按钮；展开为飞书式大纲面板
 * （按层级缩进的标题列表，点击跳转，当前章节高亮并保持可见）。
 */
export function TiptapContentScale({ items, documentTitle, editor, onOutlineOpenChange }: {
  items: TableOfContentData
  /** 文档标题：作为大纲第一项（点击回顶部）。 */
  documentTitle: string
  editor: Editor | null
  /** 大纲开/关通知宿主：正文推挤会让块手柄坐标滞留，宿主需触发重算。 */
  onOutlineOpenChange?: (open: boolean) => void
}) {
  const { t } = useLocale()
  const [outlineOpen, setOutlineOpen] = useState(false)
  // 折叠状态放在面板外层：开合面板不重置已折叠的章节。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  if (items.length === 0) return null

  const toggleOutline = (open: boolean) => {
    setOutlineOpen(open)
    onOutlineOpenChange?.(open)
  }

  return (
    <nav
      className="context-room-tiptap-content-scale"
      data-outline-open={String(outlineOpen)}
      aria-label={t('contextRoom:tiptapContentScale.documentOutlineScale')}
    >
      {outlineOpen ? (
        <OutlinePanel
          items={items}
          documentTitle={documentTitle}
          editor={editor}
          collapsed={collapsed}
          onToggleCollapse={(id) => setCollapsed((current) => ({ ...current, [id]: !current[id] }))}
          onCollapse={() => toggleOutline(false)}
        />
      ) : (
        <button
          type="button"
          className="context-room-tiptap-scale-expand"
          onClick={() => toggleOutline(true)}
          aria-label={t('contextRoom:tiptapContentScale.expandOutline')}
          title={t('contextRoom:tiptapContentScale.expandOutline')}
        >
          <ListTree size={17} aria-hidden="true" />
        </button>
      )}
    </nav>
  )
}

/** 飞书式章节大纲：文档标题 + 嵌套标题列表（可折叠子树），当前章节高亮并滚入可见。 */
function OutlinePanel({ items, documentTitle, editor, collapsed, onToggleCollapse, onCollapse }: {
  items: TableOfContentData
  documentTitle: string
  editor: Editor | null
  collapsed: Record<string, boolean>
  onToggleCollapse: (id: string) => void
  onCollapse: () => void
}) {
  const { t } = useLocale()
  const itemsRef = useRef<HTMLDivElement | null>(null)

  // 是否有子项：后面跟随更深 level 的条目。
  const hasChildren = useMemo(() => {
    const result: Record<string, boolean> = {}
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      result[item.id] = index + 1 < items.length && items[index + 1]!.level > item.level
    }
    return result
  }, [items])

  // 可见条目：祖先链上任一折叠即隐藏（栈维护当前祖先）。
  const visibleItems = useMemo(() => {
    const result: TableOfContentDataItem[] = []
    const ancestors: Array<{ id: string; level: number }> = []
    for (const item of items) {
      while (ancestors.length && ancestors[ancestors.length - 1]!.level >= item.level) ancestors.pop()
      if (!ancestors.some((ancestor) => collapsed[ancestor.id])) result.push(item)
      ancestors.push({ id: item.id, level: item.level })
    }
    return result
  }, [collapsed, items])

  // 当前章节的祖先链：列表里整条路径做弱强调，深层级也能看出所处结构。
  const activePath = useMemo(() => {
    const path = new Set<string>()
    const stack: Array<{ id: string; level: number }> = []
    for (const item of items) {
      while (stack.length && stack[stack.length - 1]!.level >= item.level) stack.pop()
      if (item.isActive) {
        for (const ancestor of stack) path.add(ancestor.id)
        break
      }
      stack.push({ id: item.id, level: item.level })
    }
    return path
  }, [items])

  const activeId = items.find((item) => item.isActive)?.id ?? null

  // 当前章节变化时把高亮条目滚入列表可视区（贴边最小滚动，不动外层容器）；
  // 列表本身不再随正文按比例滚动——位置由「当前章节」驱动，用户手动滚动不被打断。
  useEffect(() => {
    const list = itemsRef.current
    if (!list || !activeId) return
    const entry = list.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    if (!entry) return
    const listRect = list.getBoundingClientRect()
    const entryRect = entry.getBoundingClientRect()
    const pad = 8
    if (entryRect.top < listRect.top + pad) {
      list.scrollTop -= listRect.top + pad - entryRect.top
    } else if (entryRect.bottom > listRect.bottom - pad) {
      list.scrollTop += entryRect.bottom - (listRect.bottom - pad)
    }
  }, [activeId])

  const scrollToTop = () => {
    const scrollContainer = editor?.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
    scrollContainer?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="context-room-tiptap-outline" role="dialog" aria-label={t('contextRoom:tiptapContentScale.outlineTitle')}>
      <header>
        <strong>{t('contextRoom:tiptapContentScale.outlineTitle')}</strong>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t('contextRoom:tiptapContentScale.collapseOutline')}
          title={t('contextRoom:tiptapContentScale.collapseOutline')}
        >
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="context-room-tiptap-outline-items" ref={itemsRef}>
        <button
          type="button"
          className="context-room-tiptap-outline-item context-room-tiptap-outline-doc-title"
          onClick={scrollToTop}
          title={documentTitle}
        >
          {documentTitle}
        </button>
        {visibleItems.map((item) => (
          <div
            key={item.id}
            className="context-room-tiptap-outline-entry"
            data-toc-id={item.id}
            data-level={item.level}
            data-active={String(item.isActive)}
            data-in-path={String(activePath.has(item.id))}
          >
            {hasChildren[item.id] ? (
              <button
                type="button"
                className="context-room-tiptap-outline-toggle"
                data-collapsed={String(Boolean(collapsed[item.id]))}
                aria-expanded={!collapsed[item.id]}
                aria-label={t('contextRoom:tiptapContentScale.toggleChildren')}
                title={t('contextRoom:tiptapContentScale.toggleChildren')}
                onClick={() => onToggleCollapse(item.id)}
              >
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            ) : (
              <span className="context-room-tiptap-outline-toggle-spacer" aria-hidden="true" />
            )}
            <button
              type="button"
              className="context-room-tiptap-outline-item"
              onClick={() => jumpToSectionHeading(item.editor, item.id, item.pos)}
              title={item.textContent}
            >
              {item.textContent || t('contextRoom:documentHistory.untitled')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
