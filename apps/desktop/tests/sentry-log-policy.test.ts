import { describe, expect, it } from 'vitest'

import type { CloudAccountStatus } from '../src/shared/sources'
import { isSentryLogModuleAllowed, isSentryRemoteDebugEnabled, syncSentryAccount } from '../src/main/monitoring/sentry'

describe('Sentry log policy', () => {
  it('always rejects document cursor completion logs', () => {
    expect(isSentryLogModuleAllowed('document-cursor-completion')).toBe(false)
    expect(isSentryLogModuleAllowed('renderer')).toBe(true)
  })
})

function proAccount(overrides: Partial<CloudAccountStatus> = {}): CloudAccountStatus {
  return {
    authenticated: true,
    apiBaseUrl: 'https://saas.example',
    user: { id: 'user-1', tenantId: 'tenant-1', email: 'pro@example.com' },
    subscription: {
      status: 'active',
      planCode: 'pro-monthly',
      planName: 'Pro',
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
      quotaSeconds: 1,
      usedSeconds: 0,
      remainingSeconds: 1,
    },
    ...overrides,
  }
}

describe('Sentry remote debug gate', () => {
  it('keeps the previous decision when a sync cannot load the subscription', () => {
    syncSentryAccount(proAccount())
    expect(isSentryRemoteDebugEnabled()).toBe(true)

    syncSentryAccount({ authenticated: true, apiBaseUrl: 'https://saas.example' })
    expect(isSentryRemoteDebugEnabled()).toBe(true)
  })

  it('closes the gate on explicit downgrade or logout', () => {
    syncSentryAccount(proAccount())

    syncSentryAccount(proAccount({
      subscription: { ...proAccount().subscription!, planCode: 'free' },
    }))
    expect(isSentryRemoteDebugEnabled()).toBe(false)

    syncSentryAccount(proAccount())
    syncSentryAccount({ authenticated: false, apiBaseUrl: '' })
    expect(isSentryRemoteDebugEnabled()).toBe(false)
  })
})
