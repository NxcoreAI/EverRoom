import type {
  AgentNavigationAction,
  AgentNavigationObjectType,
  AgentNavigationTarget,
  AgentSessionLink,
} from '@nxcore/agent-contract'

import type { PageId } from '@/data/navigation'
import type { DisplayAgentToolCall } from './useAgentSession'

const pages = new Set<PageId>(['home', 'office', 'rooms', 'docs', 'sources', 'memory', 'tasks', 'diary'])
const actions = new Set<AgentNavigationAction>(['created', 'updated', 'opened', 'referenced'])
const objectTypes = new Set<AgentNavigationObjectType>(['room', 'document', 'source', 'memory', 'task', 'diary'])

export function isAgentPageId(value: string): value is PageId {
  return pages.has(value as PageId)
}

export interface AgentNavigationRequest {
  key: string
  source: {
    sessionId: string
    pageId: PageId
    pageLabel: string
    roomId: string | null
    runId: string
  }
  target: AgentNavigationTarget & { pageId: PageId }
}

export interface AgentSessionRouteRequest {
  key: string
  pageId: PageId
  roomId: string | null
  sessionId: string
  blockId?: string | null
}

export function navigationRequiresSessionHandoff(request: AgentNavigationRequest): boolean {
  const sourceRoomId = request.source.roomId?.trim() || null
  const targetRoomId = request.target.roomId?.trim() || null
  return !sourceRoomId || sourceRoomId !== targetRoomId
}

export function agentSessionLinkDestination(
  link: AgentSessionLink,
  currentSessionId: string | null,
): 'source' | 'target' | null {
  if (currentSessionId === link.targetSessionId) return 'source'
  if (currentSessionId === link.sourceSessionId) return 'target'
  return null
}

export function resolveAgentSessionLinkRoute(
  link: AgentSessionLink,
  destination: 'source' | 'target',
): (AgentSessionRouteRequest & { documentId: string | null }) | null {
  const pageId = destination === 'source' ? link.sourcePageId : link.target.pageId
  if (!isAgentPageId(pageId)) return null
  return {
    key: `${destination}:${link.id}:${Date.now()}`,
    pageId,
    roomId: destination === 'source' ? link.sourceRoomId ?? null : link.target.roomId ?? null,
    sessionId: destination === 'source' ? link.sourceSessionId : link.targetSessionId,
    documentId: destination === 'target' && link.target.objectType === 'document'
      ? link.target.objectId ?? null
      : null,
    blockId: destination === 'target' ? link.target.blockId ?? null : null,
  }
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

function navigationCandidate(result: unknown): Record<string, unknown> | null {
  const root = record(result)
  if (!root) return null
  const details = record(root.details)
  const structuredContent = record(root.structuredContent)
  return record(details?.navigation) ?? record(structuredContent?.navigation) ?? record(root.navigation)
}

export function parseAgentNavigationTarget(result: unknown): (AgentNavigationTarget & { pageId: PageId }) | null {
  const candidate = navigationCandidate(result)
  if (!candidate) return null
  const pageId = typeof candidate.pageId === 'string' ? candidate.pageId.trim() as PageId : '' as PageId
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const action = candidate.action as AgentNavigationAction
  if (!pages.has(pageId) || !title || !actions.has(action)) return null

  const roomId = typeof candidate.roomId === 'string' ? candidate.roomId.trim() : null
  const objectId = typeof candidate.objectId === 'string' ? candidate.objectId.trim() : ''
  const objectType = candidate.objectType as AgentNavigationObjectType | undefined
  const blockId = typeof candidate.blockId === 'string' ? candidate.blockId.trim() : ''
  if (candidate.objectType !== undefined && !objectTypes.has(objectType as AgentNavigationObjectType)) return null
  if (pageId === 'rooms' && !roomId) return null
  if (objectType === 'document' && !objectId) return null

  return {
    pageId,
    title: title.slice(0, 200),
    action,
    ...(candidate.roomId !== undefined ? { roomId } : {}),
    ...(objectId ? { objectId } : {}),
    ...(objectType ? { objectType } : {}),
    ...(blockId ? { blockId } : {}),
  }
}

export function navigationKey(tool: DisplayAgentToolCall, target: AgentNavigationTarget): string {
  return [tool.runId, tool.id, target.pageId, target.roomId ?? '', target.objectId ?? '', target.blockId ?? ''].join('\u0000')
}
