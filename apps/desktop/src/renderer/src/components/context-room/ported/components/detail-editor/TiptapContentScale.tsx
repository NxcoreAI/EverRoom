import * as Popover from '@radix-ui/react-popover'
import type { Editor } from '@tiptap/react'
import type { TableOfContentData, TableOfContentDataItem } from '@tiptap/extension-table-of-contents'
import { ChevronLeft, ChevronRight, ListTree } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { SectionPreviewCard } from './SectionPreviewCard'
import { jumpToSectionHeading } from './scaleMarkerNavigation'
import { useSectionPreviews } from './useSectionPreviews'

/**
 * 编辑器左侧章节刻度线：默认是刻度列（hover 出 AI 章节预览卡，点击跳转）；
 * 顶部的展开按钮切换为飞书式大纲面板（按层级缩进的标题列表，点击跳转，
 * 当前章节高亮并滚入可见）。items 引用随滚动高频变化，逐项组件只以
 * item.id 为 key，预览状态存 hook 内部。
 */
export function TiptapContentScale({ items, documentId, documentTitle, editor, prepareDocument, locked, onOutlineOpenChange }: {
  items: TableOfContentData
  documentId: string
  /** 文档标题：作为大纲第一项（点击回顶部）。 */
  documentTitle: string
  editor: Editor | null
  /** 生成前 flush 本地防抖保存（useSectionPreviews 消费）。 */
  prepareDocument: () => Promise<number>
  locked: boolean
  /** 大纲开/关通知宿主：正文推挤会让块手柄坐标滞留，宿主需触发重算。 */
  onOutlineOpenChange?: (open: boolean) => void
}) {
  const { t } = useLocale()
  const [outlineOpen, setOutlineOpen] = useState(false)
  const scaleBodyRef = useRef<HTMLDivElement | null>(null)
  const previews = useSectionPreviews({ documentId, editor, prepareDocument, locked })

  // 刻度列跟随正文滚动：正文滚动比例映射到刻度列滚动比例（当前章节刻度
  // 保持在视野内）；刻度列本体 overflow hidden，滚轮悬停时驱动正文。
  // 注意：必须先跑完所有 hooks 再做 items.length 的提前返回，否则 TOC
  // 空→有内容的两次渲染钩子数不一致会炸 "Rendered more hooks"。
  useEffect(() => {
    if (outlineOpen) return undefined
    const scrollContainer = editor?.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
    const body = scaleBodyRef.current
    if (!scrollContainer || !body) return undefined
    const sync = () => {
      const max = scrollContainer.scrollHeight - scrollContainer.clientHeight
      const stripMax = body.scrollHeight - body.clientHeight
      if (max <= 0 || stripMax <= 0) return
      body.scrollTop = (scrollContainer.scrollTop / max) * stripMax
    }
    sync()
    scrollContainer.addEventListener('scroll', sync, { passive: true })
    return () => scrollContainer.removeEventListener('scroll', sync)
  }, [editor, items.length, outlineOpen])

  const handleScaleWheel = (event: React.WheelEvent) => {
    const scrollContainer = editor?.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
    if (!scrollContainer) return
    scrollContainer.scrollTop += event.deltaY
  }

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
          onCollapse={() => toggleOutline(false)}
        />
      ) : (
        <div className="context-room-tiptap-scale" onWheel={handleScaleWheel}>
          <button
            type="button"
            className="context-room-tiptap-scale-expand"
            onClick={() => toggleOutline(true)}
            aria-label={t('contextRoom:tiptapContentScale.expandOutline')}
            title={t('contextRoom:tiptapContentScale.expandOutline')}
          >
            <ListTree size={17} aria-hidden="true" />
          </button>
          <div className="context-room-tiptap-scale-body" ref={scaleBodyRef}>
            <div className="context-room-tiptap-scale-markers">
              <span className="context-room-tiptap-scale-track" />
              {items.map((item) => (
                <ScaleMarker key={item.id} item={item} previews={previews} />
              ))}
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}

/** 飞书式章节大纲：文档标题 + 嵌套标题列表（可折叠子树），当前章节高亮；内容区随正文按比例滚动。 */
function OutlinePanel({ items, documentTitle, editor, onCollapse }: {
  items: TableOfContentData
  documentTitle: string
  editor: Editor | null
  onCollapse: () => void
}) {
  const { t } = useLocale()
  const itemsRef = useRef<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

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

  // 抽屉内容区跟随正文滚动：正文滚动比例映射到列表滚动比例（与刻度列同款），
  // 当前章节靠高亮标识而非单项跳转。
  useEffect(() => {
    const scrollContainer = editor?.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
    const list = itemsRef.current
    if (!scrollContainer || !list) return undefined
    const sync = () => {
      const max = scrollContainer.scrollHeight - scrollContainer.clientHeight
      const listMax = list.scrollHeight - list.clientHeight
      if (max <= 0 || listMax <= 0) return
      list.scrollTop = (scrollContainer.scrollTop / max) * listMax
    }
    sync()
    scrollContainer.addEventListener('scroll', sync, { passive: true })
    return () => scrollContainer.removeEventListener('scroll', sync)
  }, [editor, items.length])

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
            data-level={item.level}
            data-active={String(item.isActive)}
          >
            {hasChildren[item.id] ? (
              <button
                type="button"
                className="context-room-tiptap-outline-toggle"
                data-collapsed={String(Boolean(collapsed[item.id]))}
                aria-expanded={!collapsed[item.id]}
                aria-label={t('contextRoom:tiptapContentScale.toggleChildren')}
                title={t('contextRoom:tiptapContentScale.toggleChildren')}
                onClick={() => setCollapsed((current) => ({ ...current, [item.id]: !current[item.id] }))}
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

function ScaleMarker({ item, previews }: {
  item: TableOfContentDataItem
  previews: ReturnType<typeof useSectionPreviews>
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  const ensure = () => previews.ensurePreview({ id: item.id, textContent: item.textContent })

  const scheduleOpen = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
      ensure()
    }, 180)
  }
  const scheduleClose = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, 120)
  }
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const closeNow = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    cancelClose()
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <button
          type="button"
          aria-label={t('contextRoom:tiptapContentScale.goToTitle', { title: item.textContent })}
          data-level={item.level}
          data-active={String(item.isActive)}
          data-scrolled={String(item.isScrolledOver)}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onFocus={scheduleOpen}
          onBlur={scheduleClose}
          onClick={() => {
            // 点击是导航动作：收起 hover 卡，按 id 解析最新位置后跳转。
            closeNow()
            jumpToSectionHeading(item.editor, item.id, item.pos)
          }}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="context-room-tiptap-scale-popover-root"
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          onMouseEnter={cancelClose}
          onMouseLeave={() => setOpen(false)}
        >
          <SectionPreviewCard
            headingText={item.textContent}
            status={previews.getStatus(item.id)}
            onRetry={ensure}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
