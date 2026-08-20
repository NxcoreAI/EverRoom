import { describe, expect, it } from 'vitest'

import type { MemoryOverviewDto } from '../src/shared/memory'
import { getPipelineState } from '../src/renderer/src/components/MemoryPipelineStatus'

function overview(overrides: Partial<MemoryOverviewDto> = {}): MemoryOverviewDto {
  const stage = { queued: 0, running: 0, queuedSessions: [], runningSessions: [], idle: true }
  return {
    l0: { total: 10 },
    l1: { total: 4, byType: { episodic: 2, persona: 1, instruction: 1 } },
    l2: { total: 1 },
    l3: { exists: true, updatedAt: '2026-08-21T08:00:00.000Z' },
    pipeline: {
      l1: stage,
      l2: stage,
      l3: stage,
    },
    ...overrides,
  }
}

describe('memory pipeline status', () => {
  it('prioritizes running stages over queued stages', () => {
    expect(getPipelineState(overview({
      pipeline: {
        l1: { queued: 2, running: 0, queuedSessions: [], runningSessions: [], idle: false },
        l2: { queued: 0, running: 1, queuedSessions: [], runningSessions: [], idle: false },
        l3: { queued: 0, running: 0, queuedSessions: [], runningSessions: [], idle: true },
      },
    }))).toBe('running')
  })

  it('reports queued and idle pipeline states', () => {
    expect(getPipelineState(overview({
      pipeline: {
        l1: { queued: 2, running: 0, queuedSessions: [], runningSessions: [], idle: false },
        l2: { queued: 0, running: 0, queuedSessions: [], runningSessions: [], idle: true },
        l3: { queued: 0, running: 0, queuedSessions: [], runningSessions: [], idle: true },
      },
    }))).toBe('queued')
    expect(getPipelineState(overview())).toBe('idle')
    expect(getPipelineState(overview({ pipeline: null }))).toBe('unavailable')
    expect(getPipelineState(overview(), true)).toBe('unavailable')
    expect(getPipelineState(null)).toBe('loading')
  })
})
