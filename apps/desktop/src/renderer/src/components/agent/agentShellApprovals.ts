import type { AgentEvent } from '@nxcore/agent-contract'

export interface PendingShellApproval {
  approvalId: string
  runId: string
  toolName: string
  command: string
  cwd?: string
  reason?: string
  requestedAt: string
}

function requestedApproval(event: AgentEvent): PendingShellApproval | null {
  if (event.type !== 'approval.requested' || !event.payload || typeof event.payload !== 'object') return null
  const payload = event.payload as Record<string, unknown>
  if (
    typeof payload.approvalId !== 'string'
    || typeof payload.command !== 'string'
    || typeof payload.toolName !== 'string'
  ) return null

  return {
    approvalId: payload.approvalId,
    runId: event.runId,
    toolName: payload.toolName,
    command: payload.command,
    ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
    ...(typeof payload.reason === 'string' && payload.reason ? { reason: payload.reason } : {}),
    requestedAt: event.occurredAt,
  }
}

function resolvedApprovalId(event: AgentEvent): string | null {
  if (event.type !== 'approval.resolved' || !event.payload || typeof event.payload !== 'object') return null
  const approvalId = (event.payload as Record<string, unknown>).approvalId
  return typeof approvalId === 'string' ? approvalId : null
}

export function applyShellApprovalEvent(
  approvals: PendingShellApproval[],
  event: AgentEvent,
): PendingShellApproval[] {
  const requested = requestedApproval(event)
  if (requested) {
    const existingIndex = approvals.findIndex((approval) => approval.approvalId === requested.approvalId)
    if (existingIndex < 0) return [...approvals, requested]
    const next = [...approvals]
    next[existingIndex] = requested
    return next
  }

  const resolvedId = resolvedApprovalId(event)
  if (!resolvedId) return approvals
  return approvals.filter((approval) => approval.approvalId !== resolvedId)
}

export function reducePendingShellApprovals(events: AgentEvent[]): PendingShellApproval[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(applyShellApprovalEvent, [])
}
