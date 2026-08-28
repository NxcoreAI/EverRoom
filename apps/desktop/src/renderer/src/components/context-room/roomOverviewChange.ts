import type { RoomOverviewProjection } from '@nxcore/agent-contract'
import { recordRoomOverviewDiagnostic } from './roomOverviewDiagnostics'

export const ROOM_OVERVIEW_CHANGED_EVENT = 'nxcore:room-overview-changed'

export const ROOM_OVERVIEW_PROJECTION_TOOL_NAMES = [
  'context_room_overview_regenerate',
  'context_room_correction_apply',
  'context_room_correction_apply_citation',
  'context_room_correction_revoke',
] as const

export type RoomOverviewProjectionToolName = typeof ROOM_OVERVIEW_PROJECTION_TOOL_NAMES[number]

export function isRoomOverviewProjectionToolName(value: string): value is RoomOverviewProjectionToolName {
  return (ROOM_OVERVIEW_PROJECTION_TOOL_NAMES as readonly string[]).includes(value)
}

export interface RoomOverviewChangedDetail {
  roomId: string | null
  projection?: RoomOverviewProjection
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isProjection(value: unknown): value is RoomOverviewProjection {
  const candidate = record(value)
  return Boolean(candidate
    && typeof candidate.roomId === 'string'
    && typeof candidate.revision === 'number'
    && typeof candidate.generatedAt === 'string'
    && Array.isArray(candidate.overview)
    && Array.isArray(candidate.status)
    && Array.isArray(candidate.nextSteps)
    && Array.isArray(candidate.timeline)
    && Array.isArray(candidate.entities)
    && Array.isArray(candidate.appliedCorrectionIds))
}

/** Extract the freshly reprojected overview from an Agent apply/revoke tool result. */
export function roomOverviewProjectionFromToolResult(result: unknown): RoomOverviewProjection | null {
  const root = record(result)
  if (!root) return null
  const candidates = [record(root.details), record(root.structuredContent), root]
  for (const candidate of candidates) {
    if (isProjection(candidate?.overview)) return candidate.overview
    if (isProjection(candidate?.projection)) return candidate.projection
  }
  return null
}

export function publishRoomOverviewChanged(
  result: unknown,
  fallbackRoomId: string | null,
  toolName?: RoomOverviewProjectionToolName,
): void {
  const projection = roomOverviewProjectionFromToolResult(result)
  recordRoomOverviewDiagnostic('overview.tool_result.processed', {
    roomId: projection?.roomId ?? fallbackRoomId,
    toolName: toolName ?? null,
    projectionFound: Boolean(projection),
    revision: projection?.revision ?? null,
    appliedCorrectionCount: projection?.appliedCorrectionIds.length ?? null,
  }, projection ? 'info' : 'warn')
  window.dispatchEvent(new CustomEvent<RoomOverviewChangedDetail>(ROOM_OVERVIEW_CHANGED_EVENT, {
    detail: {
      roomId: projection?.roomId ?? fallbackRoomId,
      ...(projection ? { projection } : {}),
    },
  }))
  recordRoomOverviewDiagnostic('change.published', {
    roomId: projection?.roomId ?? fallbackRoomId,
    toolName: toolName ?? null,
    mode: projection ? 'projection' : 'invalidation',
    revision: projection?.revision ?? null,
  })
}

/** Keep live updates monotonic when historical Agent tool events arrive late. */
export function preferRoomOverviewProjection(
  current: RoomOverviewProjection | null,
  incoming: RoomOverviewProjection,
): RoomOverviewProjection {
  return current && current.revision > incoming.revision ? current : incoming
}
