import { describe, expect, it } from 'vitest'

import {
  clearRoomOnboardingMarker,
  readRoomOnboardingMarker,
  ROOM_ONBOARDING_STORAGE_KEY,
  shouldShowRoomOnboarding,
  writeRoomOnboardingMarker,
} from '../src/renderer/src/components/onboarding/roomOnboardingState'

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem: (key: string) => key === ROOM_ONBOARDING_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === ROOM_ONBOARDING_STORAGE_KEY) value = next
    },
    removeItem: (key: string) => {
      if (key === ROOM_ONBOARDING_STORAGE_KEY) value = null
    },
  }
}

describe('room onboarding state', () => {
  it('shows on first use when the backend is ready and there are no rooms', () => {
    expect(shouldShowRoomOnboarding(true, 0, null)).toBe(true)
  })

  it('shows on first use even when a built-in data Room already exists', () => {
    expect(shouldShowRoomOnboarding(true, 1, null)).toBe(true)
  })

  it('waits for the Context Room backend before showing', () => {
    expect(shouldShowRoomOnboarding(false, 0, null)).toBe(false)
  })

  it('does not show after Memory onboarding is reopened from Settings', () => {
    expect(shouldShowRoomOnboarding(true, 0, null, true)).toBe(false)
  })

  it('persists a skipped marker and suppresses the guide', () => {
    const storage = memoryStorage()
    writeRoomOnboardingMarker({ status: 'skipped' }, storage)

    const marker = readRoomOnboardingMarker(storage)
    expect(marker).toEqual({ status: 'skipped' })
    expect(shouldShowRoomOnboarding(true, 0, marker)).toBe(false)
  })

  it('persists only the created Room id in a completed marker', () => {
    const storage = memoryStorage()
    writeRoomOnboardingMarker({ status: 'completed', roomId: 'room-1' }, storage)

    const marker = readRoomOnboardingMarker(storage)
    expect(marker).toEqual({ status: 'completed', roomId: 'room-1' })
    expect(shouldShowRoomOnboarding(true, 0, marker)).toBe(false)
  })

  it('treats corrupt JSON as a missing marker', () => {
    const storage = memoryStorage('{not-json')
    expect(readRoomOnboardingMarker(storage)).toBeNull()
  })

  it('clears an existing marker', () => {
    const storage = memoryStorage()
    writeRoomOnboardingMarker({ status: 'skipped' }, storage)
    clearRoomOnboardingMarker(storage)
    expect(readRoomOnboardingMarker(storage)).toBeNull()
  })
})
