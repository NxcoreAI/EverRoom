import { describe, expect, it } from 'vitest'

import {
  FULL_ONBOARDING_STORAGE_KEY,
  ONBOARDING_PROBE_RETRY_ATTEMPTS,
  hasExistingOnboardingData,
  nextOnboardingProbeAction,
  onboardingProbeRetryDelayMs,
  readFullOnboardingCompleted,
  writeFullOnboardingCompleted,
} from '../src/renderer/src/components/onboarding/fullOnboardingState'

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem: (key: string) => key === FULL_ONBOARDING_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === FULL_ONBOARDING_STORAGE_KEY) value = next
    },
  }
}

describe('full onboarding state', () => {
  it('persists completion across renderer restarts', () => {
    const storage = memoryStorage()
    expect(readFullOnboardingCompleted(storage)).toBe(false)

    writeFullOnboardingCompleted(storage)

    expect(readFullOnboardingCompleted(storage)).toBe(true)
  })

  it('treats any existing workspace data as completed onboarding', () => {
    expect(hasExistingOnboardingData({ memoryOverview: { l0: { total: 1 }, l1: null } })).toBe(true)
    expect(hasExistingOnboardingData({ roomCount: 1 })).toBe(true)
    expect(hasExistingOnboardingData({ deletedRoomCount: 1 })).toBe(true)
    expect(hasExistingOnboardingData({ sourceCount: 1 })).toBe(true)
  })

  it('allows onboarding only for a completely empty workspace', () => {
    expect(hasExistingOnboardingData({
      memoryOverview: { l0: { total: 0 }, l1: null },
      roomCount: 0,
      deletedRoomCount: 0,
      sourceCount: 0,
    })).toBe(false)
  })
})

describe('onboarding probe action (first-run check timing)', () => {
  it('retries transient failures during the MemoryCore restart window', () => {
    // Regression: saving the runtime config restarts MemoryCore (~3s); the
    // first probe often fails and used to strand the user on an empty shell.
    expect(nextOnboardingProbeAction({ failed: true, apisAvailable: true, hasData: false, attempt: 1 })).toBe('retry')
    expect(onboardingProbeRetryDelayMs(1)).toBe(1_000)
    expect(onboardingProbeRetryDelayMs(2)).toBe(2_000)
  })

  it('never stalls the first-run user when services stay unreachable', () => {
    for (let attempt = 1; attempt < ONBOARDING_PROBE_RETRY_ATTEMPTS; attempt += 1) {
      expect(nextOnboardingProbeAction({ failed: true, apisAvailable: true, hasData: false, attempt })).toBe('retry')
    }
    // Retries exhausted: stand down without advancing the guide stage — the
    // user keeps the operable main UI (no hidden shell) and later checks can
    // still run the guide; completion must not be persisted on a failure.
    expect(nextOnboardingProbeAction({ failed: true, apisAvailable: true, hasData: false, attempt: ONBOARDING_PROBE_RETRY_ATTEMPTS })).toBe('stand-down')
  })

  it('prefers existing workspace data even when part of the probe failed', () => {
    expect(nextOnboardingProbeAction({ failed: true, apisAvailable: true, hasData: true, attempt: ONBOARDING_PROBE_RETRY_ATTEMPTS })).toBe('complete-existing')
  })

  it('advances the full onboarding only when every service was reachable', () => {
    expect(nextOnboardingProbeAction({ failed: false, apisAvailable: true, hasData: false, attempt: 1 })).toBe('advance')
    // Missing preload APIs: do nothing (test environments expose no window.nxcore).
    expect(nextOnboardingProbeAction({ failed: false, apisAvailable: false, hasData: false, attempt: 1 })).toBe('wait')
  })
})
