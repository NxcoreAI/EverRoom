import type { DocumentEvent, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { showToast } from '@/state/toast'

import { consumeDocumentFocusRequest } from '../documentFocus'
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
  backendDocuments,
  trashedDocuments,
  documentEvents,
  focusedDocumentId,
  focusedBlockId,
  initialActivePane,
  initialObject,
  onActivePaneChange,
  onBack,
  onOpenRoom,
  onUpdateRoom,
  onBackendDocumentChange,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onEmptyTrash,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  backendDocuments: RoomDocument[]
  trashedDocuments: RoomDocument[]
  documentEvents: Record<string, DocumentEvent[]>
  focusedDocumentId: string | null
  focusedBlockId: string | null
  initialActivePane: DetailPane
  initialObject?: { kind: 'file' | 'mail' | 'meeting'; id: string } | null
  onActivePaneChange: (pane: DetailPane) => void
  onBack: () => void
  onOpenRoom: (roomId: string) => void
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void
  onBackendDocumentChange: (document: RoomDocument) => void
  onCreateDocument: (roomId: string, title: string, contentJson?: TiptapJsonContent) => Promise<RoomDocument>
  onDeleteDocument: (document: RoomDocument) => Promise<void>
  onRestoreDocument: (document: RoomDocument) => Promise<void>
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>
  onEmptyTrash: (roomId: string) => Promise<void>
}) {
  const [activePane, setActivePaneState] = useState<DetailPane>(initialActivePane)
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null)
  const [selectedObject, setSelectedObject] = useState<WorkspaceObjectPreview | null>(null)
  const [selectedMailId, setSelectedMailId] = useState<string | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const handledDocumentFocusKey = useRef<string | null>(null)
  const [standaloneObject, setStandaloneObject] = useState<DetailObject | null>(() => {
    if (!initialObject) return null
    if (initialObject.kind === 'file') {
      const value = room.fileItems.find((item) => item.id === initialObject.id)
      return value ? { kind: 'file', value } : null
    }
    const value = room.materials.find((item) => item.id === initialObject.id)
    return value ? { kind: initialObject.kind, value } : null
  })
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments),
    [backendDocuments, room],
  )
  const setActivePane = useCallback((pane: DetailPane) => {
    setActivePaneState(pane)
    onActivePaneChange(pane)
  }, [onActivePaneChange])
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

  const createDocument = useCallback(async (title: string, contentJson?: TiptapJsonContent) => {
    const document = await onCreateDocument(room.id, title, contentJson)
    const resource = createContextRoomResourceLibrary(room, [document]).resources.find((candidate) =>
      candidate.kind === 'cloud-doc' && candidate.binding.docId === document.id)
    if (resource) openResource(resource)
  }, [onCreateDocument, openResource, room])

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
  }, [layout, onUpdateRoom, room.id, setActivePane])

  useEffect(() => {
    const resource = library.resources.find((candidate) =>
      candidate.kind === 'cloud-doc' && candidate.binding.docId === focusedDocumentId)
    const decision = consumeDocumentFocusRequest(
      handledDocumentFocusKey.current,
      room.id,
      focusedDocumentId,
      Boolean(resource),
    )
    handledDocumentFocusKey.current = decision.handledKey
    if (decision.shouldOpen && resource && resource.id !== selectedResourceId) openResource(resource)
  }, [focusedDocumentId, library.resources, openResource, room.id, selectedResourceId])

  useEffect(() => {
    if (!focusedBlockId || !focusedDocumentId) return
    let cancelled = false
    let frame = 0
    let attempts = 0
    const focusBlock = () => {
      if (cancelled) return
      const selector = `[data-block-id="${CSS.escape(focusedBlockId)}"]`
      const block = document.querySelector<HTMLElement>(selector)
      if (!block && attempts < 60) {
        attempts += 1
        frame = window.requestAnimationFrame(focusBlock)
        return
      }
      if (!block) {
        showToast({ title: '引用块已失效', message: '已打开文档，但原引用块不存在。' })
        return
      }
      block.scrollIntoView({ behavior: 'smooth', block: 'center' })
      block.dataset.referenceFocus = 'true'
      window.setTimeout(() => delete block.dataset.referenceFocus, 1800)
    }
    frame = window.requestAnimationFrame(focusBlock)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [focusedBlockId, focusedDocumentId, selectedResourceId])

  useEffect(() => {
    if (selectedResourceId && getRoomResource(library, room.id, selectedResourceId)) return
    const nextDocument = library.resources.find((resource) => resource.kind === 'cloud-doc')
    setSelectedResourceId(nextDocument?.id ?? null)
  }, [library, room.id, selectedResourceId])

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
          backendDocuments={backendDocuments}
          trashedDocuments={trashedDocuments}
          documentEvents={documentEvents}
          onBackendDocumentChange={onBackendDocumentChange}
          onCreateDocument={createDocument}
          onDeleteDocument={onDeleteDocument}
          onRestoreDocument={onRestoreDocument}
          onDeleteDocumentPermanently={onDeleteDocumentPermanently}
          onEmptyTrash={onEmptyTrash}
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
