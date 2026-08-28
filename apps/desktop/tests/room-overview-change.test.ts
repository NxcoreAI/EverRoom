/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import type { RoomOverviewProjection } from '@nxcore/agent-contract'

import {
  isRoomOverviewProjectionToolName,
  preferRoomOverviewProjection,
  publishRoomOverviewChanged,
  ROOM_OVERVIEW_CHANGED_EVENT,
  roomOverviewProjectionFromToolResult,
  type RoomOverviewChangedDetail,
} from '../src/renderer/src/components/context-room/roomOverviewChange'

function projection(roomId = 'room-1', revision = 4): RoomOverviewProjection {
  return {
    roomId,
    revision,
    generatedAt: '2026-08-27T12:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    nextSteps: [],
    timeline: [],
    entities: [],
    appliedCorrectionIds: ['correction-1'],
  }
}

describe('Room overview change events', () => {
  it('recognizes every tool that returns a live overview projection', () => {
    expect(isRoomOverviewProjectionToolName('context_room_overview_regenerate')).toBe(true)
    expect(isRoomOverviewProjectionToolName('context_room_correction_apply')).toBe(true)
    expect(isRoomOverviewProjectionToolName('context_room_correction_apply_citation')).toBe(true)
    expect(isRoomOverviewProjectionToolName('context_room_correction_revoke')).toBe(true)
    expect(isRoomOverviewProjectionToolName('context_room_correction_propose')).toBe(false)
  })

  it('extracts the reprojected overview from an Agent tool result', () => {
    const updated = projection()
    expect(roomOverviewProjectionFromToolResult({
      content: [{ type: 'text', text: '纠正已应用' }],
      details: { correction: { id: 'correction-1' }, overview: updated },
    })).toEqual(updated)
  })

  it('publishes the projection for immediate UI application and falls back to invalidation', () => {
    const listener = vi.fn()
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)
    const updated = projection('room-live', 7)

    publishRoomOverviewChanged({ details: { overview: updated } }, 'room-fallback')
    publishRoomOverviewChanged({ content: 'legacy result' }, 'room-fallback')

    expect((listener.mock.calls[0]?.[0] as CustomEvent<RoomOverviewChangedDetail>).detail)
      .toEqual({ roomId: 'room-live', projection: updated })
    expect((listener.mock.calls[1]?.[0] as CustomEvent<RoomOverviewChangedDetail>).detail)
      .toEqual({ roomId: 'room-fallback' })
    window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)
  })

  it('does not let a delayed older revision roll back live content', () => {
    const current = projection('room-live', 8)
    const delayed = projection('room-live', 7)
    const currentRevision = projection('room-live', 8)

    expect(preferRoomOverviewProjection(current, delayed)).toBe(current)
    expect(preferRoomOverviewProjection(current, currentRevision)).toBe(currentRevision)
    expect(preferRoomOverviewProjection(null, delayed)).toBe(delayed)
  })
})
