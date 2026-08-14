import { useCallback, useMemo, useState } from 'react'

import {
  createContextRoomFileItem,
  createContextRoomResourceLibrary,
  getRoomResource,
} from '../resources'
import type { ContextRoomRecord, ContextRoomResource } from '../types'
import { useContextRoomLayout } from '../hooks/useContextRoomLayout'
import { ObjectDetailView } from './ObjectDetailView'
import type { DetailObject } from './ObjectDetailView'
import type { DetailPane } from './RoomIconSidebar'
import type { WorkspaceObjectPreview } from './detail-panels'
import type { LocalOfficeFile } from './detail-panels/ResourcePanel'
import { MailDetailDialog } from './detail-workspace/MailDetailDialog'
import { WorkspaceLayout } from './detail-workspace/WorkspaceLayout'

export function PortedDetail({
  room,
  rooms,
  initialObject,
  onBack,
  onOpenRoom,
  onUpdateRoom,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  initialObject?: { kind: 'file' | 'mail' | 'meeting'; id: string } | null
  onBack: () => void
  onOpenRoom: (roomId: string) => void
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void
}) {
  const [activePane, setActivePane] = useState<DetailPane>('overview')
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null)
  const [selectedObject, setSelectedObject] = useState<WorkspaceObjectPreview | null>(null)
  const [selectedMailId, setSelectedMailId] = useState<string | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const [standaloneObject, setStandaloneObject] = useState<DetailObject | null>(() => {
    if (!initialObject) return null
    if (initialObject.kind === 'file') {
      const value = room.fileItems.find((item) => item.id === initialObject.id)
      return value ? { kind: 'file', value } : null
    }
    const value = room.materials.find((item) => item.id === initialObject.id)
    return value ? { kind: initialObject.kind, value } : null
  })
  const library = useMemo(() => createContextRoomResourceLibrary(room), [room])
  const layout = useContextRoomLayout({
    activePane,
    onActivePaneChange: setActivePane,
    onEnterDocuments: () => undefined,
  })

  const selectedResource = selectedResourceId
    ? (getRoomResource(library, room.id, selectedResourceId) ?? null)
    : null
  const selectedMemory = selectedMemoryId
    ? room.memoryItems.find((item) => item.id === selectedMemoryId) ?? null
    : null

  const openResource = useCallback((resource: ContextRoomResource) => {
    if (resource.roomId !== room.id) return
    setSelectedObject(null)
    setSelectedResourceId(resource.id)
    if (!layout.panels.includes('documents')) layout.switchPane('documents')
    layout.setMobileContent(true)
  }, [layout, room.id])

  const openObject = useCallback((target: WorkspaceObjectPreview) => {
    if (target.kind === 'mail') {
      setSelectedMailId(target.id)
      return
    }
    const pane: DetailPane = target.kind === 'meeting'
      ? 'schedule'
      : target.kind === 'task'
        ? 'tasks'
        : 'relations'
    setSelectedObject(target)
    setSelectedResourceId(null)
    if (!layout.panels.includes(pane)) layout.switchPane(pane)
    layout.setMobileContent(true)
  }, [layout])

  const addLocalFile = useCallback((file: LocalOfficeFile) => {
    const item = createContextRoomFileItem(file)
    onUpdateRoom((current) => {
      if (current.fileItems.some((candidate) => candidate.hostfsPath === file.path)) return current
      return {
        ...current,
        fileItems: [...current.fileItems, item],
        stats: { ...current.stats, docs: current.stats.docs + 1 },
      }
    })
    setSelectedResourceId(`${room.id}:file:${item.id}`)
    setSelectedObject(null)
    layout.setPanels(['documents'])
    layout.setPanelWeights([1])
    layout.setActivePanelIndex(0)
    layout.setMiddleHidden(false)
    layout.setMobileContent(true)
    setActivePane('documents')
  }, [layout, onUpdateRoom, room.id])

  const toggleTask = (taskId: string) => onUpdateRoom((current) => ({
    ...current,
    actionItems: current.actionItems.map((item) => item.id === taskId
      ? { ...item, completed: !item.completed, status: item.completed ? '进行中' : '已完成' }
      : item),
  }))

  if (selectedMemory) {
    return (
      <ObjectDetailView
        room={room}
        object={{ kind: 'memory', value: selectedMemory }}
        onBack={() => setSelectedMemoryId(null)}
        onUpdateRoom={onUpdateRoom}
      />
    )
  }

  if (standaloneObject) {
    return (
      <ObjectDetailView
        room={room}
        object={standaloneObject}
        onBack={() => setStandaloneObject(null)}
        onUpdateRoom={onUpdateRoom}
      />
    )
  }

  return (
    <div className="context-room-app">
      <main className="context-room-workspace" data-testid="context-room-detail-layout">
        <WorkspaceLayout
          room={room}
          rooms={rooms}
          {...layout}
          selectedResourceId={selectedResourceId}
          selectedObject={selectedObject}
          selectedResource={selectedResource}
          onSelectResource={openResource}
          onAddFile={addLocalFile}
          onOpenMemory={setSelectedMemoryId}
          onOpenObject={openObject}
          onCloseObject={() => {
            setSelectedObject(null)
            layout.setMobileContent(false)
          }}
          onOpenRoom={onOpenRoom}
          onToggleTask={toggleTask}
          onUpdateRoom={onUpdateRoom}
        />
        <MailDetailDialog
          room={room}
          mailId={selectedMailId}
          onClose={() => setSelectedMailId(null)}
        />
        <button
          type="button"
          className="context-room-visually-hidden"
          aria-label="Back to Context Room home"
          onClick={onBack}
        >
          返回 Context Room
        </button>
      </main>
    </div>
  )
}
