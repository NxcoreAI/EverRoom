import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { AllRoomsViewSkeleton } from '../AllRoomsViewSkeleton'
import type { ContextRoomRecord } from './types'
import type { ContextRoomWorkspaceTab } from '../contextRoomTabs'
import { useContextRoomState } from '../ContextRoomStateProvider'
import { useRoomDocumentsState } from '../RoomDocumentsProvider'
import { useLocale } from '../../../i18n/LocaleContext'
import { ReferenceDialog } from './components/shared'
import { RoomDuplicateCenter } from './components/RoomDuplicateCenter'
import { HomeView } from './components/HomeView'
import { PortedDetail } from './components/PortedDetail'
import type { DetailPane } from './components/RoomIconSidebar'
import {
  mergeAutoKnowledgeRooms,
  shouldDeleteRoomFromKnowledge,
  shouldSyncRoomToKnowledge,
} from './knowledgeRoomSync'
import { scheduleRoomMarkdownSweep } from '../knowledgeMarkdownImport'
import type { ObsidianVaultBinding } from '../../../../../shared/obsidian'
import { createEmptyContextRoom } from './contextRoomFactory'
import { ObsidianVaultRoom } from '../obsidian/ObsidianVaultRoom'

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
  const [vaults, setVaults] = useState<ObsidianVaultBinding[]>([])
  const [initialObject, setInitialObject] = useState<{
    kind: 'file' | 'mail' | 'meeting'
    id: string
    roomId: string
  } | null>(null)
  const activeRoom = state.rooms.find((room) => room.id === activeRoomId) ?? null
  // 手动合并（首页/全部列表两个视图共用）：选择对话框 + manualPair 版合并中心。
  const [manualMergeRoom, setManualMergeRoom] = useState<ContextRoomRecord | null>(null)
  const [manualMergePartnerId, setManualMergePartnerId] = useState<string>('')
  const [manualMergePair, setManualMergePair] = useState<{
    roomAId: string; roomA: { id: string; title: string }
    roomBId: string; roomB: { id: string; title: string }
  } | null>(null)
  const openManualMerge = useCallback((room: ContextRoomRecord) => {
    setManualMergeRoom(room)
    setManualMergePartnerId('')
  }, [])

  // 手动合并弹窗组：伙伴选择 + manualPair 版合并中心（两个列表视图共用）。
  const manualMergeDialogs = (
    <>
      <ReferenceDialog
        open={Boolean(manualMergeRoom)}
        onOpenChange={(next) => { if (!next) { setManualMergeRoom(null); setManualMergePartnerId(''); } }}
        title={t('contextRoom:home.manualMergeTitle')}
      >
        <div className="context-room-manual-merge">
          <header>
            <div>
              <span>{t('contextRoom:home.manage')}</span>
              <h2>{t('contextRoom:home.manualMergeTitle')}</h2>
            </div>
          </header>
          <p>{t('contextRoom:home.manualMergeHint', { title: manualMergeRoom?.title ?? '' })}</p>
          <label>
            <span>{t('contextRoom:home.manualMergePartner')}</span>
            <select value={manualMergePartnerId} onChange={(event) => setManualMergePartnerId(event.target.value)}>
              <option value="">{t('contextRoom:home.manualMergePick')}</option>
              {state.rooms.filter((room) => room.id !== manualMergeRoom?.id).map((room) => (
                <option key={room.id} value={room.id}>{room.title}</option>
              ))}
            </select>
          </label>
          <footer>
            <button type="button" onClick={() => { setManualMergeRoom(null); setManualMergePartnerId(''); }}>{t('contextRoom:duplicateCenter.cancel')}</button>
            <button
              type="button"
              className="context-room-primary-button"
              disabled={!manualMergePartnerId || !manualMergeRoom}
              onClick={() => {
                const partner = state.rooms.find((room) => room.id === manualMergePartnerId)
                if (!manualMergeRoom || !partner) return
                setManualMergePair({
                  roomAId: manualMergeRoom.id,
                  roomA: { id: manualMergeRoom.id, title: manualMergeRoom.title },
                  roomBId: partner.id,
                  roomB: { id: partner.id, title: partner.title },
                })
                setManualMergeRoom(null)
                setManualMergePartnerId('')
              }}
            >{t('contextRoom:home.manualMergeContinue')}</button>
          </footer>
        </div>
      </ReferenceDialog>
      <RoomDuplicateCenter
        open={Boolean(manualMergePair)}
        onOpenChange={(next) => { if (!next) setManualMergePair(null) }}
        onMerged={async () => { await refreshFromBackend() }}
        manualPair={manualMergePair}
      />
    </>
  )
  const roomDocuments = useRoomDocumentsState()
  const reportedRoomsRef = useRef(new Map<string, string>())
  const deletedKnowledgeRoomsRef = useRef(new Set<string>())

  const refreshVaults = useCallback(async () => {
    const api = window.nxcore?.obsidian
    if (!api) return
    const bindings = await api.list()
    setVaults(bindings)
    setState((current) => {
      const dedicatedBindings = bindings.filter((vault) => vault.mountMode === 'dedicated')
      const byRoomId = new Map(dedicatedBindings.map((vault) => [vault.roomId, vault]))
      const existingIds = new Set(current.rooms.map((room) => room.id))
      const rooms = current.rooms.map((room) => {
        const binding = byRoomId.get(room.id)
        return binding && (room.origin !== 'source' || room.title !== binding.name)
          ? { ...room, title: binding.name, kind: '项目' as const, origin: 'source' as const, recentSource: { type: 'Obsidian Vault', name: binding.name } }
          : room
      })
      for (const binding of dedicatedBindings) {
        if (existingIds.has(binding.roomId)) continue
        rooms.unshift(createEmptyContextRoom({
          id: binding.roomId, title: binding.name, kind: '项目', origin: 'source',
          background: '持续挂载的 Obsidian Vault，源文件始终保留在原目录。',
          goal: '在 EverRoom 中浏览、编辑并让 Agent 理解 Vault 内容。',
          briefStatus: binding.status === 'connected' ? '来源已连接' : '来源离线',
        }))
        rooms[0] = { ...rooms[0]!, recentSource: { type: 'Obsidian Vault', name: binding.name } }
      }
      return { ...current, rooms }
    })
  }, [setState])

  useEffect(() => {
    void refreshVaults()
    return window.nxcore?.obsidian?.onChanged(() => void refreshVaults())
  }, [refreshVaults])

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

  // 启动补扫：晋升完成时应用未开（推荐面板没观察到 promoting→completed）导致
  // 遗漏的 md→云文档转换，逐 Room 幂等补跑，每应用会话一次。
  useEffect(() => {
    scheduleRoomMarkdownSweep()
  }, [])

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
    const vault = vaults.find((item) => item.roomId === activeRoom.id && item.mountMode === 'dedicated')
    if (vault) return <ObsidianVaultRoom room={activeRoom} vault={vault} onBack={onShowHome} onDisconnect={async (vaultId) => {
      await window.nxcore?.obsidian.disconnect(vaultId)
      setState((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== activeRoom.id) }))
      await refreshVaults()
      onShowHome()
    }} />
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
      <>
      <Suspense fallback={<AllRoomsViewSkeleton />}>
        <AllRoomsView
          rooms={state.rooms}
          onBack={() => setHomeView('home')}
          onOpenDetail={openRoom}
          onRenameRoom={renameRoom}
          onDeleteRoom={deleteRoom}
          onRestoreRoom={restoreRoom}
          onManualMerge={openManualMerge}
        />
      </Suspense>
      {manualMergeDialogs}
      </>
    )
  }

  return (
    <>
    <HomeView
      rooms={state.rooms}
      deletedRooms={state.deletedRooms}
      onCreateRoom={async (draft, duplicateOverrideToken) => {
        const api = window.nxcore?.contextRooms
        if (!api?.create) throw new Error(t('contextRoom:roomDialogs.serviceUnavailable'))
        const result = await api.create({
          title: draft.name,
          description: draft.description,
          ...(duplicateOverrideToken ? { duplicateOverrideToken } : {}),
        })
        const refreshed = await refreshFromBackend()
        const room = refreshed?.rooms.find((item) => item.id === result.room.id)
        if (!room) throw new Error(t('contextRoom:roomDialogs.createFailed'))
        onOpenRoomTab({ id: room.id, title: room.title })
        return room.id
      }}
      onMountObsidian={async () => {
        const binding = await window.nxcore?.obsidian.pickAndMount()
        if (!binding) return
        await refreshVaults()
        onOpenRoomTab({ id: binding.roomId, title: binding.name })
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
      onRefreshRooms={async () => { await refreshFromBackend() }}
      onManualMerge={openManualMerge}
    />
      {manualMergeDialogs}
    </>
  )
}
