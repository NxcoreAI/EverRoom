import type {
  AgentEvent,
  PendingAgentIntent,
  AgentRun,
  AgentStatusSnapshot,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentUsageRange,
  AgentUsageSnapshot,
  AgentSocketFrame,
  CreateAgentSessionInput,
  CreateAgentSessionLinkInput,
  StartAgentRunInput,
  SubmitPendingAgentIntentInput,
  UpdateAgentSessionInput,
} from '@nxcore/agent-contract'
import { isAgentSocketFrame } from '@nxcore/agent-contract'
import type { AxiosRequestConfig } from 'axios'
import { isAxiosError } from 'axios'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { WebContentsLifecycle } from './web-contents-lifecycle'

const AGENT_EVENT_CHANNEL = 'agent:event'
const http = createLoggedHttpClient('gateway-agent')
const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

function isRecoverableConnectionError(error: unknown): boolean {
  if (!isAxiosError(error)) return false
  if (error.code && RECOVERABLE_CONNECTION_ERROR_CODES.has(error.code)) return true
  return typeof error.message === 'string' && /socket hang up/i.test(error.message)
}

interface Subscription {
  sessionId: string
  socket: WebSocket
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

interface RunWatch {
  sessionId: string
  socket: WebSocket | null
  reconnectTimer: NodeJS.Timeout | null
  closed: boolean
}

export class AgentGatewayBridge {
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly contentsLifecycle = new WebContentsLifecycle()
  private readonly runWatches = new Map<string, RunWatch>()
  private eventObserver: ((event: AgentEvent) => void) | null = null

  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly activity?: {
      trackRun(run: AgentRun): void
      trackEvent(event: AgentEvent): void
    },
  ) {}

  setEventObserver(observer: ((event: AgentEvent) => void) | null): void {
    this.eventObserver = observer
  }

  startRemoteRun(input: { commandId: string; idempotencyKey: string; prompt: string; title?: string; sessionId?: string }): Promise<AgentRun> {
    if (input.sessionId) {
      return this.startRun(input.sessionId, {
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
        captureMemory: false,
        recallMemory: false,
        toolsEnabled: false,
      })
    }
    return this.request<AgentRun>('/v1/agent/remote/commands', { method: 'POST', data: input })
      .then((run) => { this.activity?.trackRun(run); this.watchRun(run); return run })
  }

