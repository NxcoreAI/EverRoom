import { ChevronRight, Clock3, MoreVertical, Trash2 } from 'lucide-react'

import { RoomIcon } from './RoomIcon'
import type { ContextRoomRecord } from './types'

export function RoomCard({
  room,
  onOpen,
  onDelete,
}: {
  room: ContextRoomRecord
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <article className="cr-room-card">
      <button type="button" className="cr-room-card-main" onClick={onOpen}>
        <RoomIcon kind={room.kind} />
        <span className="cr-room-card-copy">
          <strong>{room.title}</strong>
          <span>{room.description}</span>
          <small>
            <Clock3 aria-hidden="true" strokeWidth={1.8} />
            {room.updated}
          </small>
        </span>
        <ChevronRight aria-hidden="true" strokeWidth={1.8} />
      </button>
      <details className="cr-room-menu">
        <summary aria-label={`${room.title} 更多操作`} title="更多操作">
          <MoreVertical aria-hidden="true" strokeWidth={1.8} />
        </summary>
        <div>
          <button type="button" onClick={onDelete}>
            <Trash2 aria-hidden="true" strokeWidth={1.8} />删除
          </button>
        </div>
      </details>
    </article>
  )
}
