import * as Popover from '@radix-ui/react-popover'
import type { Editor } from '@tiptap/react'
import type { TableOfContentData, TableOfContentDataItem } from '@tiptap/extension-table-of-contents'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { SectionPreviewCard } from './SectionPreviewCard'
import { jumpToSectionHeading } from './scaleMarkerNavigation'
import { useSectionPreviews } from './useSectionPreviews'

/**
 * 编辑器右侧章节刻度线：hover 刻度弹出 AI 章节预览卡（BlockIndexMark 的
 * 受控 Popover + hover 意图定时器模式），点击仍跳转章节。items 引用随
 * 滚动高频变化，逐项组件只以 item.id 为 key，预览状态存 hook 内部。
 */
export function TiptapContentScale({ items, documentId, editor, prepareDocument, locked }: {
  items: TableOfContentData
  documentId: string
  editor: Editor | null
  /** 生成前 flush 本地防抖保存（useSectionPreviews 消费）。 */
  prepareDocument: () => Promise<number>
  locked: boolean
}) {
  const { t } = useLocale()
  const previews = useSectionPreviews({ documentId, editor, prepareDocument, locked })
  if (items.length === 0) return null

  return (
    <nav className="context-room-tiptap-content-scale" aria-label={t('contextRoom:tiptapContentScale.documentOutlineScale')}>
      <div className="context-room-tiptap-scale-markers">
        <span className="context-room-tiptap-scale-track" />
        {items.map((item) => (
          <ScaleMarker key={item.id} item={item} previews={previews} />
        ))}
      </div>
    </nav>
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
          side="left"
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
