import { createContext, useContext, type ReactNode } from 'react'

// 原型 stub：EverRoom 的 Room 文档体系在此原型里不存在，agent 聊天只读
// documentsByRoom（文档选择卡/会话链接用），mock 不触发这些分支，返回空表即可。
export interface RoomDocumentSummary {
  id: string
  title: string
  roomId: string
  version: number
  status: 'draft' | 'active'
  updatedAt?: string
}

interface RoomDocumentsState {
  documentsByRoom: Record<string, any[]>
  loading: boolean
}

const RoomDocumentsContext = createContext<RoomDocumentsState | null>(null)

export function RoomDocumentsProvider({ children }: { children: ReactNode }) {
  return (
    <RoomDocumentsContext.Provider value={{ documentsByRoom: {}, loading: false }}>
      {children}
    </RoomDocumentsContext.Provider>
  )
}

export function useRoomDocumentsState(): RoomDocumentsState {
  const value = useContext(RoomDocumentsContext)
  if (!value) throw new Error('useRoomDocumentsState must be used inside RoomDocumentsProvider')
  return value
}
