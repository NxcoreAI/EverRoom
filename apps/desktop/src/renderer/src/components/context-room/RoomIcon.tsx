import { ROOM_KIND_CONFIG } from './roomConfig'
import type { RoomKind } from './types'

export function RoomIcon({ kind }: { kind: RoomKind }) {
  const { icon: Icon, tone } = ROOM_KIND_CONFIG[kind]

  return (
    <span className="cr-room-icon" data-icon-tone={tone}>
      <Icon aria-hidden="true" strokeWidth={1.8} />
    </span>
  )
}
