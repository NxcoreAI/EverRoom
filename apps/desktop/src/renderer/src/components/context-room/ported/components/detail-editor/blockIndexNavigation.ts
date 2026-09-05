export interface RoomMemoryNavigationTarget {
  roomId: string
  memoryId: string
}

export const OPEN_ROOM_MEMORY_EVENT = 'everroom:open-room-memory'

export function requestRoomMemoryNavigation(target: RoomMemoryNavigationTarget): void {
  window.dispatchEvent(new CustomEvent<RoomMemoryNavigationTarget>(OPEN_ROOM_MEMORY_EVENT, { detail: target }))
}

export function onRoomMemoryNavigation(
  listener: (target: RoomMemoryNavigationTarget) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<RoomMemoryNavigationTarget>).detail)
  window.addEventListener(OPEN_ROOM_MEMORY_EVENT, handle)
  return () => window.removeEventListener(OPEN_ROOM_MEMORY_EVENT, handle)
}
