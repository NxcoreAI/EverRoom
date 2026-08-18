import type { DocumentOperationSummary } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import { createDesktopOperationBridge } from '../src/renderer/src/components/context-room/operations/desktopOperationBridge'
import type { NxcoreDesktopApi } from '../src/shared/sources'

function summary(id: string, status: DocumentOperationSummary['status'], capabilityId = 'document.edit'):
DocumentOperationSummary {
  return {
    id,
    capabilityId,
    capabilityVersion: 1,
    interactionMode: 'atomic_review',
    presenterKey: 'atomic-diff',
    roomId: 'room-1',
    documentId: 'doc-1',
    documentTitle: '计划',
    sessionId: 'session-1',
    runId: 'run-1',
    baseVersion: 1,
    status,
    revision: 1,
    summary: '',
    conflictVersion: null,
    error: null,
    expiresAt: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    completedAt: null,
  }
}

describe('Desktop document operation bridge', () => {
  it('merges status requests, filters capabilities, and forwards change ids', async () => {
    const listeners = new Set<(operationId: string) => void>()
    const listOperations = vi.fn(async ({ status }: { status?: string }) => status === 'failed'
      ? [summary('operation-2', 'failed', 'document.continue')]
      : [summary('operation-1', 'awaiting_review'), summary('operation-2', 'failed', 'document.continue')])
    const documents = {
      listOperations,
      getOperation: vi.fn(),
      executeOperationCommand: vi.fn(),
      onOperationChanged: (listener: (operationId: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as NxcoreDesktopApi['documents']
    const bridge = createDesktopOperationBridge(documents)

    await expect(bridge.list({
      roomId: 'room-1',
      statuses: ['awaiting_review', 'failed'],
      capabilityId: 'document.edit',
    })).resolves.toEqual([summary('operation-1', 'awaiting_review')])
    expect(listOperations).toHaveBeenCalledTimes(2)
    expect(listOperations).toHaveBeenNthCalledWith(1, { roomId: 'room-1', status: 'awaiting_review' })
    expect(listOperations).toHaveBeenNthCalledWith(2, { roomId: 'room-1', status: 'failed' })

    const listener = vi.fn()
    const unsubscribe = bridge.subscribe?.(listener)
    for (const notify of listeners) notify('operation-3')
    expect(listener).toHaveBeenCalledWith('operation-3')
    unsubscribe?.()
    expect(listeners.size).toBe(0)
  })
})
