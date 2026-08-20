export const DEMO_CONTEXT_ROOM_IDS = [
  'room-launch',
  'room-nexcore-hub-agent-v2',
  'room-zhang',
  'room-pkm',
  'room-career',
  'room-old',
  'room-1786871627923',
  'room-1787143510152',
] as const

const DEMO_CONTEXT_ROOM_DOCUMENT_IDS = [
  '173712c2-97f6-4ff3-969b-1c0bd5bd470a',
  '414414bb-4266-48ec-b3a6-6e933201385e',
  'a0bd1f33-2582-4f0c-93ab-82f20515be61',
  '19f59c0d-b7a2-4093-9e83-99655b9e1cef',
] as const

const DOCUMENT_DRAFT_PREFIX = 'everroom:context-room:document:v1:'
const AGENT_SESSION_STATE_KEY = 'nxcore-ce:agent-sessions:v1'

const DEMO_CONTEXT_ROOM_ID_SET = new Set<string>(DEMO_CONTEXT_ROOM_IDS)

export function isDemoContextRoomId(roomId: string): boolean {
  return DEMO_CONTEXT_ROOM_ID_SET.has(roomId)
}

export function removeDemoContextRooms<T extends { id: string }>(rooms: T[]): T[] {
  return rooms.filter((room) => !isDemoContextRoomId(room.id))
}

export function removeDemoContextRoomLocalArtifacts(): void {
  if (typeof window === 'undefined') return
  try {
    for (const documentId of DEMO_CONTEXT_ROOM_DOCUMENT_IDS) {
      window.localStorage.removeItem(`${DOCUMENT_DRAFT_PREFIX}${documentId}`)
    }

    const rawSessions = window.localStorage.getItem(AGENT_SESSION_STATE_KEY)
    if (!rawSessions) return
    const sessions = JSON.parse(rawSessions) as Record<string, unknown>
    const filteredSessions = Object.fromEntries(
      Object.entries(sessions).filter(([key]) => (
        !DEMO_CONTEXT_ROOM_IDS.some((roomId) => key === `Context Room:${roomId}`)
      )),
    )
    window.localStorage.setItem(AGENT_SESSION_STATE_KEY, JSON.stringify(filteredSessions))
  } catch {
    // Browser storage is only a cache; the Gateway remains authoritative.
  }
}
