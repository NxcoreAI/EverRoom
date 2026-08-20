import { describe, expect, it } from 'vitest'

import type { MemoryAtomicItemDto, MemoryAtomicProvenanceDto } from '../src/shared/memory'
import {
  candidateOnboardingMemories,
  memoryOverviewIsEmpty,
  provenanceMatchesOnboarding,
  readMemoryOnboardingMarker,
  writeMemoryOnboardingMarker,
} from '../src/renderer/src/components/onboarding/memoryOnboardingState'

function atomic(id: string, createdAt: string): MemoryAtomicItemDto {
  return { id, type: 'persona', content: id, background: null, createdAt, updatedAt: createdAt }
}

describe('memory onboarding state', () => {
  it('shows only when both L0 and L1 are empty', () => {
    expect(memoryOverviewIsEmpty({ l0: { total: 0 }, l1: { total: 0 } })).toBe(true)
    expect(memoryOverviewIsEmpty({ l0: { total: 1 }, l1: { total: 0 } })).toBe(false)
    expect(memoryOverviewIsEmpty({ l0: { total: 0 }, l1: { total: 1 } })).toBe(false)
  })

  it('persists only resumable request metadata', () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next },
    }
    const marker = {
      status: 'pending' as const,
      requestId: 'request-1',
      sessionId: 'onboarding:request-1',
      capturedAt: '2026-08-20T10:00:00.000Z',
    }
    writeMemoryOnboardingMarker(marker, storage)
    expect(value).not.toContain('workContext')
    expect(readMemoryOnboardingMarker(storage)).toEqual(marker)
  })

  it('excludes baseline and stale memories before provenance checks', () => {
    const memories = [
      atomic('new', '2026-08-20T10:00:01.000Z'),
      atomic('baseline', '2026-08-20T10:00:01.000Z'),
      atomic('old', '2026-08-20T09:59:40.000Z'),
    ]
    expect(candidateOnboardingMemories(
      memories,
      '2026-08-20T10:00:00.000Z',
      new Set(['baseline']),
    ).map((item) => item.id)).toEqual(['new'])
  })

  it('requires the onboarding session in provenance', () => {
    const provenance = {
      memoryId: 'memory-1',
      type: 'persona',
      content: 'content',
      kind: 'conversation',
      session: { sessionId: 'onboarding:request-1', sessionKey: null },
      document: null,
      anchorMessageIds: [],
      anchors: [],
    } satisfies MemoryAtomicProvenanceDto
    expect(provenanceMatchesOnboarding(provenance, 'onboarding:request-1')).toBe(true)
    expect(provenanceMatchesOnboarding(provenance, 'another-session')).toBe(false)
  })
})
