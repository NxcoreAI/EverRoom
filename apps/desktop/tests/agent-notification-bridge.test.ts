import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentNotificationBridgeServer } from '../src/main/cloud/agent-notification-bridge'

const servers: AgentNotificationBridgeServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('AgentNotificationBridgeServer', () => {
  it('requires its bearer token and forwards a valid trusted request', async () => {
    const createAgentNotification = vi.fn(async () => ({ notificationId: 'n1', deliveryCount: 1, createdAt: 'now', deduplicated: false }))
    const server = new AgentNotificationBridgeServer(() => ({ createAgentNotification } as never))
    servers.push(server)
    const connection = await server.start()
    const body = { title: 'Done', body: 'Your Room update is ready', platforms: ['ios'], sessionId: 's1', runId: 'r1', roomId: null, idempotencyKey: '12345678' }

    expect((await fetch(`${connection.baseUrl}/v1/agent-notifications`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401)
    const response = await fetch(`${connection.baseUrl}/v1/agent-notifications`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(createAgentNotification).toHaveBeenCalledWith(body)
  })
})
