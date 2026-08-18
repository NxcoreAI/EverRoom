import type { RoomDocument } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import {
  AppliedSequenceTracker,
  operationStreamChunksToApply,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/markdownStream'
import {
  operationStreamBaselineKind,
  operationStreamNeedsPresentation,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/operationStreamState'

function document(overrides: Partial<RoomDocument> = {}): RoomDocument {
  return {
    id: 'doc-1',
    roomId: 'room-1',
    title: '测试文档',
    contentJson: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '已写入正文' }] }],
    },
    contentSchemaVersion: 1,
    version: 1,
    status: 'active',
    activeTransactionId: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:01.000Z',
    ...overrides,
  }
}

const completedOperation = {
  operationId: 'operation-1',
  status: 'completed' as const,
  active: false,
}

describe('operation stream state', () => {
  it('treats a completed operation as already represented by the initialized active document', () => {
    const baseline = operationStreamBaselineKind(completedOperation, 'doc-1', document(), false)
    const tracker = new AppliedSequenceTracker()
    const chunks = [
      { id: 'chunk-1', sequence: 1 },
      { id: 'chunk-2', sequence: 2 },
    ]

    expect(baseline).toBe('historical-completion')
    expect(operationStreamChunksToApply(chunks, tracker, baseline !== null)).toEqual([])
    expect(operationStreamNeedsPresentation(completedOperation, null, baseline, false)).toBe(false)
    expect(tracker.has(1)).toBe(true)
    expect(tracker.has(2)).toBe(true)
  })

  it('continues presenting a stream that was active during the current editor mount', () => {
    const baseline = operationStreamBaselineKind(completedOperation, 'doc-1', document(), true)

    expect(baseline).toBeNull()
    expect(operationStreamNeedsPresentation(completedOperation, null, baseline, true)).toBe(true)
    expect(operationStreamNeedsPresentation(completedOperation, 'operation-1', baseline, true)).toBe(false)
  })

  it('baselines a visible authoritative draft but keeps an active stream presented', () => {
    const runningOperation = {
      operationId: 'operation-1',
      status: 'running' as const,
      active: true,
    }
    const baseline = operationStreamBaselineKind(runningOperation, 'doc-1', document({
      status: 'draft',
      activeTransactionId: 'operation-1',
    }), true)

    expect(baseline).toBe('authoritative-draft')
    expect(operationStreamNeedsPresentation(runningOperation, null, baseline, true)).toBe(true)
  })

  it('does not baseline mismatched, empty, or uncommitted documents', () => {
    const emptyDraft = document({
      status: 'draft',
      activeTransactionId: 'operation-1',
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const runningOperation = { ...completedOperation, status: 'running' as const, active: true }

    expect(operationStreamBaselineKind(runningOperation, 'doc-2', document(), true)).toBeNull()
    expect(operationStreamBaselineKind(runningOperation, 'doc-1', emptyDraft, true)).toBeNull()
    expect(operationStreamBaselineKind(runningOperation, 'doc-1', document(), true)).toBeNull()
  })

  it('suppresses historical completion even when operation data arrives before the document', () => {
    const baseline = operationStreamBaselineKind(completedOperation, 'doc-1', null, false)

    expect(baseline).toBe('historical-completion')
    expect(operationStreamNeedsPresentation(completedOperation, null, baseline, false)).toBe(false)
  })
})
