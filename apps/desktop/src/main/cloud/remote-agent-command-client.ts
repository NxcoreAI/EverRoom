import type { AgentEvent } from '@nxcore/agent-contract'
import WebSocket from 'ws'

import type { AgentGatewayBridge } from '../gateway/agent-gateway-bridge'
import type { SaasClient } from './saas-client'

const RECONNECT_DELAY_MS = 2_000
const TERMINAL_EVENTS = new Set<AgentEvent['type']>([
  'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted',
])

interface RemoteCommand {
  commandId: string
  type: 'agent.run' | 'agent.cancel'
  idempotencyKey: string
  payload: Record<string, unknown>
  expiresAt: string
}

export class RemoteAgentCommandClient {
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = true
  private readonly runToCommand = new Map<string, string>()
  private readonly runQueues = new Map<string, RemoteCommand[]>()
  private readonly activeSessions = new Set<string>()
  private readonly seenCommands = new Set<string>()
  private readonly cancelledCommands = new Set<string>()
  private readonly completionWaiters = new Map<string, () => void>()
  private readonly commandToRun = new Map<string, string>()

  constructor(private readonly saas: SaasClient, private readonly bridge: AgentGatewayBridge) {
    this.bridge.setEventObserver((event) => this.onAgentEvent(event))
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return
    const credentials = await this.saas.agentStreamCredentials().catch(() => null)
    if (!credentials || this.stopped) return
    const socket = new WebSocket(credentials.url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } })
    this.socket = socket
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, deviceId: credentials.deviceId }))
    })
    socket.on('message', (data) => void this.handleMessage(data.toString()))
    socket.on('close', () => this.scheduleReconnect(socket))
    socket.on('error', () => undefined)
  }

  private scheduleReconnect(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, RECONNECT_DELAY_MS)
  }

  private async handleMessage(raw: string): Promise<void> {
    let frame: { type?: string; command?: RemoteCommand }
    try { frame = JSON.parse(raw) as typeof frame } catch { return }
    if (frame.type !== 'command' || !frame.command) return
    const command = frame.command
    if (Date.parse(command.expiresAt) <= Date.now()) {
      this.sendTransition(command.commandId, 'expired')
      return
    }
    try {
      if (command.type === 'agent.run') {
        if (this.seenCommands.has(command.commandId)) return
        this.seenCommands.add(command.commandId)
        const sessionKey = typeof command.payload.sessionId === 'string' && command.payload.sessionId
          ? command.payload.sessionId
          : `remote:${command.commandId}`
        const queue = this.runQueues.get(sessionKey) ?? []
        queue.push(command)
        this.runQueues.set(sessionKey, queue)
        void this.drainSession(sessionKey)
      } else {
        const targetCommandId = String(command.payload.commandId ?? '')
        const runId = typeof command.payload.runId === 'string' && command.payload.runId ? command.payload.runId : undefined
        const sessionId = typeof command.payload.sessionId === 'string' && command.payload.sessionId ? command.payload.sessionId : undefined
        if (targetCommandId) this.cancelledCommands.add(targetCommandId)
        const queued = sessionId ? this.runQueues.get(sessionId) : undefined
        const queuedIndex = queued?.findIndex((item) => item.commandId === targetCommandId) ?? -1
        if (queued && queuedIndex >= 0) {
          queued.splice(queuedIndex, 1)
          this.sendTransition(targetCommandId, 'cancelled')
          this.cancelledCommands.delete(targetCommandId)
        } else if (targetCommandId) {
          const knownRunId = runId ?? this.commandToRun.get(targetCommandId)
          if (knownRunId) await this.bridge.cancelRemoteRun(targetCommandId, knownRunId, sessionId)
        }
        this.sendTransition(command.commandId, 'cancelled', runId)
      }
    } catch (error) {
      this.sendTransition(command.commandId, 'failed', undefined, error instanceof Error ? error.message : String(error))
    }
  }

  private async drainSession(sessionKey: string): Promise<void> {
    if (this.activeSessions.has(sessionKey)) return
    this.activeSessions.add(sessionKey)
    try {
      const queue = this.runQueues.get(sessionKey)
      while (queue?.length) {
        const command = queue.shift()!
        try {
          await this.executeRun(command)
        } catch (error) {
          this.sendTransition(command.commandId, 'failed', undefined, error instanceof Error ? error.message : String(error))
        }
      }
      if (queue?.length === 0) this.runQueues.delete(sessionKey)
    } finally {
      this.activeSessions.delete(sessionKey)
    }
  }

  private async executeRun(command: RemoteCommand): Promise<void> {
    const sessionId = typeof command.payload.sessionId === 'string' ? command.payload.sessionId : undefined
    if (this.cancelledCommands.has(command.commandId)) {
      this.sendTransition(command.commandId, 'cancelled')
      this.cancelledCommands.delete(command.commandId)
      return
    }
    if (Date.parse(command.expiresAt) <= Date.now()) {
      this.sendTransition(command.commandId, 'expired')
      return
    }
    const run = await this.bridge.startRemoteRun({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      prompt: String(command.payload.prompt ?? ''),
      title: typeof command.payload.title === 'string' ? command.payload.title : undefined,
      sessionId,
    })
    this.runToCommand.set(run.id, command.commandId)
    this.commandToRun.set(command.commandId, run.id)
    if (this.cancelledCommands.has(command.commandId)) {
      await this.bridge.cancelRemoteRun(command.commandId, run.id, sessionId).catch(() => undefined)
      this.sendTransition(command.commandId, 'cancelled', run.id)
      this.runToCommand.delete(run.id)
      this.commandToRun.delete(command.commandId)
      this.cancelledCommands.delete(command.commandId)
      return
    }
    this.sendTransition(command.commandId, 'accepted', run.id)
    this.sendTransition(command.commandId, 'running', run.id)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      this.sendTransition(command.commandId, run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed', run.id, run.error ?? undefined)
      this.runToCommand.delete(run.id)
      this.commandToRun.delete(command.commandId)
      return
    }
    await new Promise<void>((resolve) => this.completionWaiters.set(run.id, resolve))
  }

  private onAgentEvent(event: AgentEvent): void {
    const commandId = this.runToCommand.get(event.runId)
    if (!commandId || !TERMINAL_EVENTS.has(event.type)) return
    const status = event.type === 'run.completed' ? 'completed' : event.type === 'run.cancelled' ? 'cancelled' : 'failed'
    this.sendTransition(commandId, status, event.runId, event.type === 'run.failed' ? String((event.payload as { message?: unknown })?.message ?? 'Agent failed') : undefined)
    this.runToCommand.delete(event.runId)
    this.commandToRun.delete(commandId)
    this.completionWaiters.get(event.runId)?.()
    this.completionWaiters.delete(event.runId)
  }

  private sendTransition(commandId: string, status: string, runId?: string, error?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'transition', commandId, status, ...(runId ? { runId } : {}), ...(error ? { error: error.slice(0, 500) } : {}) }))
  }
}
