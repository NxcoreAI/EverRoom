import { describe, expect, it } from 'vitest'

import {
  documentFromEvent,
  isDocumentStreamPresentationEvent,
  shouldRetainDocumentEvent,
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

describe('Room document event presentation', () => {
  it('treats append and commit requests as view-only stream events', () => {
    expect(isDocumentStreamPresentationEvent({ type: 'document.appended' })).toBe(true)
    expect(isDocumentStreamPresentationEvent({ type: 'document.commit-requested' })).toBe(true)
    expect(isDocumentStreamPresentationEvent({ type: 'document.committed' })).toBe(false)
  })

  it('keeps stream events only for a hydrated visible editor', () => {
    expect(shouldRetainDocumentEvent({ type: 'document.appended' }, false)).toBe(false)
    expect(shouldRetainDocumentEvent({ type: 'document.appended' }, true)).toBe(true)
    expect(shouldRetainDocumentEvent({ type: 'document.committed' }, false)).toBe(true)
  })

  it('reads the authoritative draft snapshot from an append event', () => {
    expect(documentFromEvent({
      id: 'event-1',
      roomId: 'room-1',
      documentId: 'doc-1',
      transactionId: 'tx-1',
      type: 'document.appended',
      occurredAt: '2026-08-16T00:00:01.000Z',
      payload: { sequence: 1, text: '正文', document },
    })).toEqual(document)
  })
})
