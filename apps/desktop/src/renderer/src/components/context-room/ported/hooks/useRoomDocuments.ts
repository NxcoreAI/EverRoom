import type { DocumentEvent, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import i18n from '@/i18n/i18next'

import { hasEmbeddedDocumentImages, localizeDocumentImages } from '../components/detail-editor/documentImageAssets'
import { invalidateDocumentBlockReferences } from '../components/detail-editor/documentBlockReferenceInvalidation'

export function documentFromEvent(event: DocumentEvent): RoomDocument | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const document = (event.payload as { document?: unknown }).document
  if (!document || typeof document !== 'object') return null
  const value = document as Partial<RoomDocument>
  return typeof value.id === 'string' && value.roomId === event.roomId ? value as RoomDocument : null
}

function newerDocument(current: RoomDocument | undefined, incoming: RoomDocument): RoomDocument {
  if (!current) return incoming
  if (incoming.version !== current.version) return incoming.version > current.version ? incoming : current
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

export function mergeRoomDocuments(current: RoomDocument[], incoming: RoomDocument[]): RoomDocument[] {
  const byId = new Map(current.map((document) => [document.id, document]))
  for (const document of incoming) byId.set(document.id, newerDocument(byId.get(document.id), document))
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function replaceRoomDocuments(current: RoomDocument[], incoming: RoomDocument[]): RoomDocument[] {
  const currentById = new Map(current.map((document) => [document.id, document]))
  return incoming
    .map((document) => newerDocument(currentById.get(document.id), document))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

const DOCUMENT_STATE_EVENT_TYPES = new Set<DocumentEvent['type']>([
  'document.changed',
  'document.operation.changed',
  'document.deleted',
])

export function useRoomDocuments(roomIds: string[]) {
  const [documentsByRoom, setDocumentsByRoom] = useState<Record<string, RoomDocument[]>>({})
  const [trashedDocumentsByRoom, setTrashedDocumentsByRoom] = useState<Record<string, RoomDocument[]>>({})
  const [focusedDocumentByRoom, setFocusedDocumentByRoom] = useState<Record<string, string | null>>({})
  const [loadingRooms, setLoadingRooms] = useState<Record<string, boolean>>({})
  const subscribedRooms = useRef(new Set<string>())
  const roomKey = useMemo(() => [...roomIds].sort().join('\u0000'), [roomIds])

  const upsertDocument = useCallback((document: RoomDocument) => {
    if (document.deletedAt) {
      setDocumentsByRoom((current) => ({
        ...current,
        [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
      }))
      setTrashedDocumentsByRoom((current) => ({
        ...current,
        [document.roomId]: mergeRoomDocuments(current[document.roomId] ?? [], [document]),
      }))
      return
    }
    setTrashedDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
    }))
    setDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: mergeRoomDocuments(current[document.roomId] ?? [], [document]),
    }))
  }, [])

  const refreshRoom = useCallback(async (roomId: string): Promise<void> => {
    const documents = window.nxcore?.documents
    if (!documents) return
    setLoadingRooms((current) => ({ ...current, [roomId]: true }))
    try {
      const [listed, trashed] = await Promise.all([
        documents.list(roomId),
        documents.listTrash(roomId),
      ])
      setDocumentsByRoom((current) => ({
        ...current,
        [roomId]: replaceRoomDocuments(current[roomId] ?? [], listed),
      }))
      setTrashedDocumentsByRoom((current) => ({
        ...current,
        [roomId]: replaceRoomDocuments(current[roomId] ?? [], trashed),
      }))
      const activeDraft = listed.find((document) => document.status === 'draft' && document.activeTransactionId)
      if (activeDraft) {
        setFocusedDocumentByRoom((current) => ({ ...current, [roomId]: activeDraft.id }))
      }
    } finally {
      setLoadingRooms((current) => {
        if (!current[roomId]) return current
        const next = { ...current }
        delete next[roomId]
        return next
      })
    }
  }, [])

  useEffect(() => {
    const documents = window.nxcore?.documents
    if (!documents) return
    return documents.onEvent(({ event }) => {
      if (!DOCUMENT_STATE_EVENT_TYPES.has(event.type)) return

      const document = documentFromEvent(event)
      if (document) {
        upsertDocument(document)
        if (document.status === 'draft' && document.activeTransactionId) {
          setFocusedDocumentByRoom((current) => ({ ...current, [event.roomId]: document.id }))
        } else {
          setFocusedDocumentByRoom((current) => current[event.roomId] === document.id
            ? { ...current, [event.roomId]: null }
            : current)
        }
      }

      if (event.type === 'document.deleted') {
        setDocumentsByRoom((current) => ({
          ...current,
          [event.roomId]: (current[event.roomId] ?? []).filter((candidate) => candidate.id !== event.documentId),
        }))
        setTrashedDocumentsByRoom((current) => ({
          ...current,
          [event.roomId]: (current[event.roomId] ?? []).filter((candidate) => candidate.id !== event.documentId),
        }))
        setFocusedDocumentByRoom((current) => current[event.roomId] === event.documentId
          ? { ...current, [event.roomId]: null }
          : current)
      }

      if (document || event.type === 'document.deleted') {
        invalidateDocumentBlockReferences({ roomId: event.roomId, documentId: event.documentId })
      }
    })
  }, [upsertDocument])

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
      setLoadingRooms((current) => {
        if (!current[roomId]) return current
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
  }, [])

  const deleteDocument = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(i18n.t('surface:agent.documentServiceUnavailable'))
    await documents.delete(document.id)
    upsertDocument({ ...document, deletedAt: new Date().toISOString() })
    setFocusedDocumentByRoom((current) => current[document.roomId] === document.id
      ? { ...current, [document.roomId]: null }
      : current)
  }, [upsertDocument])

  const createDocument = useCallback(async (
    roomId: string,
    title: string,
    contentJson: TiptapJsonContent = { type: 'doc', content: [{ type: 'paragraph' }] },
  ) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(i18n.t('surface:agent.documentServiceUnavailable'))
    const documentId = crypto.randomUUID()
    const localizedContent = hasEmbeddedDocumentImages(contentJson)
      ? (await localizeDocumentImages(contentJson, documentId, documents.storeImage)).content
      : contentJson
    const document = await documents.import({
      id: documentId,
      roomId,
      title,
      contentJson: localizedContent,
    })
    upsertDocument(document)
    return document
  }, [upsertDocument])

  const restoreDocument = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(i18n.t('surface:agent.documentServiceUnavailable'))
    upsertDocument(await documents.restore(document.id))
  }, [upsertDocument])

  const deleteDocumentPermanently = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(i18n.t('surface:agent.documentServiceUnavailable'))
    await documents.deletePermanently(document.id)
    setTrashedDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
    }))
  }, [])

  const emptyTrash = useCallback(async (roomId: string) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(i18n.t('surface:agent.documentServiceUnavailable'))
    await documents.emptyTrash(roomId)
    setTrashedDocumentsByRoom((current) => ({ ...current, [roomId]: [] }))
  }, [])

  return {
    documentsByRoom,
    trashedDocumentsByRoom,
    documentsLoading: Object.keys(loadingRooms).length > 0,
    focusedDocumentByRoom,
    upsertDocument,
    createDocument,
    deleteDocument,
    restoreDocument,
    deleteDocumentPermanently,
    emptyTrash,
    refreshRoom,
  }
}
