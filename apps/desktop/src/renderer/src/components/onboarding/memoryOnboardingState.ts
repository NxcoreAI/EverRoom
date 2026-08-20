import type { MemoryAtomicItemDto, MemoryAtomicProvenanceDto } from '../../../../shared/memory'

export const MEMORY_ONBOARDING_STORAGE_KEY = 'everroom:onboarding:memory:v1'
export const MEMORY_ONBOARDING_FOREGROUND_TIMEOUT_MS = 90_000
export const MEMORY_ONBOARDING_FOREGROUND_POLL_MS = 2_000
export const MEMORY_ONBOARDING_BACKGROUND_POLL_MS = 15_000

interface OnboardingMarkerBase {
  requestId: string
  sessionId: string
  capturedAt: string
}

export type MemoryOnboardingMarker =
  | { status: 'skipped' }
  | ({ status: 'pending' } & OnboardingMarkerBase)
  | ({ status: 'completed'; memoryId: string } & OnboardingMarkerBase)

export function readMemoryOnboardingMarker(storage: Pick<Storage, 'getItem'> = window.localStorage): MemoryOnboardingMarker | null {
  try {
    const raw = storage.getItem(MEMORY_ONBOARDING_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<MemoryOnboardingMarker>
    if (value.status === 'skipped') return { status: 'skipped' }
    if (
      (value.status === 'pending' || value.status === 'completed')
      && typeof value.requestId === 'string'
      && typeof value.sessionId === 'string'
      && typeof value.capturedAt === 'string'
    ) {
      if (value.status === 'completed' && typeof value.memoryId === 'string') {
        return { status: 'completed', requestId: value.requestId, sessionId: value.sessionId, capturedAt: value.capturedAt, memoryId: value.memoryId }
      }
      if (value.status === 'pending') {
        return { status: 'pending', requestId: value.requestId, sessionId: value.sessionId, capturedAt: value.capturedAt }
      }
    }
  } catch {
    // Corrupt or unavailable storage should behave like a first launch.
  }
  return null
}

export function writeMemoryOnboardingMarker(marker: MemoryOnboardingMarker, storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  try {
    storage.setItem(MEMORY_ONBOARDING_STORAGE_KEY, JSON.stringify(marker))
  } catch {
    // The onboarding remains usable when persistence is unavailable.
  }
}

export function memoryOverviewIsEmpty(overview: { l0: { total: number } | null; l1: { total: number } | null }): boolean {
  return (overview.l0?.total ?? 0) === 0 && (overview.l1?.total ?? 0) === 0
}

export function candidateOnboardingMemories(
  memories: MemoryAtomicItemDto[],
  capturedAt: string,
  baselineIds: ReadonlySet<string> = new Set(),
): MemoryAtomicItemDto[] {
  const capturedTime = new Date(capturedAt).getTime()
  return memories
    .filter((memory) => !baselineIds.has(memory.id))
    .filter((memory) => {
      const createdTime = new Date(memory.createdAt).getTime()
      return Number.isNaN(capturedTime) || Number.isNaN(createdTime) || createdTime >= capturedTime - 5_000
    })
    .slice(0, 30)
}

export function provenanceMatchesOnboarding(provenance: MemoryAtomicProvenanceDto, sessionId: string): boolean {
  return provenance.session?.sessionId === sessionId
    || provenance.anchors.some((anchor) => anchor.sessionId === sessionId)
}
