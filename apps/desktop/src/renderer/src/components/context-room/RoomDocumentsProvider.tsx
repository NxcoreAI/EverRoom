import { createContext, useContext, type ReactNode } from 'react'

import { useContextRoomState } from './ContextRoomStateProvider'
import { useRoomDocuments } from './ported/hooks/useRoomDocuments'

type RoomDocumentsState = ReturnType<typeof useRoomDocuments>

const RoomDocumentsContext = createContext<RoomDocumentsState | null>(null)

export function RoomDocumentsProvider({ children }: { children: ReactNode }) {
  const { state } = useContextRoomState()
  const documents = useRoomDocuments(state.rooms.map((room) => room.id))

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
