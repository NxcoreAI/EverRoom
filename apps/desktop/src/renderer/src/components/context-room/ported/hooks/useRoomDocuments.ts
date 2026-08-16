import type { DocumentEvent, RoomDocument } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export function documentFromEvent(event: DocumentEvent): RoomDocument | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const document = (event.payload as { document?: unknown }).document
  if (!document || typeof document !== 'object') return null
  const value = document as Partial<RoomDocument>
  return typeof value.id === 'string' && value.roomId === event.roomId ? value as RoomDocument : null
}

function mergeDocuments(current: RoomDocument[], incoming: RoomDocument[]): RoomDocument[] {
  const byId = new Map(current.map((document) => [document.id, document]))
  for (const document of incoming) byId.set(document.id, document)
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function isDocumentStreamPresentationEvent(event: Pick<DocumentEvent, 'type'>): boolean {
  return event.type === 'document.appended' || event.type === 'document.commit-requested'
}

export function shouldRetainDocumentEvent(
  event: Pick<DocumentEvent, 'type'>,
  presentationReady: boolean,
): boolean {
  return !isDocumentStreamPresentationEvent(event) || presentationReady
}

export function useRoomDocuments(roomIds: string[]) {
  const [documentsByRoom, setDocumentsByRoom] = useState<Record<string, RoomDocument[]>>({})
  const [trashedDocumentsByRoom, setTrashedDocumentsByRoom] = useState<Record<string, RoomDocument[]>>({})
  const [eventsByDocument, setEventsByDocument] = useState<Record<string, DocumentEvent[]>>({})
  const [focusedDocumentByRoom, setFocusedDocumentByRoom] = useState<Record<string, string | null>>({})
  const subscribedRooms = useRef(new Set<string>())
  const visibleDocumentCounts = useRef(new Map<string, number>())
  const presentationReadyDocuments = useRef(new Set<string>())
  const visibilityEpochs = useRef(new Map<string, number>())
  const refreshQueues = useRef(new Map<string, Promise<void>>())
  const roomKey = useMemo(() => [...roomIds].sort().join('\u0000'), [roomIds])

  const upsertDocument = useCallback((document: RoomDocument) => {
    if (document.deletedAt) {
      setDocumentsByRoom((current) => ({
        ...current,
        [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
      }))
      setTrashedDocumentsByRoom((current) => ({
        ...current,
        [document.roomId]: mergeDocuments(current[document.roomId] ?? [], [document]),
      }))
      return
    }
    setTrashedDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
    }))
    setDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: mergeDocuments(current[document.roomId] ?? [], [document]),
    }))
  }, [])

  const refreshDocument = useCallback((documentId: string): Promise<void> => {
    const documents = window.nxcore?.documents
    if (!documents) return Promise.resolve()
    const previous = refreshQueues.current.get(documentId) ?? Promise.resolve()
    const refresh = previous
      .catch(() => undefined)
      .then(async () => {
        upsertDocument(await documents.get(documentId))
      })
      .catch(() => undefined)
    refreshQueues.current.set(documentId, refresh)
    void refresh.finally(() => {
      if (refreshQueues.current.get(documentId) === refresh) refreshQueues.current.delete(documentId)
    })
    return refresh
  }, [upsertDocument])

  const refreshPresentationBaseline = useCallback((documentId: string) => {
    presentationReadyDocuments.current.delete(documentId)
    const epoch = (visibilityEpochs.current.get(documentId) ?? 0) + 1
    visibilityEpochs.current.set(documentId, epoch)
    void refreshDocument(documentId).finally(() => {
      if (
        visibilityEpochs.current.get(documentId) === epoch
        && (visibleDocumentCounts.current.get(documentId) ?? 0) > 0
      ) {
        presentationReadyDocuments.current.add(documentId)
      }
    })
  }, [refreshDocument])

  const refreshRoom = useCallback(async (roomId: string): Promise<void> => {
    const documents = window.nxcore?.documents
    if (!documents) return
    const [listed, trashed] = await Promise.all([
      documents.list(roomId),
      documents.listTrash(roomId),
    ])
    setDocumentsByRoom((current) => ({ ...current, [roomId]: mergeDocuments([], listed) }))
    setTrashedDocumentsByRoom((current) => ({ ...current, [roomId]: mergeDocuments([], trashed) }))
    const activeDraft = listed.find((document) => document.status === 'draft' && document.activeTransactionId)
    if (activeDraft) {
      setFocusedDocumentByRoom((current) => ({ ...current, [roomId]: activeDraft.id }))
    }
  }, [])

  useEffect(() => {
    const documents = window.nxcore?.documents
    if (!documents) return
    return documents.onEvent(({ event }) => {
      const retainEvent = shouldRetainDocumentEvent(
        event,
        presentationReadyDocuments.current.has(event.documentId),
      )
      if (retainEvent) {
        setEventsByDocument((current) => {
          const events = current[event.documentId] ?? []
          if (events.some((candidate) => candidate.id === event.id)) return current
          return { ...current, [event.documentId]: [...events, event] }
        })
      } else {
        refreshPresentationBaseline(event.documentId)
      }

      const document = documentFromEvent(event)
      if (document) upsertDocument(document)
      if (event.type === 'document.opened') {
        setFocusedDocumentByRoom((current) => ({ ...current, [event.roomId]: event.documentId }))
      } else if (event.type === 'document.committed') {
        if (!presentationReadyDocuments.current.has(event.documentId)) {
          setEventsByDocument((current) => ({ ...current, [event.documentId]: [event] }))
        }
        setFocusedDocumentByRoom((current) => current[event.roomId] === event.documentId
          ? { ...current, [event.roomId]: null }
          : current)
      } else if (event.type === 'document.trashed') {
        setEventsByDocument((current) => {
          const next = { ...current }
          delete next[event.documentId]
          return next
        })
        setFocusedDocumentByRoom((current) => current[event.roomId] === event.documentId
          ? { ...current, [event.roomId]: null }
          : current)
      } else if (event.type === 'document.aborted' || event.type === 'document.deleted') {
        setDocumentsByRoom((current) => ({
          ...current,
          [event.roomId]: (current[event.roomId] ?? []).filter((candidate) => candidate.id !== event.documentId),
        }))
        setTrashedDocumentsByRoom((current) => ({
          ...current,
          [event.roomId]: (current[event.roomId] ?? []).filter((candidate) => candidate.id !== event.documentId),
        }))
        setEventsByDocument((current) => {
          const next = { ...current }
          delete next[event.documentId]
          return next
        })
        setFocusedDocumentByRoom((current) => current[event.roomId] === event.documentId
          ? { ...current, [event.roomId]: null }
          : current)
      }
    })
  }, [refreshPresentationBaseline, upsertDocument])

  useEffect(() => {
    const documents = window.nxcore?.documents
    if (!documents) return
    const currentRoomIds = roomKey ? roomKey.split('\u0000') : []
    const currentRooms = new Set(currentRoomIds)

    for (const roomId of currentRoomIds) {
      if (subscribedRooms.current.has(roomId)) continue
      subscribedRooms.current.add(roomId)
      void documents.subscribe(roomId)
      void refreshRoom(roomId).catch(() => undefined)
    }

    for (const roomId of [...subscribedRooms.current]) {
      if (currentRooms.has(roomId)) continue
      subscribedRooms.current.delete(roomId)
      void documents.unsubscribe(roomId)
      setDocumentsByRoom((current) => {
        const next = { ...current }
        delete next[roomId]
        return next
      })
      setTrashedDocumentsByRoom((current) => {
        const next = { ...current }
        delete next[roomId]
        return next
      })
    }
  }, [refreshRoom, roomKey])

  useEffect(() => () => {
    const documents = window.nxcore?.documents
    if (!documents) return
    for (const roomId of subscribedRooms.current) void documents.unsubscribe(roomId)
    subscribedRooms.current.clear()
    visibleDocumentCounts.current.clear()
    presentationReadyDocuments.current.clear()
    visibilityEpochs.current.clear()
    refreshQueues.current.clear()
  }, [])

  const registerVisibleDocument = useCallback((documentId: string): (() => void) => {
    const currentCount = visibleDocumentCounts.current.get(documentId) ?? 0
    visibleDocumentCounts.current.set(documentId, currentCount + 1)
    if (currentCount === 0) {
      setEventsByDocument((current) => {
        if (!current[documentId]) return current
        const next = { ...current }
        delete next[documentId]
        return next
      })
      refreshPresentationBaseline(documentId)
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const count = visibleDocumentCounts.current.get(documentId) ?? 0
      if (count > 1) {
        visibleDocumentCounts.current.set(documentId, count - 1)
        return
      }
      visibleDocumentCounts.current.delete(documentId)
      presentationReadyDocuments.current.delete(documentId)
      visibilityEpochs.current.set(documentId, (visibilityEpochs.current.get(documentId) ?? 0) + 1)
      setEventsByDocument((current) => {
        if (!current[documentId]) return current
        const next = { ...current }
        delete next[documentId]
        return next
      })
      void refreshDocument(documentId)
    }
  }, [refreshDocument, refreshPresentationBaseline])

  const dismissDocumentPresentation = useCallback((documentId: string, transactionId: string) => {
    setEventsByDocument((current) => {
      const events = current[documentId]
      if (!events?.some((event) => event.transactionId === transactionId)) return current
      const next = { ...current }
      delete next[documentId]
      return next
    })
    void refreshDocument(documentId)
  }, [refreshDocument])

  const deleteDocument = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    await documents.delete(document.id)
    upsertDocument({ ...document, deletedAt: new Date().toISOString() })
    setEventsByDocument((current) => {
      const next = { ...current }
      delete next[document.id]
      return next
    })
    setFocusedDocumentByRoom((current) => current[document.roomId] === document.id
      ? { ...current, [document.roomId]: null }
      : current)
  }, [upsertDocument])

  const createDocument = useCallback(async (roomId: string, title: string) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    const document = await documents.import({
      id: crypto.randomUUID(),
      roomId,
      title,
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    upsertDocument(document)
    return document
  }, [upsertDocument])

  const restoreDocument = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    upsertDocument(await documents.restore(document.id))
  }, [upsertDocument])

  const deleteDocumentPermanently = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    await documents.deletePermanently(document.id)
    setTrashedDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
    }))
    setEventsByDocument((current) => {
      const next = { ...current }
      delete next[document.id]
      return next
    })
  }, [])

  const emptyTrash = useCallback(async (roomId: string) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    const trashedIds = new Set((trashedDocumentsByRoom[roomId] ?? []).map((document) => document.id))
    await documents.emptyTrash(roomId)
    setTrashedDocumentsByRoom((current) => ({ ...current, [roomId]: [] }))
    setEventsByDocument((current) => {
      if (trashedIds.size === 0) return current
      const next = { ...current }
      for (const documentId of trashedIds) delete next[documentId]
      return next
    })
  }, [trashedDocumentsByRoom])

  return {
    documentsByRoom,
    trashedDocumentsByRoom,
    eventsByDocument,
    focusedDocumentByRoom,
    upsertDocument,
    createDocument,
    deleteDocument,
    restoreDocument,
    deleteDocumentPermanently,
    emptyTrash,
    registerVisibleDocument,
    dismissDocumentPresentation,
    refreshRoom,
  }
}
