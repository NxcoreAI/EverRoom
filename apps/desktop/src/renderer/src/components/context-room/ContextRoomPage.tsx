import { PortedContextRoom } from './ported/PortedContextRoom'
import type { ContextRoomWorkspaceTab } from './contextRoomTabs'
import './ported/ContextRoom.css'
import './ported/PortedAdapters.css'

export function ContextRoomPage({
  activeRoomId,
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
  homeRequest,
  onDetailFocusChange,
  onOpenRoomTab,
  onRoomsChange,
  onShowHome,
}: {
  activeRoomId: string | null
  focusedDocumentId: string | null
  focusedBlockId: string | null
  documentFocusRequestId: number | null
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
      focusedBlockId={focusedBlockId}
      documentFocusRequestId={documentFocusRequestId}
      homeRequest={homeRequest}
      onDetailFocusChange={onDetailFocusChange}
      onOpenRoomTab={onOpenRoomTab}
      onRoomsChange={onRoomsChange}
      onShowHome={onShowHome}
    />
  )
}
