import { describe, expect, it } from 'vitest'

import {
  FULL_ONBOARDING_STORAGE_KEY,
  hasExistingOnboardingData,
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
