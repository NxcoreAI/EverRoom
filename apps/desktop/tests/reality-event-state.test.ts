import { describe, expect, it } from 'vitest'

import type { RealityEvent } from '../src/shared/sources'
import { mergeRealityEvent, mergeRealitySnapshot } from '../src/renderer/src/components/reality/reality-event-state'

function event(id: string, version: number, summary: string | null): RealityEvent {
  return {
    id,
    version,
    startedAt: `2026-08-17T04:00:0${id === 'newer' ? '2' : '1'}.000Z`,
    transcript: 'transcript',
    insights: { summary },
  } as RealityEvent
}

describe('Reality timeline event merging', () => {
  it('does not let a late REST snapshot replace a newer generated summary', () => {
    const summarized = event('same', 5, 'generated summary')
    const staleSnapshot = event('same', 4, null)

    expect(mergeRealitySnapshot([summarized], [staleSnapshot])).toEqual([summarized])
  })

  it('accepts newer snapshots and removes records absent from the server snapshot', () => {
    const stale = event('same', 4, null)
    const removed = event('removed', 3, 'old summary')
    const summarized = event('same', 5, 'generated summary')

    expect(mergeRealitySnapshot([stale, removed], [summarized])).toEqual([summarized])
  })

  it('ignores an out-of-order realtime event update', () => {
    const summarized = event('same', 5, 'generated summary')

    expect(mergeRealityEvent([summarized], event('same', 4, null))).toEqual([summarized])
  })
})
