import { randomUUID } from 'node:crypto'
import {
  type Part,
  Role,
  TaskState,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client'
import type { RuntimeCapabilities } from '@nxcore/agent-contract'
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from '@nxcore/agent-runtime'
import { DATA_MEDIA_TYPE, LocalA2AHost } from './a2a-host.js'

interface ActiveA2ARun {
  client: Client
  taskId: string | null
  cancelRequested: boolean
  queue: AsyncEventQueue<RuntimeEvent>
}

function textOfParts(parts: Part[]): string {
  return parts.flatMap((part) => (
    part.content?.$case === 'text' && typeof part.content.value === 'string' ? [part.content.value] : []
  )).join('')
}

export class A2ALocalAgentRuntime implements AgentRuntime {
  readonly id: string
  private readonly active = new Map<string, ActiveA2ARun>()

  constructor(private readonly host: LocalA2AHost, installationId: string) {
    this.id = `a2a:local:codex:${installationId}`
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: true }
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.active.has(input.runId)) throw new Error('local_agent_run_already_active')
    const connection = await this.host.start()
    const fetchWithAuth: typeof fetch = (resource, options = {}) => {
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${connection.token}`)
      return fetch(resource, { ...options, headers })
    }
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithAuth })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchWithAuth }),
    })
    const client = await factory.createFromUrl(connection.card.supportedInterfaces[0]!.url)
    const queue = new AsyncEventQueue<RuntimeEvent>()
    const active: ActiveA2ARun = { client, taskId: null, cancelRequested: false, queue }
    this.active.set(input.runId, active)
    void this.consume(input, active, connection.token).catch((error) => {
      queue.push({ type: 'run.failed', payload: { message: error instanceof Error ? error.message : String(error) } })
      queue.end()
      this.active.delete(input.runId)
    })
    return { runId: input.runId, runtimeSessionRef: input.runtimeSessionRef ?? '', events: queue }
  }

  async resume(input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    return this.start(input)
  }

  async sendInput(): Promise<void> {
    throw new Error('local_agent_steering_not_supported')
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId)
    if (!active) return
    active.cancelRequested = true
    if (active.taskId) await active.client.cancelTask({ tenant: '', id: active.taskId, metadata: undefined }, {
      serviceParameters: { Authorization: `Bearer ${(await this.host.start()).token}` },
    })
  }

  async deleteSession(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const runId of this.active.keys()) await this.cancel(runId).catch(() => undefined)
    await this.host.dispose()
  }

  private async consume(input: StartRuntimeRunInput, active: ActiveA2ARun, token: string): Promise<void> {
    let messageStarted = false
    let finalText = ''
    let terminal = false
    const serializableInput = {
      runId: input.runId,
      sessionId: input.sessionId,
      runtimeSessionRef: input.runtimeSessionRef,
      originalPrompt: input.originalPrompt,
      responseLanguage: input.responseLanguage,
      prompt: input.prompt,
      pageLabel: input.pageLabel,
      roomId: input.roomId,
      delegationContext: input.delegationContext,
    }
    const stream = active.client.sendMessageStream({
      tenant: '',
      message: {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: 'data', value: serializableInput },
          metadata: undefined,
          filename: '',
          mediaType: DATA_MEDIA_TYPE,
        }],
        metadata: { everroomRunId: input.runId },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ['text/plain'],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
      },
      metadata: { everroomRunId: input.runId },
    }, { serviceParameters: { Authorization: `Bearer ${token}` } })

    for await (const response of stream) {
      const payload = response.payload
      if (!payload) continue
      if (payload.$case === 'task') {
        active.taskId = payload.value.id
        active.queue.push({
          type: 'run.started',
          payload: { agentId: this.id, transport: 'a2a-jsonrpc', taskId: payload.value.id },
        })
        if (active.cancelRequested) await this.cancel(input.runId)
        continue
      }
      if (payload.$case === 'artifactUpdate') {
        const artifact = payload.value.artifact
        const delta = artifact ? textOfParts(artifact.parts) : ''
        if (!delta) continue
        if (!messageStarted) {
          messageStarted = true
          active.queue.push({ type: 'message.started', payload: { role: 'assistant' } })
        }
        finalText += delta
        active.queue.push({ type: 'message.delta', payload: { delta } })
        continue
      }
      if (payload.$case === 'statusUpdate') {
        const status = payload.value.status
        if (!status) continue
        const runtimeSessionRef = payload.value.metadata?.runtimeSessionRef
        if (status.state === TaskState.TASK_STATE_WORKING && typeof runtimeSessionRef === 'string' && runtimeSessionRef) {
          active.queue.push({ type: 'runtime.session.updated', payload: { runtimeSessionRef } })
          continue
        }
        if (status.state === TaskState.TASK_STATE_COMPLETED) {
          if (finalText) active.queue.push({ type: 'message.completed', payload: { role: 'assistant', content: finalText } })
          active.queue.push({ type: 'run.completed', payload: payload.value.metadata ?? {} })
          terminal = true
        } else if (status.state === TaskState.TASK_STATE_CANCELED) {
          active.queue.push({ type: 'run.cancelled', payload: {} })
          terminal = true
        } else if (status.state === TaskState.TASK_STATE_FAILED || status.state === TaskState.TASK_STATE_REJECTED) {
          const message = status.message ? textOfParts(status.message.parts) : 'Local Agent failed'
          active.queue.push({ type: 'run.failed', payload: { message } })
          terminal = true
        }
      }
    }
    if (!terminal) active.queue.push({ type: 'run.failed', payload: { message: 'A2A stream ended without a terminal status' } })
    active.queue.end()
    this.active.delete(input.runId)
  }
}
