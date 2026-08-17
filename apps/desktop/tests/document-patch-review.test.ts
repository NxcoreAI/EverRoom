import type {
  DocumentContinuationBlock,
  DocumentEvent,
  DocumentPatch,
  DocumentPatchSummary,
  RoomDocument,
} from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { shouldShowAgentPatchReviewCard } from '../src/renderer/src/components/agent/AgentPatchReviewCard'
import { parseAgentPatchToolResult } from '../src/renderer/src/components/agent/agentPatchResult'
import {
  acceptContinuationBlocksSequentially,
  classifyDocumentPatchError,
} from '../src/renderer/src/components/context-room/patches/DocumentPatchProvider'
import {
  continuationBaseVersion,
  pendingContinuationBlock,
  pendingContinuationBlocks,
  shouldHandleContinuationTab,
} from '../src/renderer/src/components/context-room/patches/documentContinuationState'
import {
  acceptedHunkIds,
  adjacentPatchHunkId,
  decisionsForPatch,
  patchDecisionCounts,
  patchEventUpdate,
  setPatchHunkDecision,
} from '../src/renderer/src/components/context-room/patches/documentPatchState'

const summary: DocumentPatchSummary = {
  id: 'patch-1',
  roomId: 'room-1',
  documentId: 'doc-1',
  documentTitle: '项目计划',
  baseVersion: 3,
  sessionId: 'session-1',
  runId: 'run-1',
  kind: 'edit',
  status: 'pending',
  summary: '调整里程碑',
  hunkCount: 2,
  addedCharacters: 12,
  deletedCharacters: 4,
  acceptedHunkIds: [],
  rejectedHunkIds: [],
  acceptedBlockIds: [],
  rejectedBlockIds: [],
  appliedVersion: null,
  conflictVersion: null,
  expiresAt: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:01.000Z',
}

const patch: DocumentPatch = {
  ...summary,
  baseContentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  proposedContentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  hunks: [
    {
      id: 'hunk-1',
      sequence: 1,
      operation: 'insert',
      target: { at: 'end' },
      markdown: '新增',
      before: [],
      after: [{ type: 'paragraph', content: [{ type: 'text', text: '新增' }] }],
      addedCharacters: 2,
      deletedCharacters: 0,
    },
    {
      id: 'hunk-2',
      sequence: 2,
      operation: 'replace',
      target: { blockId: 'block-1', fromOffset: 0, toOffset: 2 },
      markdown: '替换',
      before: [{ type: 'text', text: '原文' }],
      after: [{ type: 'text', text: '替换' }],
      addedCharacters: 2,
      deletedCharacters: 2,
    },
  ],
  continuationBlocks: [],
  nextPendingBlock: null,
}

const continuationBlock: DocumentContinuationBlock = {
  blockId: 'continuation-block-1',
  sequence: 1,
  hunkId: 'hunk-1',
  target: { at: 'end' },
  contentJson: {
    type: 'paragraph',
    attrs: { id: 'continuation-block-1' },
    content: [{ type: 'text', text: '续写内容' }],
  },
  textPreview: '续写内容',
  addedCharacters: 4,
}

const continuationPatch: DocumentPatch = {
  ...patch,
  kind: 'continue',
  continuationBlocks: [continuationBlock],
  nextPendingBlock: continuationBlock,
}

const document: RoomDocument = {
  id: 'doc-1',
  roomId: 'room-1',
  title: '项目计划',
  contentJson: patch.proposedContentJson,
  version: 4,
  status: 'active',
  activeTransactionId: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:02.000Z',
}

