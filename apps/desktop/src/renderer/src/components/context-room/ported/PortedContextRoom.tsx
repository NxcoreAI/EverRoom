import { useCallback, useEffect, useRef, useState } from 'react'

import { CONTEXT_ROOMS } from './data'
import { loadContextRoomLocalState, saveContextRoomLocalState } from './contextRoomLocalState'
import type { ContextRoomKind, ContextRoomRecord } from './types'
import type { ContextRoomWorkspaceTab } from '../contextRoomTabs'
import { HomeView } from './components/HomeView'
import { PortedDetail } from './components/PortedDetail'
import type { DetailPane } from './components/RoomIconSidebar'
import { useRoomDocuments } from './hooks/useRoomDocuments'
import type { KnowledgeRoomDto } from '../../../../../shared/knowledge'

interface DraftRoom {
  kind: ContextRoomKind
  name: string
  summary: string
}

const KNOWLEDGE_ROOM_KINDS: ContextRoomKind[] = ['人物', '项目', '主题', '长期目标', '议题', '事件']

function coerceKnowledgeKind(kind: string): ContextRoomKind {
  return KNOWLEDGE_ROOM_KINDS.includes(kind as ContextRoomKind) ? (kind as ContextRoomKind) : '主题'
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
    // 模板 Room（CONTEXT_ROOMS[0]）带的演示性提示字段不渗入新建 Room
    recentSource: undefined,
    crossHint: undefined,
    cloudDoc: { workspaceId: 'local-placeholder', docId: `local-${id}`, title: draft.name },
  }
}

/** gateway 注册表（路由层自动创建）→ 本地 Room 记录；打开/改名即认领（origin 翻 user）。 */
function createAutoRoom(dto: KnowledgeRoomDto): ContextRoomRecord {
  const id = dto.id
  return {
    ...CONTEXT_ROOMS[0],
    id,
    title: dto.title,
    kind: coerceKnowledgeKind(dto.kind),
    origin: 'auto',
    status: '进行中',
    starred: false,
    lastViewed: '刚刚',
    roomCode: id.toUpperCase(),
    brief: {
      background: dto.summary || '资料归类时判定为新主题，自动创建的 Room。',
      goal: '确认归属并补充背景。',
      status: '自动创建，等待认领。',
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
    // 模板 Room（CONTEXT_ROOMS[0]）带的演示性提示字段不渗入新建 Room
    recentSource: undefined,
    crossHint: undefined,
    cloudDoc: { workspaceId: 'local-placeholder', docId: `local-${id}`, title: dto.title },
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
  // 演示 Room 不做初始种子：空列表起步，避免种子经上报流进 gateway rooms 表
  // 污染路由候选池（CONTEXT_ROOMS 仅保留作 createRoom/createAutoRoom 的字段模板）。
  const [state, setState] = useState(() => loadContextRoomLocalState([]))
  const handledHomeRequest = useRef(homeRequest)
  const detailPaneByRoomIdRef = useRef<Record<string, DetailPane>>({})
  const [initialObject, setInitialObject] = useState<{
    kind: 'file' | 'mail' | 'meeting'
    id: string
    roomId: string
  } | null>(null)
  const activeRoom = state.rooms.find((room) => room.id === activeRoomId) ?? null
  const roomDocuments = useRoomDocuments(state.rooms.map((room) => room.id))

  // ── gateway Room 注册表同步（room-wiki 方案 §7.2）──
  // 上报：本地 user Room 幂等 upsert（auto Room 不自动上报——打开/改名才认领）。
  const reportedRooms = useRef<Set<string>>(new Set())
  const reportRoom = useCallback((room: ContextRoomRecord) => {
    if (room.origin === 'auto') return
    const key = `${room.id}:${room.title}`
    if (reportedRooms.current.has(key)) return
    reportedRooms.current.add(key)
    window.nxcore?.knowledge
      ?.upsertRoom({ id: room.id, title: room.title, kind: room.kind })
      .catch(() => reportedRooms.current.delete(key))
  }, [])

  useEffect(() => {
    for (const room of state.rooms) reportRoom(room)
  }, [state.rooms, reportRoom])

  // 反向同步：路由层自动创建的 Room 合入本地列表（打开即认领）
  const syncAutoRooms = useCallback(async () => {
    try {
      const data = await window.nxcore?.knowledge?.listRooms('auto')
      if (!data) return
      setState((current) => {
        const known = new Set(current.rooms.map((room) => room.id))
        const incoming = data.items
          .filter((dto) => !known.has(dto.id))
          .map((dto) => createAutoRoom(dto))
        if (incoming.length === 0) return current
        return { ...current, rooms: [...incoming, ...current.rooms] }
      })
    } catch {
      // 知识服务未启用/未就绪：保持本地态
    }
  }, [])

  useEffect(() => {
    void syncAutoRooms()
    const onChanged = () => void syncAutoRooms()
    window.addEventListener('everroom:knowledge-changed', onChanged)
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged)
  }, [syncAutoRooms])

  useEffect(() => saveContextRoomLocalState(state), [state])

  useEffect(() => {
    onRoomsChange(state.rooms.map(({ id, title }) => ({ id, title })))
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
    if (room.origin === 'auto') {
      // 打开即认领：本地翻 user，触发上报 effect → gateway upsert 翻转 + 旧名进 aliases
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((item) => item.id === roomId ? { ...item, origin: 'user' } : item),
      }))
    }
    onOpenRoomTab({ id: room.id, title: room.title })
  }

  if (activeRoom) {
    return (
      <PortedDetail
        key={activeRoom.id}
        room={activeRoom}
        rooms={state.rooms}
        backendDocuments={roomDocuments.documentsByRoom[activeRoom.id] ?? []}
        documentEvents={roomDocuments.eventsByDocument}
        focusedDocumentId={roomDocuments.focusedDocumentByRoom[activeRoom.id] ?? null}
        onBackendDocumentChange={roomDocuments.upsertDocument}
        onDeleteDocument={roomDocuments.deleteDocument}
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
        // 改名即认领（auto → user），上报 effect 会把新名字 upsert 进注册表
        rooms: current.rooms.map((room) => room.id === roomId
          ? { ...room, title: name, ...(room.origin === 'auto' ? { origin: 'user' as const } : {}) }
          : room),
      }))}
      onDeleteRoom={(roomId) => {
        // 删除上报 gateway（软删：候选池剔除、wiki 归档）；同时清上报缓存，恢复时可重新 upsert
        for (const key of [...reportedRooms.current]) {
          if (key.startsWith(`${roomId}:`)) reportedRooms.current.delete(key)
        }
        window.nxcore?.knowledge?.deleteRoom(roomId).catch(() => undefined)
        setState((current) => {
          const room = current.rooms.find((item) => item.id === roomId)
          return room
            ? { rooms: current.rooms.filter((item) => item.id !== roomId), deletedRooms: [room, ...current.deletedRooms] }
            : current
        })
      }}
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
