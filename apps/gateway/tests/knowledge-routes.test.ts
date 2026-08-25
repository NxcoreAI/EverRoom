import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { knowledgeRoutes } from '../src/modules/knowledge/routes.js'
import type { KnowledgeService } from '../src/modules/knowledge/service.js'

describe('knowledge room routes', () => {
  it('treats deletion of an absent Room as an idempotent success', async () => {
    const deleteRoom = vi.fn().mockReturnValue(false)
    const service = { deleteRoom } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/knowledge/rooms/missing-room',
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe('')
      expect(deleteRoom).toHaveBeenCalledWith('missing-room')
    } finally {
      await app.close()
    }
  })

  it('accepts up to 20 recommendations and returns per-entity batch results', async () => {
    const promoteEntities = vi.fn().mockReturnValue([
      { entityId: 'ready-1', status: 'queued', jobId: 'job-1', error: null },
      { entityId: 'stale-1', status: 'rejected', jobId: null, error: 'recommendation_below_threshold' },
    ])
    const suppressEntities = vi.fn().mockReturnValue([
      { entityId: 'ready-1', status: 'suppressed', error: null },
    ])
    const service = { promoteEntities, suppressEntities } as unknown as KnowledgeService
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
    await app.register(knowledgeRoutes(service))

    try {
      const promoted = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-promote',
        payload: { entityIds: ['ready-1', 'stale-1'] },
      })
      expect(promoted.statusCode).toBe(202)
      expect(promoted.json().items).toHaveLength(2)
      expect(promoteEntities).toHaveBeenCalledWith(['ready-1', 'stale-1'])

      const suppressed = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-suppress',
        payload: { entityIds: ['ready-1'] },
      })
      expect(suppressed.statusCode).toBe(200)
      expect(suppressEntities).toHaveBeenCalledWith(['ready-1'])

      const tooMany = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/entities/batch-promote',
        payload: { entityIds: Array.from({ length: 21 }, (_, index) => `entity-${index}`) },
      })
      expect(tooMany.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
