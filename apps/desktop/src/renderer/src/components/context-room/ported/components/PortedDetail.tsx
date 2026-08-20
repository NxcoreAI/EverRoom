import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../i18n/LocaleContext'

import { consumeDocumentFocusRequest } from '../documentFocus'
import {
  createContextRoomFileItem,
  createContextRoomResourceLibrary,
  getRoomResource,
} from '../resources'
import type { ContextRoomRecord, ContextRoomResource, ContextRoomWikiPageResource } from '../types'
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
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
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
  focusedDocumentId: string | null
  focusedBlockId: string | null
  documentFocusRequestId: number | null
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
  const { locale, t } = useLocale()
  const [activePane, setActivePaneState] = useState<DetailPane>(initialActivePane)
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null)
  const [selectedObject, setSelectedObject] = useState<WorkspaceObjectPreview | null>(null)
  /** WikiPane 打开过的 wiki 页资源（静态 library 不含它们，编辑栏解析时并入）。 */
  const [wikiPageResources, setWikiPageResources] = useState<ContextRoomWikiPageResource[]>([])
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
    () => createContextRoomResourceLibrary(room, backendDocuments, [], locale),
    [backendDocuments, locale, room],
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

  const findWikiPageResource = useCallback(
    (roomId: string, resourceId: string) =>
      wikiPageResources.find((resource) => resource.id === resourceId && resource.roomId === roomId),
    [wikiPageResources],
  )
  const selectedResource = selectedResourceId
    ? (getRoomResource(library, room.id, selectedResourceId)
      ?? findWikiPageResource(room.id, selectedResourceId)
      ?? null)
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

  const openWikiPage = useCallback((resource: ContextRoomWikiPageResource) => {
    if (resource.roomId !== room.id) return
    setWikiPageResources((current) =>
      current.some((item) => item.id === resource.id) ? current : [...current, resource])
    setSelectedObject(null)
    setSelectedResourceId(resource.id)
    // 不切走 documents：编辑栏对 wiki-page 资源单独放宽面板门槛（见 WorkspaceContent），左侧目录树保持在场
    if (!layout.panels.includes('wiki')) layout.switchPane('wiki')
    layout.setMobileContent(true)
  }, [layout, room.id])

  const createDocument = useCallback(async (title: string, contentJson?: TiptapJsonContent) => {
    const document = await onCreateDocument(room.id, title, contentJson)
    const resource = createContextRoomResourceLibrary(room, [document], [], locale).resources.find((candidate) =>
      candidate.kind === 'cloud-doc' && candidate.binding.docId === document.id)
    if (resource) openResource(resource)
  }, [locale, onCreateDocument, openResource, room])

  const addLocalFile = useCallback((file: LocalOfficeFile) => {
    const item = createContextRoomFileItem(file, locale)
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
  }, [layout, locale, onUpdateRoom, room.id, setActivePane])

  useEffect(() => {
    const resource = library.resources.find((candidate) =>
      candidate.kind === 'cloud-doc' && candidate.binding.docId === focusedDocumentId)
    const decision = consumeDocumentFocusRequest(
      handledDocumentFocusKey.current,
      room.id,
      focusedDocumentId,
      Boolean(resource),
      documentFocusRequestId,
    )
    handledDocumentFocusKey.current = decision.handledKey
    if (decision.shouldOpen && resource && resource.id !== selectedResourceId) openResource(resource)
  }, [documentFocusRequestId, focusedDocumentId, library.resources, openResource, room.id, selectedResourceId])

  useEffect(() => {
    if (selectedResourceId
      && (getRoomResource(library, room.id, selectedResourceId)
        || findWikiPageResource(room.id, selectedResourceId))) return
    const nextDocument = library.resources.find((resource) => resource.kind === 'cloud-doc')
    setSelectedResourceId(nextDocument?.id ?? null)
  }, [library, room.id, selectedResourceId, findWikiPageResource])

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
          focusedDocumentId={focusedDocumentId}
          focusedBlockId={focusedBlockId}
          documentFocusRequestId={documentFocusRequestId}
          onBackendDocumentChange={onBackendDocumentChange}
          onCreateDocument={createDocument}
          onDeleteDocument={onDeleteDocument}
          onRestoreDocument={onRestoreDocument}
          onDeleteDocumentPermanently={onDeleteDocumentPermanently}
          onEmptyTrash={onEmptyTrash}
          onSelectResource={openResource}
          onOpenWikiPage={openWikiPage}
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
          aria-label={t('contextRoom:portedDetail.backToContextRoomHome')}
          onClick={onBack}
        >
          {t('contextRoom:portedDetail.backToContextRoom')}
        </button>
      </main>
    </div>
  )
}
