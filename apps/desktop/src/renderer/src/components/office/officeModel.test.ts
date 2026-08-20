import { describe, expect, it } from 'vitest'

import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import type { ConnectorSyncJob, ConnectorSyncRun } from '../../../../shared/connector-sync'
import { buildOfficeAgents } from './officeModel'

const session = (id: string, status: AgentSession['status'] = 'running'): AgentSession => ({
  id, roomId: null, pageLabel: '首页', runtimeId: 'pi', title: null, status,
  createdAt: '2026-08-20T08:00:00.000Z', updatedAt: '2026-08-20T08:02:00.000Z',
})

const snapshot = (id: string, runStatus: 'accepted' | 'running'): AgentSessionSnapshot => ({
  session: session(id),
  activeRun: {
    id: `run-${id}`, sessionId: id, status: runStatus, prompt: '处理项目 Alpha 的最新进展',
    lastEventSeq: 1, error: null, startedAt: '2026-08-20T08:01:00.000Z', completedAt: null, createdAt: '2026-08-20T08:01:00.000Z',
  },
  messages: [], lastEventSeq: 1,
})

const job = (id: string, service: string, running = true): ConnectorSyncJob => ({
  id, ownerId: 'owner', name: `${service} 同步`, service, dataset: 'records', resourceType: 'generic', action: 'sync',
  connectionName: null, allowedActions: ['read'], input: {}, goal: '同步数据', promptProfileId: null,
  promptOverride: null, promptVersion: 1, schemaVersion: 1, retryPolicy: { maxAttempts: 1, baseDelayMs: 1000 },
  priority: 0, configVersion: 1, enabled: true, nextRunAt: null, lastRunAt: '2026-08-20T08:02:00.000Z',
  lastSuccessAt: null, lastError: null, checkpoint: null, consecutiveFailures: 0, running,
  scheduleType: 'manual', intervalMs: 60_000, timezone: 'Asia/Shanghai', status: 'active',
})

const run = (jobId: string, status: ConnectorSyncRun['status']): ConnectorSyncRun => ({
  id: `run-${jobId}`, jobId, status, discovered: 1, inserted: 1, updated: 0, unchanged: 0, quarantined: 0,
  failed: 0, errorCode: null, errorMessage: null, agentModel: null, promptVersion: 1,
  promptProfileVersion: null, schemaVersion: 1, renderedPromptHash: null, inputCheckpoint: null,
  outputCheckpoint: null, startedAt: '2026-08-20T08:01:00.000Z', finishedAt: null,
})

describe('buildOfficeAgents', () => {
  it('groups multiple conversation sessions into one logical agent', () => {
    const agents = buildOfficeAgents(
      [session('one'), session('two')],
      [snapshot('one', 'running'), snapshot('two', 'accepted')],
      [],
      new Map(),
    )
    const conversation = agents.find((agent) => agent.id === 'core.conversation')!
    expect(conversation.sessionCount).toBe(2)
    expect(conversation.activities).toHaveLength(2)
    expect(conversation.status).toBe('running')
  })

  it('groups different connector services into one connector agent', () => {
    const agents = buildOfficeAgents(
      [], [], [job('gmail', 'gmail'), job('calendar', 'google_calendar')],
      new Map([['gmail', [run('gmail', 'running')]], ['calendar', [run('calendar', 'success')]]]),
    )
    const connector = agents.find((agent) => agent.id === 'core.connector')!
    expect(connector.activities).toHaveLength(2)
    expect(connector.sourceCount).toBe(2)
    expect(connector.status).toBe('running')
  })

  it('keeps registered agents visible when they have no activity', () => {
    const agents = buildOfficeAgents([], [], [], new Map())
    expect(agents).toHaveLength(6)
    expect(agents.every((agent) => agent.status === 'idle')).toBe(true)
  })
})
