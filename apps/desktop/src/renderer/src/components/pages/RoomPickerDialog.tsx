import * as Dialog from '@radix-ui/react-dialog'
import { FolderKanban, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { useLocale } from '@/i18n/LocaleContext'

/** ContextRoomKind 中文原值 → contextRoom.json display.* 词条后缀。 */
const ROOM_KIND_I18N: Record<string, string> = {
  '人物': 'person',
  '项目': 'project',
  '主题': 'topic',
  '长期目标': 'longTermGoal',
  '议题': 'issue',
  '事件': 'event',
}

/**
 * 「+新建文档」的目标 Room 选择弹窗：选中后跳进该 Room 工作台的产物库板块。
 *
 * 弹层挂在 body Portal 下、文稿页不加载 ContextRoom.css，因此样式全部自带
 * （见 styles.css 的 .room-picker-* 规则），不依赖懒加载样式表；同理不使用
 * Tailwind 工具类（本项目未接入 Tailwind）。
 */
export function RoomPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (roomId: string) => void
}) {
  const { t } = useLocale()
  const { state } = useContextRoomState()
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const keyword = query.trim().toLowerCase()
  const matches = useMemo(
    () => keyword ? state.rooms.filter((room) => room.title.toLowerCase().includes(keyword)) : state.rooms,
    [keyword, state.rooms],
  )

  // 每次打开重置搜索与键盘高亮，不残留上次输入。
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(0)
  }, [open])

  // 过滤结果变化后高亮回到首项，避免索引越界。
  useEffect(() => { setHighlighted(0) }, [keyword])

  const choose = (roomId: string) => {
    onOpenChange(false)
    onPick(roomId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((current) => Math.min(current + 1, matches.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const room = matches[highlighted]
      if (room) choose(room.id)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="room-picker-overlay" />
        <Dialog.Content
          className="room-picker-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
          onKeyDown={onKeyDown}
        >
          <header className="room-picker-header">
            <Dialog.Title className="room-picker-title">
              {t('surface:docs.newDocumentPickerTitle')}
            </Dialog.Title>
            <Dialog.Description className="room-picker-subtitle">
              {t('surface:docs.newDocumentPickerHint')}
            </Dialog.Description>
            <Dialog.Close className="room-picker-close" aria-label={t('surface:docs.newDocumentPickerClose')}>
              <X aria-hidden="true" strokeWidth={1.8} />
            </Dialog.Close>
          </header>

          <label className="room-picker-search">
            <Search aria-hidden="true" strokeWidth={1.8} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={t('surface:docs.newDocumentPickerSearch')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="room-picker-list" role="listbox" aria-label={t('surface:docs.newDocumentPickerTitle')}>
            {matches.map((room, index) => (
              <button
                key={room.id}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className="room-picker-item"
                data-highlighted={index === highlighted || undefined}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(room.id)}
              >
                <span className="room-picker-item-title">{room.title}</span>
                {room.kind ? (
                  <span className="room-picker-badge">
                    {t(`contextRoom:display.${ROOM_KIND_I18N[room.kind] ?? room.kind}`)}
                  </span>
                ) : null}
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="room-picker-empty">
                <FolderKanban aria-hidden="true" strokeWidth={1.6} />
                {state.rooms.length
                  ? t('surface:docs.newDocumentPickerNoMatch')
                  : t('surface:docs.newDocumentPickerNoRooms')}
              </p>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
