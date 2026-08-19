import { describe, expect, it, vi } from 'vitest'

import { waitForKnowledgeEntityPromotion } from '../src/renderer/src/components/context-room/ported/knowledgePromotion'

function detail(status: string, roomId: string | null) {
  return {
    entity: {
      id: 'entity-1',
      name: '测试主题',
      aliases: [],
      kind: '主题',
      summary: null,
      status,
      roomId,
      evidenceScore: 2,
      sourceCount: 2,
      mergedFrom: [],
      lastLinkedAt: null,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    },
    room: roomId ? { id: roomId, title: '测试主题', kind: '主题' } : null,
    links: [],
  }
}

describe('knowledge entity promotion polling', () => {
  it('waits until the asynchronous promotion has created a Room', async () => {
    const getEntity = vi.fn()
      .mockResolvedValueOnce(detail('promoting', null))
      .mockResolvedValueOnce(detail('room', 'auto-room-1'))
    const wait = vi.fn().mockResolvedValue(undefined)

    const result = await waitForKnowledgeEntityPromotion({ getEntity }, 'entity-1', {
      attempts: 3,
      intervalMs: 1,
      wait,
    })

    expect(result?.room?.id).toBe('auto-room-1')
    expect(getEntity).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('returns null when cancelled without issuing a request', async () => {
    const controller = new AbortController()
    controller.abort()
    const getEntity = vi.fn()

    await expect(waitForKnowledgeEntityPromotion({ getEntity }, 'entity-1', {
      signal: controller.signal,
    })).resolves.toBeNull()
    expect(getEntity).not.toHaveBeenCalled()
  })
})
