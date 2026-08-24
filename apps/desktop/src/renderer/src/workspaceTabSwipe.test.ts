import { describe, expect, it } from 'vitest'

import { workspaceTabSwipeTarget } from './workspaceTabSwipe'

describe('workspaceTabSwipeTarget', () => {
  const roomIds = ['room-a', 'room-b']

  it('moves between the workbench and room tabs in visible order', () => {
    expect(workspaceTabSwipeTarget(roomIds, null, 1)).toBe('room-a')
    expect(workspaceTabSwipeTarget(roomIds, 'room-a', 1)).toBe('room-b')
    expect(workspaceTabSwipeTarget(roomIds, 'room-b', -1)).toBe('room-a')
    expect(workspaceTabSwipeTarget(roomIds, 'room-a', -1)).toBeNull()
  })

  it('does not move beyond either edge', () => {
    expect(workspaceTabSwipeTarget(roomIds, null, -1)).toBeUndefined()
    expect(workspaceTabSwipeTarget(roomIds, 'room-b', 1)).toBeUndefined()
    expect(workspaceTabSwipeTarget(roomIds, 'missing-room', 1)).toBeUndefined()
  })
})
