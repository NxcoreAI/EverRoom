import { PortedContextRoom } from './ported/PortedContextRoom'
import type { ContextRoomWorkspaceTab } from './contextRoomTabs'
import './ported/ContextRoom.css'
import './ported/PortedAdapters.css'

export function ContextRoomPage({
  activeRoomId,
  focusedDocumentId,
  homeRequest,
  onDetailFocusChange,
  onOpenRoomTab,
  onRoomsChange,
  onShowHome,
}: {
  activeRoomId: string | null
  focusedDocumentId: string | null
  homeRequest: number
  onDetailFocusChange: (focused: boolean) => void
  onOpenRoomTab: (room: ContextRoomWorkspaceTab) => void
  onRoomsChange: (rooms: ContextRoomWorkspaceTab[]) => void
  onShowHome: () => void
}) {
  return (
    <PortedContextRoom
      activeRoomId={activeRoomId}
      focusedDocumentId={focusedDocumentId}
      homeRequest={homeRequest}
      onDetailFocusChange={onDetailFocusChange}
      onOpenRoomTab={onOpenRoomTab}
      onRoomsChange={onRoomsChange}
      onShowHome={onShowHome}
    />
  )
}
