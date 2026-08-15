import type { DocumentEvent, RoomDocument } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function documentFromEvent(event: DocumentEvent): RoomDocument | null {
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

export function useRoomDocuments(roomIds: string[]) {
  const [documentsByRoom, setDocumentsByRoom] = useState<Record<string, RoomDocument[]>>({})
  const [eventsByDocument, setEventsByDocument] = useState<Record<string, DocumentEvent[]>>({})
  const [focusedDocumentByRoom, setFocusedDocumentByRoom] = useState<Record<string, string | null>>({})
  const subscribedRooms = useRef(new Set<string>())
  const roomKey = useMemo(() => [...roomIds].sort().join('\u0000'), [roomIds])

  const upsertDocument = useCallback((document: RoomDocument) => {
    setDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: mergeDocuments(current[document.roomId] ?? [], [document]),
    }))
  }, [])

  useEffect(() => {
    const documents = window.nxcore?.documents
    if (!documents) return
    return documents.onEvent(({ event }) => {
      setEventsByDocument((current) => {
        const events = current[event.documentId] ?? []
        if (events.some((candidate) => candidate.id === event.id)) return current
        return { ...current, [event.documentId]: [...events, event] }
      })

      const document = documentFromEvent(event)
      if (document) upsertDocument(document)
      if (event.type === 'document.opened') {
        setFocusedDocumentByRoom((current) => ({ ...current, [event.roomId]: event.documentId }))
      } else if (event.type === 'document.aborted' || event.type === 'document.deleted') {
        setDocumentsByRoom((current) => ({
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
      void documents.list(roomId).then((listed) => {
        setDocumentsByRoom((current) => ({
          ...current,
          [roomId]: mergeDocuments([], listed),
        }))
        const activeDraft = listed.find((document) => document.status === 'draft' && document.activeTransactionId)
        if (activeDraft) {
          setFocusedDocumentByRoom((current) => ({ ...current, [roomId]: activeDraft.id }))
        }
      }).catch(() => undefined)
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
    }
  }, [roomKey])

  useEffect(() => () => {
    const documents = window.nxcore?.documents
    if (!documents) return
    for (const roomId of subscribedRooms.current) void documents.unsubscribe(roomId)
    subscribedRooms.current.clear()
  }, [])

  const deleteDocument = useCallback(async (document: RoomDocument) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档服务不可用')
    await documents.delete(document.id)
    setDocumentsByRoom((current) => ({
      ...current,
      [document.roomId]: (current[document.roomId] ?? []).filter((candidate) => candidate.id !== document.id),
    }))
    setEventsByDocument((current) => {
      const next = { ...current }
      delete next[document.id]
      return next
    })
    setFocusedDocumentByRoom((current) => current[document.roomId] === document.id
      ? { ...current, [document.roomId]: null }
      : current)
  }, [])

  return {
    documentsByRoom,
    eventsByDocument,
    focusedDocumentByRoom,
    upsertDocument,
    deleteDocument,
  }
}
