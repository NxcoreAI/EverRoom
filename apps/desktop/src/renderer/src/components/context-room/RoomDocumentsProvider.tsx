import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

import { useContextRoomState } from './ContextRoomStateProvider'
import { useRoomDocuments } from './ported/hooks/useRoomDocuments'

type RoomDocumentsState = ReturnType<typeof useRoomDocuments>

const RoomDocumentsContext = createContext<RoomDocumentsState | null>(null)

export function RoomDocumentsProvider({ children }: { children: ReactNode }) {
  const { state } = useContextRoomState()
  const documents = useRoomDocuments(state.rooms.map((room) => room.id))
  const seenReferenceEventIds = useRef(new Set<string>())

  useEffect(() => {
    for (const events of Object.values(documents.eventsByDocument)) {
      for (const event of events) {
        if (seenReferenceEventIds.current.has(event.id)) continue
        seenReferenceEventIds.current.add(event.id)
        window.dispatchEvent(new CustomEvent('everroom:document-block-references-invalidated', {
          detail: { roomId: event.roomId, documentId: event.documentId },
        }))
      }
    }
  }, [documents.eventsByDocument])

  return (
    <RoomDocumentsContext.Provider value={documents}>
      {children}
    </RoomDocumentsContext.Provider>
  )
}

export function useRoomDocumentsState(): RoomDocumentsState {
  const value = useContext(RoomDocumentsContext)
  if (!value) throw new Error('useRoomDocumentsState must be used inside RoomDocumentsProvider')
  return value
}
