import { describe, expect, it, vi } from 'vitest'

import { NotificationMcpHost, SEND_NOTIFICATION_TOOL } from '../src/modules/notifications/mcp-host.js'

describe('notification MCP tool', () => {
  it('exposes only user-visible content and injects trusted run context', async () => {
    const send = vi.fn(async () => ({ notificationId: 'n1', deliveryCount: 2 }))
    const host = new NotificationMcpHost({ send } as never)
    expect(SEND_NOTIFICATION_TOOL.inputSchema.properties).not.toHaveProperty('sessionId')
    expect(SEND_NOTIFICATION_TOOL.inputSchema.properties).not.toHaveProperty('runId')
    expect(SEND_NOTIFICATION_TOOL.inputSchema.properties).not.toHaveProperty('roomId')

    await host.callTool('send_notification', {
      title: 'Ready',
      body: 'The Room update is complete',
      platforms: ['macos', 'ios'],
    }, {
      agentSessionId: 'trusted-session',
      runId: 'trusted-run',
      roomId: 'trusted-room',
      availableRooms: [],
    })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'trusted-session',
      runId: 'trusted-run',
      roomId: 'trusted-room',
      platforms: ['macos', 'ios'],
      idempotencyKey: expect.stringMatching(/^agent-notification:[a-f0-9]{64}$/),
    }))
  })

  it('rejects content beyond lock-screen limits', async () => {
    const host = new NotificationMcpHost({ send: vi.fn() } as never)
    await expect(host.callTool('send_notification', {
      title: 'x'.repeat(81),
      body: 'summary',
      platforms: ['ios'],
    }, { agentSessionId: 's', runId: 'r', roomId: null, availableRooms: [] })).rejects.toThrow('INVALID_REQUEST')
  })
})
