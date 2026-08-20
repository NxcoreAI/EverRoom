import type { AgentEvent, AgentRun, AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'

import { SaasRequestError, type SaasClient } from './saas-client'

const HEARTBEAT_INTERVAL_MS = 15_000
const TERMINAL_EVENTS = new Set<AgentEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
])

interface ActiveRun {
  sessionId: string
  runId: string
  taskTitle: string
  activeSince: string
}

export interface AgentSessionStatusSnapshot extends AgentSession {
  messages: AgentSessionSnapshot['messages']
  activeRun: AgentSessionSnapshot['activeRun']
  lastEventSeq: number
}

export class AgentStatusReporter {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private timer: NodeJS.Timeout | null = null
  private lastError: ActiveRun | null = null
  private reportInFlight: Promise<void> | null = null
  private reportPending = false
  private endpointUnavailable = false
  private endpointRetryAt = 0
  private sessionsProvider: (() => Promise<AgentSessionStatusSnapshot[]>) | null = null

  constructor(private readonly client: SaasClient) {}

  setSessionsProvider(provider: (() => Promise<AgentSessionStatusSnapshot[]>) | null): void {
    this.sessionsProvider = provider
    void this.report()
  }

  start(): void {
    if (this.timer) return
    void this.report()
    this.timer = setInterval(() => void this.report(), HEARTBEAT_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  reset(): void {
    this.activeRuns.clear()
    this.lastError = null
    this.endpointUnavailable = false
    this.endpointRetryAt = 0
    void this.report()
  }

  trackRun(run: AgentRun): void {
    if (!['accepted', 'running'].includes(run.status)) return
    this.lastError = null
    this.activeRuns.set(run.id, {
      sessionId: run.sessionId,
      runId: run.id,
      taskTitle: run.prompt.trim().slice(0, 240),
      activeSince: run.startedAt ?? run.createdAt,
    })
    void this.report()
  }

  trackEvent(event: AgentEvent): void {
    if (!TERMINAL_EVENTS.has(event.type)) return
    const tracked = this.activeRuns.get(event.runId)
    if (!tracked && this.lastError?.runId === event.runId) return
    const finished = tracked ?? {
      sessionId: event.sessionId,
      runId: event.runId,
      taskTitle: '',
      activeSince: event.occurredAt,
    }
    this.activeRuns.delete(event.runId)
    this.lastError = event.type === 'run.failed' ? finished : null
    void this.report()
  }

  reportNow(): void {
    void this.report()
  }

  private report(): Promise<void> {
    if (this.endpointUnavailable && Date.now() < this.endpointRetryAt) return Promise.resolve()
    if (this.endpointUnavailable) this.endpointUnavailable = false
    if (this.reportInFlight) {
      this.reportPending = true
      return this.reportInFlight
    }
    const active = [...this.activeRuns.values()].at(-1)
    const current = active ?? this.lastError
    const report = async () => {
      let sessions: AgentSessionStatusSnapshot[] | undefined
      if (this.sessionsProvider) {
        try {
          sessions = (await this.sessionsProvider()).map((session) => ({
            ...session,
            messages: session.messages,
          }))
        } catch {
          // A local Gateway failure must not suppress the SaaS heartbeat.
        }
      }
      await this.client.reportAgentStatus({
      state: active ? 'running' : this.lastError ? 'error' : 'idle',
      ...(current?.sessionId ? { sessionId: current.sessionId } : {}),
      ...(current?.runId ? { runId: current.runId } : {}),
      ...(current?.taskTitle ? { taskTitle: current.taskTitle } : {}),
      ...(active?.activeSince ? { activeSince: active.activeSince } : {}),
      ...(sessions ? { sessions } : {}),
      })
    }
    this.reportInFlight = report().then(() => undefined).catch((error: unknown) => {
      // Old SaaS deployments may not expose this route yet. Retry periodically so
      // a desktop does not need to be restarted after a server rollout.
      if (error instanceof SaasRequestError && error.status === 404) {
        this.endpointUnavailable = true
        this.endpointRetryAt = Date.now() + 60_000
      }
    }).finally(() => {
      this.reportInFlight = null
      if (this.reportPending) {
        this.reportPending = false
        queueMicrotask(() => void this.report())
      }
    })
    return this.reportInFlight
  }
}
