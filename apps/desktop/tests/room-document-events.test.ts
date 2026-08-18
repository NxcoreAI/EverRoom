import { describe, expect, it } from 'vitest'

import {
  documentFromEvent,
  mergeRoomDocuments,
  replaceRoomDocuments,
} from '../src/renderer/src/components/context-room/ported/hooks/useRoomDocuments'

const document = {
  id: 'doc-1',
  roomId: 'room-1',
  title: '后台文档',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  version: 0,
  status: 'draft' as const,
  activeTransactionId: 'tx-1',
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:01.000Z',
}

describe('Room document state events', () => {
  it('reads the authoritative draft snapshot from a document change', () => {
    expect(documentFromEvent({
      id: 'event-1',
      roomId: 'room-1',
      documentId: 'doc-1',
      operationId: 'operation-1',
      type: 'document.changed',
      occurredAt: '2026-08-16T00:00:01.000Z',
      payload: { document },
    })).toEqual(document)
  })

  it('keeps a newly saved title when an older refresh arrives later', () => {
    const renamed = {
      ...document,
      title: '新文档标题',
      version: 3,
      updatedAt: '2026-08-16T00:00:03.000Z',
    }
    const stale = {
      ...document,
      title: '旧文档标题',
      version: 2,
      updatedAt: '2026-08-16T00:00:02.000Z',
    }

    expect(mergeRoomDocuments([renamed], [stale])).toEqual([renamed])
    expect(replaceRoomDocuments([renamed], [stale])).toEqual([renamed])
  })

  it('updates the document list from a newer authoritative title', () => {
    const renamed = {
      ...document,
      title: '新文档标题',
      version: 2,
      updatedAt: '2026-08-16T00:00:02.000Z',
    }

    expect(mergeRoomDocuments([document], [renamed])).toEqual([renamed])
    expect(replaceRoomDocuments([document], [renamed])).toEqual([renamed])
  })
})