describe('Agent Patch review', () => {
  it('finds a patch id in structured and text tool results', () => {
    expect(parseAgentPatchToolResult({ details: { patchId: ' patch-1 ' } })).toEqual({ patchId: 'patch-1' })
    expect(parseAgentPatchToolResult({
      content: [{ type: 'text', text: JSON.stringify({ patch: { id: 'patch-2' } }) }],
    })).toEqual({ patchId: 'patch-2' })
    expect(parseAgentPatchToolResult({ details: { patchId: '' } })).toBeNull()
  })

  it('keeps local pending decisions and sends accepted hunks in service order', () => {
    const decisions = decisionsForPatch(patch, { 'hunk-2': 'accepted', missing: 'rejected' })
    expect(decisions).toEqual({ 'hunk-2': 'accepted' })
    const next = setPatchHunkDecision(patch, decisions, 'hunk-1', 'rejected')
    expect(patchDecisionCounts(patch, next)).toEqual({ accepted: 1, rejected: 1, undecided: 0 })
    expect(acceptedHunkIds(patch, { 'hunk-2': 'accepted', 'hunk-1': 'accepted' })).toEqual([
      'hunk-1',
      'hunk-2',
    ])
  })

  it('uses authoritative decisions for a finalized patch', () => {
    expect(decisionsForPatch({
      ...patch,
      status: 'applied',
      acceptedHunkIds: ['hunk-1'],
      rejectedHunkIds: ['hunk-2'],
    }, { 'hunk-1': 'rejected', 'hunk-2': 'accepted' })).toEqual({
      'hunk-1': 'accepted',
      'hunk-2': 'rejected',
    })
  })

  it('wraps hunk navigation in both directions', () => {
    expect(adjacentPatchHunkId(patch.hunks, 'hunk-2', 1)).toBe('hunk-1')
    expect(adjacentPatchHunkId(patch.hunks, 'hunk-1', -1)).toBe('hunk-2')
  })

  it('reads patch summary and authoritative document from an applied event', () => {
    const event: DocumentEvent = {
      id: 'event-1',
      roomId: 'room-1',
      documentId: 'doc-1',
      transactionId: null,
      type: 'document.patch-applied',
      occurredAt: '2026-08-17T00:00:02.000Z',
      payload: { patch: { ...summary, status: 'applied' }, document },
    }
    expect(patchEventUpdate(event)).toEqual({
      patchId: 'patch-1',
      patch: { ...summary, status: 'applied' },
      document,
    })
  })

  it('classifies version conflicts separately from recoverable network failures', () => {
    expect(classifyDocumentPatchError({ response: { status: 409 } }).kind).toBe('conflict')
    expect(classifyDocumentPatchError(new Error('offline')).kind).toBe('network')
  })

  it('activates only a pending continuation candidate', () => {
    expect(pendingContinuationBlock(continuationPatch)).toEqual(continuationBlock)
    expect(pendingContinuationBlock({ ...continuationPatch, kind: 'edit' })).toBeNull()
    expect(pendingContinuationBlock({ ...continuationPatch, status: 'rejected' })).toBeNull()
    expect(pendingContinuationBlock({ ...continuationPatch, nextPendingBlock: null })).toBeNull()
  })

  it('shows every undecided continuation block in service order', () => {
    const secondBlock = { ...continuationBlock, blockId: 'continuation-block-2', sequence: 2 }
    const thirdBlock = { ...continuationBlock, blockId: 'continuation-block-3', sequence: 3 }
    expect(pendingContinuationBlocks({
      ...continuationPatch,
      continuationBlocks: [thirdBlock, continuationBlock, secondBlock],
      acceptedBlockIds: [continuationBlock.blockId],
      rejectedBlockIds: [thirdBlock.blockId],
      nextPendingBlock: secondBlock,
    }).map((block) => block.blockId)).toEqual([secondBlock.blockId])
  })

  it('uses the patch base version first and the latest applied version afterwards', () => {
    expect(continuationBaseVersion(continuationPatch)).toBe(3)
    expect(continuationBaseVersion({ ...continuationPatch, appliedVersion: 4 })).toBe(4)
  })

  it('handles only an unmodified Tab for a visible idle candidate', () => {
    const candidate = { key: 'Tab', candidateVisible: true, busy: false }
    expect(shouldHandleContinuationTab(candidate)).toBe(true)
    expect(shouldHandleContinuationTab({ ...candidate, shiftKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, altKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, ctrlKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, metaKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, candidateVisible: false })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, busy: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, key: 'Enter' })).toBe(false)
  })

  it('keeps continuation and edit patches out of Agent review cards', () => {
    expect(shouldShowAgentPatchReviewCard(continuationPatch)).toBe(false)
    expect(shouldShowAgentPatchReviewCard(patch)).toBe(false)
    expect(shouldShowAgentPatchReviewCard(undefined)).toBe(false)
  })

  it('reads continuation advancement events with their authoritative document', () => {
    const advancedPatch = {
      ...continuationPatch,
      acceptedBlockIds: [continuationBlock.blockId],
      appliedVersion: 4,
      nextPendingBlock: null,
    }
    const event: DocumentEvent = {
      id: 'event-continuation-1',
      roomId: 'room-1',
      documentId: 'doc-1',
      transactionId: null,
      type: 'document.patch-continuation-advanced',
      occurredAt: '2026-08-17T00:00:02.000Z',
      payload: {
        patch: advancedPatch,
        document,
        acceptedBlockId: continuationBlock.blockId,
        nextPendingBlock: null,
      },
    }
    expect(patchEventUpdate(event)).toEqual({
      patchId: continuationPatch.id,
      patch: advancedPatch,
      document,
    })
  })

  it('accepts all continuation blocks serially with each authoritative document version', async () => {
    const secondBlock: DocumentContinuationBlock = {
      ...continuationBlock,
      blockId: 'continuation-block-2',
      sequence: 2,
      target: { blockId: continuationBlock.blockId, edge: 'after' },
    }
    const inputs: Array<{ baseVersion: number; blockId: string }> = []
    const acceptedDocuments: RoomDocument[] = []
    const finalPatch = await acceptContinuationBlocksSequentially(
      continuationPatch,
      async (input) => {
        inputs.push(input)
        const isFirst = input.blockId === continuationBlock.blockId
        const nextPatch: DocumentPatch = {
          ...continuationPatch,
          appliedVersion: isFirst ? 4 : 5,
          acceptedBlockIds: isFirst
            ? [continuationBlock.blockId]
            : [continuationBlock.blockId, secondBlock.blockId],
          nextPendingBlock: isFirst ? secondBlock : null,
        }
        return {
          patch: nextPatch,
          document: { ...document, version: isFirst ? 4 : 5 },
          nextPendingBlock: nextPatch.nextPendingBlock,
        }
      },
      (result) => acceptedDocuments.push(result.document),
    )
    expect(inputs).toEqual([
      { baseVersion: 3, blockId: continuationBlock.blockId },
      { baseVersion: 4, blockId: secondBlock.blockId },
    ])
    expect(acceptedDocuments.map((item) => item.version)).toEqual([4, 5])
    expect(finalPatch.nextPendingBlock).toBeNull()
  })
})