  cancelRemoteRun(commandId: string, runId?: string, sessionId?: string): Promise<AgentRun> {
    return this.request<AgentRun>(`/v1/agent/remote/commands/${encodeURIComponent(commandId)}/cancel`, {
      method: 'POST',
      data: { ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}) },
    })
  }

  getStatus(): Promise<AgentStatusSnapshot> {
    return this.request('/v1/agent/status')
  }

  createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return this.request('/v1/agent/sessions', { method: 'POST', data: input })
  }

  createSessionLink(input: CreateAgentSessionLinkInput): Promise<AgentSessionLink> {
    return this.request('/v1/agent/session-links', { method: 'POST', data: input })
  }

  listSessionLinks(sessionId: string): Promise<AgentSessionLink[]> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/links`)
  }

  markSessionLinkReturned(linkId: string): Promise<AgentSessionLink> {
    return this.request(`/v1/agent/session-links/${encodeURIComponent(linkId)}/return`, { method: 'POST' })
  }

  listSessions(pageLabel?: string, roomId?: string | null): Promise<AgentSession[]> {
    const query = new URLSearchParams()
    if (pageLabel) query.set('pageLabel', pageLabel)
    if (roomId !== undefined) query.set('roomId', roomId ?? '')
    return this.request(`/v1/agent/sessions?${query}`)
  }

  listAllSessions(): Promise<AgentSession[]> {
    return this.listSessions()
  }

  async listAllSessionSnapshots(): Promise<AgentSessionSnapshot[]> {
    const sessions = await this.listSessions()
    const snapshots = await Promise.all(sessions.map(async (session) => {
      try {
        return await this.getSession(session.id)
      } catch {
        return null
      }
    }))
    return snapshots.filter((snapshot): snapshot is AgentSessionSnapshot => snapshot !== null)
  }

  updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      data: input,
    })
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  }

  getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`)
  }

  getUsage(range: AgentUsageRange = '7d'): Promise<AgentUsageSnapshot> {
    return this.request(`/v1/agent/usage?range=${encodeURIComponent(range)}`)
  }

  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]> {
    const query = new URLSearchParams({ runId, afterSeq: String(afterSeq) })
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/events?${query}`)
  }

  async startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun> {
    const run = await this.request<AgentRun>(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      data: input,
    })
    this.activity?.trackRun(run)
    this.watchRun(run)
    return run
  }

  async submitPendingIntent(
    intentId: string,
    input: SubmitPendingAgentIntentInput,
  ): Promise<{ intent: PendingAgentIntent; run: AgentRun }> {
    const result = await this.request<{ intent: PendingAgentIntent; run: AgentRun }>(`/v1/agent/pending-intents/${encodeURIComponent(intentId)}/submit`, {
      method: 'POST',
      data: input,
    })
    this.activity?.trackRun(result.run)
    this.watchRun(result.run)
    return result
  }

  async cancelRun(runId: string): Promise<AgentRun> {
    const run = await this.request<AgentRun>(`/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    const cancelledEvent: AgentEvent = {
      id: `local-cancel-${run.id}`,
      sessionId: run.sessionId,
      runId: run.id,
      seq: run.lastEventSeq,
      type: 'run.cancelled',
      occurredAt: run.completedAt ?? new Date().toISOString(),
      payload: {},
    }
    this.activity?.trackEvent(cancelledEvent)
    this.eventObserver?.(cancelledEvent)
    this.stopRunWatch(run.id)
    return run
  }

  summarizeTranscription(input: {
    jobId: string
    sourceRecordId: string
    transcript: string
    language?: string
  }): Promise<{ content: string }> {
    return this.request('/v1/processing/transcription-summary', {
      method: 'POST',
      data: input,
      timeout: 10 * 60_000,
    })
  }

  subscribe(contents: WebContents, sessionId: string): void {
    this.unsubscribe(contents.id)
    const subscription: Subscription = {
      sessionId,
      socket: this.openSocket(contents, sessionId),
      closed: false,
      reconnectTimer: null,
    }
    this.subscriptions.set(contents.id, subscription)
    this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id))
  }

  unsubscribe(contentsId: number): void {
    const subscription = this.subscriptions.get(contentsId)
    if (!subscription) return
    subscription.closed = true
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
    subscription.socket.close()
    this.subscriptions.delete(contentsId)
  }

  dispose(): void {
    for (const contentsId of [...this.subscriptions.keys()]) this.unsubscribe(contentsId)
    for (const runId of [...this.runWatches.keys()]) this.stopRunWatch(runId)
  }

  private watchRun(run: AgentRun): void {
    if (!this.activity || this.runWatches.has(run.id)) return
    const watch: RunWatch = {
      sessionId: run.sessionId,
      socket: null,
      reconnectTimer: null,
      closed: false,
    }
    this.runWatches.set(run.id, watch)
    watch.socket = this.openRunWatch(run.id, watch)
  }

  private openRunWatch(runId: string, watch: RunWatch): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(watch.sessionId)}/stream`
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (!isAgentSocketFrame(frame) || frame.type !== 'event' || frame.event.runId !== runId) return
        this.activity?.trackEvent(frame.event)
        this.eventObserver?.(frame.event)
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(frame.event.type)) {
          this.stopRunWatch(runId)
        }
      } catch {
        // Invalid frames are ignored; reconnect/replay keeps the status projection recoverable.
      }
    })
    socket.on('close', () => {
      if (watch.closed || !this.runWatches.has(runId)) return
      watch.reconnectTimer = setTimeout(() => {
        if (watch.closed || !this.runWatches.has(runId)) return
        watch.socket = this.openRunWatch(runId, watch)
      }, 750)
    })
    socket.on('error', () => undefined)
    return socket
  }

  private stopRunWatch(runId: string): void {
    const watch = this.runWatches.get(runId)
    if (!watch) return
    watch.closed = true
    if (watch.reconnectTimer) clearTimeout(watch.reconnectTimer)
    watch.socket?.close()
    this.runWatches.delete(runId)
  }

  private openSocket(contents: WebContents, sessionId: string): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/stream`
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      if (contents.isDestroyed()) return
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (isAgentSocketFrame(frame)) {
          contents.send(AGENT_EVENT_CHANNEL, frame)
          if (frame.type === 'event') {
            this.activity?.trackEvent(frame.event)
            this.eventObserver?.(frame.event)
          }
        }
      } catch {
        // Invalid runtime frames are ignored and will be recovered from history.
      }
    })
    socket.on('close', () => {
      const subscription = this.subscriptions.get(contents.id)
      if (!subscription || subscription.closed || contents.isDestroyed()) return
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id)
        if (!current || current.closed || contents.isDestroyed()) return
        current.socket = this.openSocket(contents, sessionId)
      }, 750)
    })
    socket.on('error', () => undefined)
    return socket
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path, config)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recoveredConnection = await this.supervisor.recoverConnection(connection)
      return this.requestWithConnection<T>(recoveredConnection, path, config)
    }
  }

  private async requestWithConnection<T>(
    connection: ReturnType<GatewaySupervisor['getConnection']>,
    path: string,
    config: AxiosRequestConfig,
  ): Promise<T> {
    const hasBody = config.data !== undefined && config.data !== null
    const response = await http.request<T & { message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': hasBody ? 'application/json' : false,
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === 'string'
          ? response.data.message
          : `Agent 请求失败（${response.status}）`,
      )
    }
    if (response.status === 204) return undefined as T
    return response.data
  }
}
