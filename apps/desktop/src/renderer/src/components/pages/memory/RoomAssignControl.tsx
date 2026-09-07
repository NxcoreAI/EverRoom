import { Search, X } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'

import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { dispatchRoomMemoryChanged } from '@/components/context-room/roomMemoryChange'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * 原子记忆的 Room 赋值控件：折叠态为归属 chip（点击展开），展开态搜索 + 单选。
 * 行为对齐 RoomMergePartnerPicker（标题实时过滤、回车选第一项、listbox 单选），
 * 但独立实现——不引 ported/ 的组件与 CSS。
 */
export function RoomAssignControl({ memoryId, roomId, roomTitle, snapshot, onChanged }: {
  memoryId: string
  roomId: string | null
  roomTitle: string | null
  /** 绑定时随行落库的记忆快照（Room 记忆注入的数据源）；列表项在手，直接带上。 */
  snapshot?: { content: string; type: string; updatedAt: string } | null
  onChanged: () => void
}) {
  const { t } = useLocale()
  const { state } = useContextRoomState()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rooms = useMemo(
    () => state.rooms.map((room) => ({ id: room.id, title: room.title, kind: room.kind })),
    [state.rooms],
  )
  const keyword = query.trim().toLowerCase()
  const matches = useMemo(
    () => keyword ? rooms.filter((room) => room.title.toLowerCase().includes(keyword)) : rooms,
    [rooms, keyword],
  )

  const assign = async (nextRoomId: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.setAtomicRoom(
        memoryId,
        nextRoomId,
        nextRoomId && snapshot ? { content: snapshot.content, type: snapshot.type, memoryUpdatedAt: snapshot.updatedAt } : undefined,
      )
      setOpen(false)
      setQuery('')
      dispatchRoomMemoryChanged()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.roomAssignFailed'))
    } finally {
      setBusy(false)
    }
  }

  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    if (roomId && matches.some((room) => room.id === roomId)) return
    const first = matches[0]
    if (first) void assign(first.id)
  }

  return (
    <div className="mem-room-assign" data-open={open}>
      <div className="mem-room-assign-row">
        <span className="mem-room-assign-label">{t('memory:atomicMemory.room')}</span>
        <button
          type="button"
          className="mem-room-chip"
          data-available={roomId ? Boolean(roomTitle) : undefined}
          disabled={busy}
          onClick={() => { setOpen(!open); setQuery(''); setError(null) }}
        >
          {roomId ? (roomTitle ?? t('memory:atomicMemory.roomUnavailable')) : t('memory:atomicMemory.roomUnbound')}
        </button>
        {roomId ? (
          <button
            type="button"
            className="mem-room-assign-clear"
            disabled={busy}
            onClick={() => { void assign(null) }}
          >
            <X aria-hidden="true" strokeWidth={1.7} size={14} />{t('memory:atomicMemory.clearRoomBinding')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mem-room-assign-picker">
          <div className="mem-room-assign-search">
            <Search aria-hidden="true" strokeWidth={1.7} />
            <input
              type="text"
              value={query}
              placeholder={t('memory:atomicMemory.roomSearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={searchKeyDown}
            />
          </div>
          <div className="mem-room-assign-list" role="listbox" aria-label={t('memory:atomicMemory.selectRoom')}>
            {matches.map((room) => (
              <button
                key={room.id}
                type="button"
                role="option"
                aria-selected={roomId === room.id}
                data-selected={roomId === room.id}
                disabled={busy}
                onClick={() => { void assign(room.id) }}
              >
                <b>{room.title}</b>
                {room.kind ? <small>{room.kind}</small> : null}
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="mem-room-assign-empty">{t('memory:atomicMemory.roomNoMatch')}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <p className="mem-inline-error">{error}</p> : null}
    </div>
  )
}
