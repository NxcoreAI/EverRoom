import { describe, expect, it } from 'vitest'

import { parseAgentNotificationTarget } from '../src/shared/notifications'

const expected = {
  kind: 'agent_session' as const,
  notificationId: 'notification-1',
  sourceDeviceId: 'device-1',
  sessionId: 'session-1',
  runId: 'run-1',
  roomId: 'room-1',
}

describe('parseAgentNotificationTarget', () => {
  it('parses live APNs payloads', () => {
    expect(parseAgentNotificationTarget({ everroom: expected })).toEqual(expected)
  })

  it('parses cold-launch notification responses', () => {
    expect(parseAgentNotificationTarget({ userInfo: { everroom: expected } })).toEqual(expected)
  })

  it('rejects partial or arbitrary navigation payloads', () => {
    expect(parseAgentNotificationTarget({ everroom: { ...expected, runId: '' } })).toBeNull()
    expect(parseAgentNotificationTarget({ kind: 'url', url: 'https://example.com' })).toBeNull()
  })
})
