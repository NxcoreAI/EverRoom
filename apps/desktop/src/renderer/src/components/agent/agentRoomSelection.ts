import type { PendingAgentIntent } from '@nxcore/agent-contract'

/**
 * Phase 2i 去 Room：本文件不再解析「选择 Room」卡片（selectionRequired/rooms 已删），
 * 仅保留 pending intent 决策卡的通用解析（allowedRoomIds 恒为空数组，不再要求非空）。
 */

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
