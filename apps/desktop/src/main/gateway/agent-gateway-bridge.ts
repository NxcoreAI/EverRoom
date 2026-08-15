import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSessionSnapshot,
  AgentSocketFrame,
  CreateAgentSessionInput,
  StartAgentRunInput,
  UpdateAgentSessionInput,
} from '@nxcore/agent-contract'
import { isAgentSocketFrame } from '@nxcore/agent-contract'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import type { GatewaySupervisor } from './gateway-supervisor'

const AGENT_EVENT_CHANNEL = 'agent:event'

interface Subscription {
  sessionId: string
  socket: WebSocket
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

export class AgentGatewayBridge {
  private readonly subscriptions = new Map<number, Subscription>()

  constructor(private readonly supervisor: GatewaySupervisor) {}

  createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return this.request('/v1/agent/sessions', { method: 'POST', body: JSON.stringify(input) })
  }

  listSessions(pageLabel: string, roomId?: string | null): Promise<AgentSession[]> {
    const query = new URLSearchParams({ pageLabel })
    if (roomId !== undefined) query.set('roomId', roomId ?? '')
    return this.request(`/v1/agent/sessions?${query}`)
  }

  updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  }

  getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`)
  }

  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]> {
    const query = new URLSearchParams({ runId, afterSeq: String(afterSeq) })
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/events?${query}`)
  }

  startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  cancelRun(runId: string): Promise<AgentRun> {
    return this.request(`/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
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
    contents.once('destroyed', () => this.unsubscribe(contents.id))
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
        if (isAgentSocketFrame(frame)) contents.send(AGENT_EVENT_CHANNEL, frame)
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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown } | null
      throw new Error(typeof body?.message === 'string' ? body.message : `Agent 请求失败（${response.status}）`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
