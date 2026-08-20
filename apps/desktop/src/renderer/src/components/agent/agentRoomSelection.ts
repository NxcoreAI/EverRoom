import type { AgentRoomReference, PendingAgentIntent } from '@nxcore/agent-contract'

export interface AgentRoomSelectionResult {
  rooms: AgentRoomReference[]
  selectionRequired: true
  pendingIntent?: PendingAgentIntent
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

export function parsePendingAgentIntent(value: unknown): PendingAgentIntent | null {
  const candidate = record(value)
  if (!candidate) return null
  const targetCapability = candidate.targetCapability
  const allowedRoomIds = Array.isArray(candidate.allowedRoomIds)
    ? candidate.allowedRoomIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    : []
  const allowedDocumentIds = Array.isArray(candidate.allowedDocumentIds)
    ? candidate.allowedDocumentIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    : []
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.sessionId !== 'string'
    || typeof candidate.sourceRunId !== 'string'
    || typeof candidate.originalPrompt !== 'string'
    || !['document.create', 'document.edit', 'document.continue'].includes(String(targetCapability))
    || allowedRoomIds.length === 0
    || typeof candidate.expiresAt !== 'string'
    || typeof candidate.createdAt !== 'string'
  ) return null
  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    sourceRunId: candidate.sourceRunId,
    originalPrompt: candidate.originalPrompt,
    targetCapability: targetCapability as PendingAgentIntent['targetCapability'],
    allowedRoomIds,
    allowedDocumentIds,
    expiresAt: candidate.expiresAt,
    consumedAt: typeof candidate.consumedAt === 'string' ? candidate.consumedAt : null,
    createdAt: candidate.createdAt,
  }
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
    const pendingIntent = parsePendingAgentIntent(candidate.pendingIntent)
    if (rooms) return { rooms, selectionRequired: true, ...(pendingIntent ? { pendingIntent } : {}) }
  }
  return null
}
