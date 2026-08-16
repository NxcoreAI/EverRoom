import type { AgentRoomReference } from '@nxcore/agent-contract'

export interface AgentRoomSelectionResult {
  rooms: AgentRoomReference[]
  selectionRequired: true
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function roomsFrom(value: unknown): AgentRoomReference[] | null {
  if (!Array.isArray(value)) return null
  const rooms: AgentRoomReference[] = []
  for (const item of value) {
    const candidate = record(item)
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : ''
    const title = typeof candidate?.title === 'string' ? candidate.title.trim() : ''
    if (!id || !title) continue
    const kind = typeof candidate?.kind === 'string' ? candidate.kind.trim() : ''
    rooms.push({ id, title, ...(kind ? { kind } : {}) })
  }
  return rooms
}

export function parseAgentRoomSelectionResult(result: unknown): AgentRoomSelectionResult | null {
  const root = record(result)
  if (!root) return null
  const contentResult = Array.isArray(root.content)
    ? root.content.map((item) => record(item)).find((item) => typeof item?.text === 'string')?.text
    : undefined
  const candidates = [root.details, root.structuredContent, root, contentResult]
  for (const value of candidates) {
    const candidate = record(value)
    if (candidate?.selectionRequired !== true) continue
    const rooms = roomsFrom(candidate.rooms)
    if (rooms) return { rooms, selectionRequired: true }
  }
  return null
}
