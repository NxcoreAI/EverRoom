import type { MemoryOverviewDto } from '../../../../shared/memory'

import { memoryOverviewIsEmpty } from './memoryOnboardingState'

export const FULL_ONBOARDING_STORAGE_KEY = 'everroom:onboarding:full:v1'

export function readFullOnboardingCompleted(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    return storage.getItem(FULL_ONBOARDING_STORAGE_KEY) === 'completed'
  } catch {
    return false
  }
}

export function writeFullOnboardingCompleted(
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(FULL_ONBOARDING_STORAGE_KEY, 'completed')
  } catch {
    // Data checks still prevent the guide from reopening when storage is unavailable.
  }
}

export function hasExistingOnboardingData(input: {
  memoryOverview?: Pick<MemoryOverviewDto, 'l0' | 'l1'> | null
  roomCount?: number
  deletedRoomCount?: number
  sourceCount?: number
}): boolean {
  return Boolean(
    (input.memoryOverview && !memoryOverviewIsEmpty(input.memoryOverview))
      || (input.roomCount ?? 0) > 0
      || (input.deletedRoomCount ?? 0) > 0
      || (input.sourceCount ?? 0) > 0,
  )
}
