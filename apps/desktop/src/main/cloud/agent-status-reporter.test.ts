import type { AgentEvent, AgentRun } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import { AgentStatusReporter } from './agent-status-reporter'

const run: AgentRun = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'running',
  prompt: 'Prepare the weekly summary',
  lastEventSeq: 1,
  error: null,
  startedAt: '2026-08-20T10:00:00.000Z',
  completedAt: null,
  createdAt: '2026-08-20T10:00:00.000Z',
}

describe('AgentStatusReporter', () => {
  it('projects active and completed runs to SaaS', async () => {
    const reportAgentStatus = vi.fn(async () => true)
    const reporter = new AgentStatusReporter({ reportAgentStatus } as never)

    reporter.trackRun(run)
    await vi.waitFor(() => expect(reportAgentStatus).toHaveBeenLastCalledWith({
      state: 'running',
      sessionId: run.sessionId,
      runId: run.id,
      taskTitle: run.prompt,
      activeSince: run.startedAt,
    }))

    reporter.trackEvent({
      id: 'event-2',
      sessionId: run.sessionId,
      runId: run.id,
      seq: 2,
      type: 'run.completed',
      occurredAt: '2026-08-20T10:01:00.000Z',
      payload: {},
    } satisfies AgentEvent)

    await vi.waitFor(() => expect(reportAgentStatus).toHaveBeenLastCalledWith({ state: 'idle' }))
  })

  it('keeps failed run context visible until the next run', async () => {
    const reportAgentStatus = vi.fn(async () => true)
    const reporter = new AgentStatusReporter({ reportAgentStatus } as never)
    reporter.trackRun(run)
    reporter.trackEvent({
      id: 'event-2',
      sessionId: run.sessionId,
      runId: run.id,
      seq: 2,
      type: 'run.failed',
      occurredAt: '2026-08-20T10:01:00.000Z',
      payload: {},
    })
    reporter.trackEvent({
      id: 'event-2-replayed',
      sessionId: run.sessionId,
      runId: run.id,
      seq: 2,
      type: 'run.failed',
      occurredAt: '2026-08-20T10:01:00.000Z',
      payload: {},
    })

    await vi.waitFor(() => expect(reportAgentStatus).toHaveBeenLastCalledWith({
      state: 'error',
      sessionId: run.sessionId,
      runId: run.id,
      taskTitle: run.prompt,
    }))
  })
})
