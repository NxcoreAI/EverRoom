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
  onFocusAgent,
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
  onFocusAgent: () => void
}) {
  return (
    <div className="context-room-operation-shell">
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
        onFocusAgent={onFocusAgent}
      />
    </div>
  )
}
