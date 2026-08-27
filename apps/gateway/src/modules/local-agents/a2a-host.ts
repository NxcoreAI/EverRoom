import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
  type Artifact,
  Role,
  type Task,
  TaskState,
} from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import type { StartRuntimeRunInput } from '@nxcore/agent-runtime'
import express from 'express'
import { CodexCliAgentRuntime } from './cli-runtime.js'

const DATA_MEDIA_TYPE = 'application/vnd.everroom.local-agent-delegation+json'

function textParts(parts: Artifact['parts']): string {
  return parts.flatMap((part) => part.content?.$case === 'text' ? [part.content.value] : []).join('')
}

function statusMessage(taskId: string, contextId: string, text: string) {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    parts: [{
      content: { $case: 'text' as const, value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    taskId,
    contextId,
    extensions: [],
    metadata: {},
    referenceTaskIds: [],
  }
}

function inputFromContext(context: RequestContext): StartRuntimeRunInput {
  const part = context.userMessage.parts.find((candidate) => (
    candidate.mediaType === DATA_MEDIA_TYPE && candidate.content?.$case === 'data'
  ))
  const value = part?.content?.$case === 'data' ? part.content.value : null
  if (!value || typeof value !== 'object') throw new Error('local_agent_a2a_input_missing')
  const input = value as Partial<StartRuntimeRunInput>
  if (typeof input.runId !== 'string' || typeof input.sessionId !== 'string'
    || typeof input.prompt !== 'string' || typeof input.pageLabel !== 'string') {
    throw new Error('local_agent_a2a_input_invalid')
  }
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    runtimeSessionRef: typeof input.runtimeSessionRef === 'string' && input.runtimeSessionRef
      ? input.runtimeSessionRef
      : null,
    prompt: input.prompt,
    pageLabel: input.pageLabel,
    roomId: typeof input.roomId === 'string' ? input.roomId : null,
    ...(input.originalPrompt ? { originalPrompt: input.originalPrompt } : {}),
    ...(input.responseLanguage ? { responseLanguage: input.responseLanguage } : {}),
    ...(input.delegationContext ? { delegationContext: input.delegationContext } : {}),
  }
}

class CodexA2AExecutor implements AgentExecutor {
  private readonly taskRuns = new Map<string, string>()

  constructor(private readonly runtime: CodexCliAgentRuntime) {}

  cancelTask = async (taskId: string): Promise<void> => {
    const runId = this.taskRuns.get(taskId)
    if (runId) await this.runtime.cancel(runId)
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const input = inputFromContext(requestContext)
    const task: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: { everroomRunId: input.runId },
    }
    eventBus.publish(AgentEvent.task(task))
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
      metadata: { everroomRunId: input.runId },
    }))

    this.taskRuns.set(taskId, input.runId)
    const artifactId = randomUUID()
    let pendingText = ''
    let artifactStarted = false
    const publishArtifact = (content: string, lastChunk: boolean) => {
      const artifact: Artifact = {
        artifactId,
        name: 'Agent response',
        description: 'Structured output from the local Agent adapter',
        parts: [{
          content: { $case: 'text', value: content },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: undefined,
        extensions: [],
      }
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact,
        append: artifactStarted,
        lastChunk,
        metadata: undefined,
      }))
      artifactStarted = true
    }

    try {
      const run = await this.runtime.start(input)
      for await (const event of run.events) {
        if (event.type === 'message.delta') {
          const delta = (event.payload as { delta?: unknown }).delta
          if (typeof delta !== 'string' || !delta) continue
          if (pendingText) publishArtifact(pendingText, false)
          pendingText = delta
          continue
        }
        if (event.type === 'runtime.session.updated') {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
            metadata: event.payload as Record<string, unknown>,
          }))
          continue
        }
        if (event.type === 'message.completed') {
          if (pendingText) {
            publishArtifact(pendingText, true)
            pendingText = ''
          } else {
            const content = (event.payload as { content?: unknown }).content
            if (typeof content === 'string' && content) publishArtifact(content, true)
          }
          continue
        }
        if (event.type === 'run.completed') {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined },
            metadata: event.payload as Record<string, unknown>,
          }))
          return
        }
        if (event.type === 'run.cancelled') {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
            metadata: undefined,
          }))
          return
        }
        if (event.type === 'run.failed') {
          const message = String((event.payload as { message?: unknown }).message ?? 'Local Agent failed')
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_FAILED,
              timestamp: new Date().toISOString(),
              message: statusMessage(taskId, contextId, message),
            },
            metadata: undefined,
          }))
          return
        }
      }
    } finally {
      this.taskRuns.delete(taskId)
    }
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose()
  }
}

export interface LocalA2AHostConnection {
  card: AgentCard
  token: string
}

export class LocalA2AHost {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly executor: CodexA2AExecutor
  private server: Server | null = null
  private connection: LocalA2AHostConnection | null = null
  private starting: Promise<LocalA2AHostConnection> | null = null

  constructor(executablePath: string, workingDirectory: string, installationId: string) {
    this.executor = new CodexA2AExecutor(
      new CodexCliAgentRuntime(executablePath, workingDirectory, installationId),
    )
  }

  async start(): Promise<LocalA2AHostConnection> {
    if (this.connection) return this.connection
    if (this.starting) return this.starting
    this.starting = this.startHost()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startHost(): Promise<LocalA2AHostConnection> {
    const card: AgentCard = {
      name: 'EverRoom Codex Local Agent Host',
      description: 'Authenticated loopback A2A adapter for a local Codex installation',
      supportedInterfaces: [{
        url: 'http://127.0.0.1',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      }],
      provider: { organization: 'EverRoom', url: '' },
      version: '1.0.0',
      documentationUrl: '',
      capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
      securitySchemes: {
        loopbackBearer: {
          scheme: {
            $case: 'httpAuthSecurityScheme',
            value: {
              description: 'Ephemeral EverRoom loopback credential',
              scheme: 'Bearer',
              bearerFormat: 'opaque',
            },
          },
        },
      },
      securityRequirements: [{ schemes: { loopbackBearer: { list: [] } } }],
      defaultInputModes: [DATA_MEDIA_TYPE],
      defaultOutputModes: ['text/plain'],
      skills: [{
        id: 'codex-workspace',
        name: 'Workspace task',
        description: 'Execute a delegated task in a read-only local workspace',
        tags: ['local', 'workspace'],
        examples: [],
        inputModes: [DATA_MEDIA_TYPE],
        outputModes: ['text/plain'],
        securityRequirements: [],
      }],
      signatures: [],
    }
    const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), this.executor)
    const app = express()
    app.use((request, response, next) => {
      if (request.header('authorization') !== `Bearer ${this.token}`) {
        response.status(401).json({ error: 'unauthorized' })
        return
      }
      next()
    })
    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }))
    app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))
    this.server = await new Promise<Server>((resolveServer, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolveServer(server))
      server.once('error', reject)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('local_agent_a2a_host_address_unavailable')
    card.supportedInterfaces[0]!.url = `http://127.0.0.1:${address.port}`
    this.connection = { card, token: this.token }
    return this.connection
  }

  async dispose(): Promise<void> {
    await this.executor.dispose()
    if (this.server) {
      this.server.closeAllConnections()
      await new Promise<void>((resolveClose, reject) => this.server!.close((error) => (
        error ? reject(error) : resolveClose()
      )))
    }
    this.server = null
    this.connection = null
  }
}

export { DATA_MEDIA_TYPE, textParts }
