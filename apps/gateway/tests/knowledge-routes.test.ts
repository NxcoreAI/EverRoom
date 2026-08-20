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
})
