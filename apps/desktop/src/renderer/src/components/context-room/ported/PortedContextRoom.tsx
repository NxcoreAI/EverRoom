import { useEffect, useRef, useState } from 'react'

import { CONTEXT_ROOMS } from './data'
import type { ContextRoomKind, ContextRoomRecord } from './types'
import type { ContextRoomWorkspaceTab } from '../contextRoomTabs'
import { useContextRoomState } from '../ContextRoomStateProvider'
import { HomeView } from './components/HomeView'
import { PortedDetail } from './components/PortedDetail'
import type { DetailPane } from './components/RoomIconSidebar'
import { useRoomDocuments } from './hooks/useRoomDocuments'

interface DraftRoom {
  kind: ContextRoomKind
  name: string
  summary: string
}

function createRoom(draft: DraftRoom): ContextRoomRecord {
  const id = `room-${Date.now()}`
  return {
    ...CONTEXT_ROOMS[0],
    id,
    title: draft.name,
    kind: draft.kind,
    status: '进行中',
    starred: false,
    lastViewed: '刚刚',
    roomCode: id.toUpperCase(),
    brief: {
      background: draft.summary || '待补充 Room 的背景和资料范围。',
      goal: '明确目标并聚合相关资料。',
      status: 'Room 已创建，等待补充资料。',
      risks: [],
      decisions: [],
    },
    stats: { docs: 0, mails: 0, meetings: 0, events: 0, memories: 0, tasks: 0 },
    riskCount: 0,
    pendingMemoryCount: 0,
    people: [],
    timeline: [],
    materials: [],
    actionItems: [],
    graphEdges: [],
    pendingMemoryItems: [],
    memoryItems: [],
    fileItems: [],
    nextReverseRecall: '暂无',
    cloudDoc: { workspaceId: 'local-placeholder', docId: `local-${id}`, title: draft.name },
  }
}

export function PortedContextRoom({
  activeRoomId,
  homeRequest,
  onDetailFocusChange,
  onOpenRoomTab,
  onRoomsChange,
  onShowHome,
}: {
  activeRoomId: string | null
  homeRequest: number
  onDetailFocusChange: (focused: boolean) => void
  onOpenRoomTab: (room: ContextRoomWorkspaceTab) => void
  onRoomsChange: (rooms: ContextRoomWorkspaceTab[]) => void
  onShowHome: () => void
}) {
  const { state, setState } = useContextRoomState()
  const handledHomeRequest = useRef(homeRequest)
  const detailPaneByRoomIdRef = useRef<Record<string, DetailPane>>({})
  const [initialObject, setInitialObject] = useState<{
    kind: 'file' | 'mail' | 'meeting'
    id: string
    roomId: string
  } | null>(null)
  const activeRoom = state.rooms.find((room) => room.id === activeRoomId) ?? null
  const roomDocuments = useRoomDocuments(state.rooms.map((room) => room.id))

  useEffect(() => {
    onRoomsChange(state.rooms.map(({ id, title, kind }) => ({ id, title, kind })))
  }, [onRoomsChange, state.rooms])

  useEffect(() => {
    const focused = Boolean(activeRoomId)
    onDetailFocusChange(focused)
    return () => onDetailFocusChange(false)
  }, [activeRoomId, onDetailFocusChange])

  useEffect(() => {
    if (homeRequest === handledHomeRequest.current) return
    handledHomeRequest.current = homeRequest
    setInitialObject(null)
    onShowHome()
  }, [homeRequest, onShowHome])

  useEffect(() => {
    if (!activeRoomId || initialObject?.roomId !== activeRoomId) return
    setInitialObject(null)
  }, [activeRoomId, initialObject])

  const updateRoom = (updater: (room: ContextRoomRecord) => ContextRoomRecord) => {
    if (!activeRoomId) return
    setState((current) => ({
      ...current,
      rooms: current.rooms.map((room) => room.id === activeRoomId ? updater(room) : room),
    }))
  }

  const openRoom = (roomId: string) => {
    const room = state.rooms.find((item) => item.id === roomId)
    if (!room) return
    setInitialObject(null)
    onOpenRoomTab({ id: room.id, title: room.title })
  }

  if (activeRoom) {
    return (
      <PortedDetail
        key={activeRoom.id}
        room={activeRoom}
        rooms={state.rooms}
        backendDocuments={roomDocuments.documentsByRoom[activeRoom.id] ?? []}
        trashedDocuments={roomDocuments.trashedDocumentsByRoom[activeRoom.id] ?? []}
        documentEvents={roomDocuments.eventsByDocument}
        focusedDocumentId={roomDocuments.focusedDocumentByRoom[activeRoom.id] ?? null}
        onBackendDocumentChange={roomDocuments.upsertDocument}
        onCreateDocument={roomDocuments.createDocument}
        onDeleteDocument={roomDocuments.deleteDocument}
        onRestoreDocument={roomDocuments.restoreDocument}
        onDeleteDocumentPermanently={roomDocuments.deleteDocumentPermanently}
        initialActivePane={detailPaneByRoomIdRef.current[activeRoom.id] ?? 'overview'}
        initialObject={initialObject?.roomId === activeRoom.id ? initialObject : null}
        onActivePaneChange={(pane) => {
          detailPaneByRoomIdRef.current[activeRoom.id] = pane
        }}
        onBack={() => {
          setInitialObject(null)
          onShowHome()
        }}
        onOpenRoom={openRoom}
        onUpdateRoom={updateRoom}
      />
    )
  }

  return (
    <HomeView
      rooms={state.rooms}
      deletedRooms={state.deletedRooms}
      onCreateRoom={(draft) => {
        const room = createRoom(draft)
        setState((current) => ({ ...current, rooms: [room, ...current.rooms] }))
        onOpenRoomTab({ id: room.id, title: room.title })
      }}
      onRenameRoom={(roomId, name) => setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) => room.id === roomId ? { ...room, title: name } : room),
      }))}
      onDeleteRoom={(roomId) => setState((current) => {
        const room = current.rooms.find((item) => item.id === roomId)
        return room
          ? { rooms: current.rooms.filter((item) => item.id !== roomId), deletedRooms: [room, ...current.deletedRooms] }
          : current
      })}
      onRestoreRoom={(roomId) => setState((current) => {
        const room = current.deletedRooms.find((item) => item.id === roomId)
        return room
          ? { rooms: [room, ...current.rooms], deletedRooms: current.deletedRooms.filter((item) => item.id !== roomId) }
          : current
      })}
      onOpenRecommendationSource={(source) => {
        if (!source.roomId) return
        if (source.objectId) {
          setInitialObject({
            kind: source.type === '文件' ? 'file' : source.type === '邮件' ? 'mail' : 'meeting',
            id: source.objectId,
            roomId: source.roomId,
          })
        } else {
          setInitialObject(null)
        }
        const room = state.rooms.find((item) => item.id === source.roomId)
        if (room) onOpenRoomTab({ id: room.id, title: room.title })
      }}
      onOpenDetail={openRoom}
    />
  )
}
