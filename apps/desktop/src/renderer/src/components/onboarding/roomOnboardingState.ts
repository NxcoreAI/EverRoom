export const ROOM_ONBOARDING_STORAGE_KEY = 'everroom:onboarding:room:v1'

export type RoomOnboardingMarker =
  | { status: 'skipped' }
  | { status: 'completed'; roomId: string }

export function readRoomOnboardingMarker(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): RoomOnboardingMarker | null {
  try {
    const raw = storage.getItem(ROOM_ONBOARDING_STORAGE_KEY)
    if (!raw) return null

    const value = JSON.parse(raw) as Partial<RoomOnboardingMarker>
    if (value.status === 'skipped') return { status: 'skipped' }
    if (value.status === 'completed' && typeof value.roomId === 'string' && value.roomId.length > 0) {
      return { status: 'completed', roomId: value.roomId }
    }
  } catch {
    // Corrupt or unavailable storage should behave like a first launch.
  }
  return null
}

export function writeRoomOnboardingMarker(
  marker: RoomOnboardingMarker,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(ROOM_ONBOARDING_STORAGE_KEY, JSON.stringify(marker))
  } catch {
    // The onboarding remains usable when persistence is unavailable.
  }
}

export function clearRoomOnboardingMarker(
  storage: Pick<Storage, 'removeItem'> = window.localStorage,
): void {
  try {
    storage.removeItem(ROOM_ONBOARDING_STORAGE_KEY)
  } catch {
    // Clearing a missing or unavailable marker is safe to ignore.
  }
}

export function shouldShowRoomOnboarding(
  backendReady: boolean,
  _roomCount: number,
  marker: RoomOnboardingMarker | null,
): boolean {
  // The guide is about creating a Room, not about whether the workspace is empty.
  // This also keeps first-use onboarding visible when starter/demo data already exists.
  return backendReady && marker === null
}
