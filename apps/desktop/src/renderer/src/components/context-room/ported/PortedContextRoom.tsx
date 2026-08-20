import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { AllRoomsViewSkeleton } from '../AllRoomsViewSkeleton'
import type { ContextRoomRecord } from './types'
import type { ContextRoomWorkspaceTab } from '../contextRoomTabs'
import { useContextRoomState } from '../ContextRoomStateProvider'
import { useRoomDocumentsState } from '../RoomDocumentsProvider'
import { useLocale } from '../../../i18n/LocaleContext'
import { HomeView } from './components/HomeView'
import { PortedDetail } from './components/PortedDetail'
import type { DetailPane } from './components/RoomIconSidebar'
import {
  mergeAutoKnowledgeRooms,
  shouldDeleteRoomFromKnowledge,
  shouldSyncRoomToKnowledge,
} from './knowledgeRoomSync'
import { applyGeneratedRoomContext } from './generatedRoomContext'

const AllRoomsView = lazy(() =>
  import('./components/AllRoomsView').then((module) => ({ default: module.AllRoomsView })),
)

export function PortedContextRoom({
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
  const { t } = useLocale()
  const { state, setState, refreshFromBackend } = useContextRoomState()
  const handledHomeRequest = useRef(homeRequest)
  const detailPaneByRoomIdRef = useRef<Record<string, DetailPane>>({})
  const [homeView, setHomeView] = useState<'home' | 'all'>('home')
  const [initialObject, setInitialObject] = useState<{
    kind: 'file' | 'mail' | 'meeting'
    id: string
    roomId: string
  } | null>(null)
  const activeRoom = state.rooms.find((room) => room.id === activeRoomId) ?? null
  const roomDocuments = useRoomDocumentsState()
  const reportedRoomsRef = useRef(new Map<string, string>())
  const deletedKnowledgeRoomsRef = useRef(new Set<string>())
  const roomContextRequestRef = useRef(0)
  const activeDocuments = activeRoomId
    ? roomDocuments.documentsByRoom[activeRoomId] ?? []
    : []
  const activeDocumentKey = activeDocuments
    .map((document) => `${document.id}:${document.version}:${document.status}`)
    .sort()
    .join('\u0000')
  const hasDocumentContext = activeDocuments.length > 0
    || Boolean(activeRoom?.generatedContext?.sourceDocuments.length)

  const syncKnowledgeRooms = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return

    const activeIds = new Set(state.rooms.map((room) => room.id))
    for (const room of state.rooms) {
      deletedKnowledgeRoomsRef.current.delete(room.id)
      if (!shouldSyncRoomToKnowledge(room)) continue
      const fingerprint = `${room.title}\u0000${room.kind}`
      if (reportedRoomsRef.current.get(room.id) === fingerprint) continue
      reportedRoomsRef.current.set(room.id, fingerprint)
      void knowledge.upsertRoom({ id: room.id, title: room.title, kind: room.kind }).catch(() => {
        if (reportedRoomsRef.current.get(room.id) === fingerprint) {
          reportedRoomsRef.current.delete(room.id)
        }
      })
    }

    for (const room of state.deletedRooms) {
      reportedRoomsRef.current.delete(room.id)
      if (!shouldDeleteRoomFromKnowledge(room) || deletedKnowledgeRoomsRef.current.has(room.id)) continue
      deletedKnowledgeRoomsRef.current.add(room.id)
      void knowledge.deleteRoom(room.id).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!/room_not_found/i.test(message)) deletedKnowledgeRoomsRef.current.delete(room.id)
      })
    }

    try {
      const remote = await knowledge.listRooms('auto')
      setState((current) => {
        const rooms = mergeAutoKnowledgeRooms(current.rooms, current.deletedRooms, remote.items)
        return rooms === current.rooms ? current : { ...current, rooms }
      })
    } catch {
      // Knowledge is optional during startup; the interval below retries once it is ready.
    }

    for (const roomId of [...reportedRoomsRef.current.keys()]) {
      if (!activeIds.has(roomId)) reportedRoomsRef.current.delete(roomId)
    }
  }, [setState, state.deletedRooms, state.rooms])

  useEffect(() => {
    void syncKnowledgeRooms()
    const interval = window.setInterval(() => void syncKnowledgeRooms(), 5_000)
    const onChanged = () => void syncKnowledgeRooms()
    window.addEventListener('everroom:knowledge-changed', onChanged)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('everroom:knowledge-changed', onChanged)
    }
  }, [syncKnowledgeRooms])

  useEffect(() => {
    onRoomsChange(state.rooms.map(({ id, title, kind, brief, generatedContext }) => ({
      id,
      title,
      kind,
      background: brief.background,
      goal: brief.goal,
      status: generatedContext?.status || brief.status,
      ...(generatedContext ? {
        contextSummary: {
          generatedAt: generatedContext.generatedAt,
          overview: generatedContext.overview ?? '',
          nextSteps: generatedContext.nextSteps,
          entities: generatedContext.entities,
          actionItems: generatedContext.actionItems,
          meetings: generatedContext.meetings,
          sourceDocuments: generatedContext.sourceDocuments,
        },
      } : {}),
    })))
  }, [onRoomsChange, state.rooms])

  useEffect(() => {
    const focused = Boolean(activeRoomId)
    onDetailFocusChange(focused)
    return () => onDetailFocusChange(false)
  }, [activeRoomId, onDetailFocusChange])

  useEffect(() => {
    if (!activeRoomId) return
    void roomDocuments.refreshRoom(activeRoomId).catch(() => undefined)
  }, [activeRoomId, roomDocuments.refreshRoom])

  useEffect(() => {
    if (!activeRoomId || !hasDocumentContext || !window.nxcore?.knowledge?.getRoomContext) return
    const requestId = roomContextRequestRef.current + 1
    roomContextRequestRef.current = requestId
    const timer = window.setTimeout(() => {
      void window.nxcore!.knowledge.getRoomContext(activeRoomId).then((context) => {
        if (roomContextRequestRef.current !== requestId || context.roomId !== activeRoomId) return
        setState((current) => {
          const room = current.rooms.find((item) => item.id === activeRoomId)
          if (!room) return current
          const updated = applyGeneratedRoomContext(room, context)
          if (updated === room) return current
          return {
            ...current,
            rooms: current.rooms.map((item) => item.id === activeRoomId ? updated : item),
          }
        })
      }).catch(() => undefined)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [activeDocumentKey, activeRoomId, hasDocumentContext, setState])

  useEffect(() => {
    if (homeRequest === handledHomeRequest.current) return
    handledHomeRequest.current = homeRequest
    setInitialObject(null)
    setHomeView('home')
    onShowHome()
  }, [homeRequest, onShowHome])

  useEffect(() => {
    if (!activeRoomId || initialObject?.roomId !== activeRoomId) return
    setInitialObject(null)
  }, [activeRoomId, initialObject])

  const updateRoom = (updater: (room: ContextRoomRecord) => ContextRoomRecord) => {
    if (!activeRoomId) return
    setState((current) => {
      const updatedAt = new Date().toISOString()
      return {
        ...current,
        rooms: current.rooms.map((room) => {
          if (room.id !== activeRoomId) return room
          const updated = updater(room)
          return updated === room ? room : { ...updated, updatedAt }
        }),
      }
    })
  }

  const openRoom = (roomId: string) => {
    const room = state.rooms.find((item) => item.id === roomId)
    if (!room) return
    setInitialObject(null)
    onOpenRoomTab({ id: room.id, title: room.title })
  }

  const renameRoom = (roomId: string, name: string) => setState((current) => ({
    ...current,
    rooms: current.rooms.map((room) => room.id === roomId
      ? {
          ...room,
          title: name,
          updatedAt: new Date().toISOString(),
          ...(room.origin === 'auto' ? { origin: 'user' as const } : {}),
        }
      : room),
  }))

  const deleteRoom = (roomId: string) => setState((current) => {
    const room = current.rooms.find((item) => item.id === roomId)
    return room
      ? { rooms: current.rooms.filter((item) => item.id !== roomId), deletedRooms: [room, ...current.deletedRooms] }
      : current
  })

  const restoreRoom = (roomId: string) => setState((current) => {
    const room = current.deletedRooms.find((item) => item.id === roomId)
    return room
      ? {
          rooms: [{ ...room, origin: 'user', updatedAt: new Date().toISOString() }, ...current.rooms],
          deletedRooms: current.deletedRooms.filter((item) => item.id !== roomId),
        }
      : current
  })

  if (activeRoom) {
    return (
      <PortedDetail
        key={activeRoom.id}
        room={activeRoom}
        rooms={state.rooms}
        backendDocuments={roomDocuments.documentsByRoom[activeRoom.id] ?? []}
        trashedDocuments={roomDocuments.trashedDocumentsByRoom[activeRoom.id] ?? []}
        focusedDocumentId={focusedDocumentId ?? roomDocuments.focusedDocumentByRoom[activeRoom.id] ?? null}
        focusedBlockId={focusedBlockId}
        documentFocusRequestId={documentFocusRequestId}
        onBackendDocumentChange={roomDocuments.upsertDocument}
        onCreateDocument={roomDocuments.createDocument}
        onDeleteDocument={roomDocuments.deleteDocument}
        onRestoreDocument={roomDocuments.restoreDocument}
        onDeleteDocumentPermanently={roomDocuments.deleteDocumentPermanently}
        onEmptyTrash={roomDocuments.emptyTrash}
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

  if (homeView === 'all') {
    return (
      <Suspense fallback={<AllRoomsViewSkeleton />}>
        <AllRoomsView
          rooms={state.rooms}
          onBack={() => setHomeView('home')}
          onOpenDetail={openRoom}
          onRenameRoom={renameRoom}
          onDeleteRoom={deleteRoom}
          onRestoreRoom={restoreRoom}
        />
      </Suspense>
    )
  }

  return (
    <HomeView
      rooms={state.rooms}
      deletedRooms={state.deletedRooms}
      onCreateRoom={async (draft) => {
        const api = window.nxcore?.contextRooms
        if (!api?.create) throw new Error(t('contextRoom:roomDialogs.serviceUnavailable'))
        const result = await api.create({ title: draft.name, description: draft.description })
        const refreshed = await refreshFromBackend()
        const room = refreshed?.rooms.find((item) => item.id === result.room.id)
        if (!room) throw new Error(t('contextRoom:roomDialogs.createFailed'))
        onOpenRoomTab({ id: room.id, title: room.title })
      }}
      onRenameRoom={renameRoom}
      onDeleteRoom={deleteRoom}
      onRestoreRoom={restoreRoom}
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
      onShowAll={() => setHomeView('all')}
      onFocusAgent={onFocusAgent}
    />
  )
}
