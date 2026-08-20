import { describe, expect, it } from 'vitest'

import { isSentryLogModuleAllowed } from '../src/main/monitoring/sentry'

describe('Sentry log policy', () => {
  it('always rejects document cursor completion logs', () => {
    expect(isSentryLogModuleAllowed('document-cursor-completion')).toBe(false)
    expect(isSentryLogModuleAllowed('renderer')).toBe(true)
  })
})
