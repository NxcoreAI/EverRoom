import type { AgentEvent } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { applyShellApprovalEvent, reducePendingShellApprovals } from './agentShellApprovals'

function event(seq: number, type: AgentEvent['type'], payload: unknown): AgentEvent {
  return {
    id: `event-${seq}`,
    sessionId: 'session-1',
    runId: 'run-1',
    seq,
    type,
    occurredAt: new Date(seq * 1_000).toISOString(),
    payload,
  }
}

describe('shell approval event state', () => {
  it('restores only unresolved approvals from event history', () => {
    const approvals = reducePendingShellApprovals([
      event(3, 'approval.requested', { approvalId: 'approval-2', toolName: 'bash', command: 'npm test' }),
      event(1, 'approval.requested', { approvalId: 'approval-1', toolName: 'bash', command: 'rm old.log', cwd: '/workspace' }),
      event(2, 'approval.resolved', { approvalId: 'approval-1', decision: 'denied' }),
    ])

    expect(approvals).toEqual([expect.objectContaining({
      approvalId: 'approval-2',
      command: 'npm test',
      runId: 'run-1',
    })])
  })

  it('ignores malformed requests and removes a resolved approval', () => {
    const requested = event(1, 'approval.requested', {
      approvalId: 'approval-1',
      toolName: 'bash',
      command: 'pnpm typecheck',
      reason: 'Runs a local build tool',
    })
    const pending = applyShellApprovalEvent([], requested)

    expect(applyShellApprovalEvent(pending, event(2, 'approval.resolved', { approvalId: 'approval-1' }))).toEqual([])
    expect(applyShellApprovalEvent([], event(3, 'approval.requested', { approvalId: 'missing-command' }))).toEqual([])
  })
})
