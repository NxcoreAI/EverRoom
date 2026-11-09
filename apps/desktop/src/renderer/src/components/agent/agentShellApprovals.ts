import type { AgentEvent } from '@nxcore/agent-contract'

export interface PendingShellApproval {
  approvalId: string
  runId: string
  toolName: string
  command: string
  /** "shell"（pi 档 bash 审批）| "tool"（ACP 渠道会话工具审批）| "card"（通用决策卡）；缺省按 shell 展示。 */
  kind?: string
  cwd?: string
  reason?: string
  requestedAt: string
  /** kind="card" 时的卡片载荷（confirm 计划卡 / question 提问卡）。 */
  card?: {
    kind: 'confirm' | 'question'
    title: string
    body?: string
    plan?: string[]
    options?: string[]
    allowText?: boolean
    palette?: string[]
    fonts?: { heading?: string; body?: string }
    notes?: string[]
  }
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
    ...(typeof payload.kind === 'string' && payload.kind ? { kind: payload.kind } : {}),
    ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
    ...(typeof payload.reason === 'string' && payload.reason ? { reason: payload.reason } : {}),
    requestedAt: event.occurredAt,
    ...(payload.card && typeof payload.card === 'object' ? { card: payload.card as PendingShellApproval['card'] } : {}),
  }
}

function resolvedApprovalId(event: AgentEvent): string | null {
  if (event.type !== 'approval.resolved' || !event.payload || typeof event.payload !== 'object') return null
  const approvalId = (event.payload as Record<string, unknown>).approvalId
  return typeof approvalId === 'string' ? approvalId : null
}

/** run 终态：挂起审批/卡片随 run 生灭——gateway 重启或超时后，旧事件的卡片不得复生。 */
const RUN_TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])

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
  if (resolvedId) return approvals.filter((approval) => approval.approvalId !== resolvedId)
  if (RUN_TERMINAL_EVENTS.has(event.type)) {
    return approvals.filter((approval) => approval.runId !== event.runId)
  }
  return approvals
}

export function reducePendingShellApprovals(events: AgentEvent[]): PendingShellApproval[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(applyShellApprovalEvent, [])
}
