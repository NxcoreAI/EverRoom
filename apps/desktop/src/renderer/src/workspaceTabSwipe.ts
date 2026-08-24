export type WorkspaceTabSwipeTarget = string | null | undefined

export function workspaceTabSwipeTarget(
  roomIds: readonly string[],
  activeRoomId: string | null,
  direction: -1 | 1,
): WorkspaceTabSwipeTarget {
  const roomIndex = activeRoomId === null ? -1 : roomIds.indexOf(activeRoomId)
  if (activeRoomId !== null && roomIndex < 0) return undefined
  const activeIndex = roomIndex + 1
  const targetIndex = activeIndex + direction
  if (targetIndex < 0 || targetIndex > roomIds.length) return undefined
  return targetIndex === 0 ? null : roomIds[targetIndex - 1]
}
