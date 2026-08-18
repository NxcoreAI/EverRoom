import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import type { RuntimeCapabilities } from '@nxcore/agent-contract'
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from '@nxcore/agent-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { AgentEventBroker } from '../src/modules/agent/event-broker.js'
import { AgentService } from '../src/modules/agent/service.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentMcpHost } from '../src/modules/documents/mcp-host.js'
import { documentMcpRoutes } from '../src/modules/documents/mcp-routes.js'
import { DocumentService } from '../src/modules/documents/service.js'

const temporaryDirectories: string[] = []

class HoldingRuntime implements AgentRuntime {
  readonly id = 'holding'
  readonly queues = new Map<string, AsyncEventQueue<RuntimeEvent>>()

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false }
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    const events = new AsyncEventQueue<RuntimeEvent>()
    this.queues.set(input.runId, events)
    return { runId: input.runId, runtimeSessionRef: `runtime-${input.sessionId}`, events }
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error('not supported')
  }

  async sendInput(): Promise<void> {}
  async cancel(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {
    for (const queue of this.queues.values()) queue.end()
    this.queues.clear()
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('trusted document MCP sessions', () => {
  it('binds HTTP MCP to a validated active Agent run and revokes the opaque session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-trusted-mcp-'))
    temporaryDirectories.push(dataDir)
    const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
    const rooms = new ContextRoomService(database.db)
    rooms.saveSnapshot({
      rooms: [
        { id: 'room-a', title: '产品规划', data: {} },
        { id: 'room-b', title: '其他 Room', data: {} },
      ],
      deletedRooms: [],
    })
    const runtime = new HoldingRuntime()
    const documents = new DocumentService(database.db, new DocumentEventBroker())
    const agent = new AgentService(
      database.db,
      runtime,
      new AgentEventBroker(),
      undefined,
      rooms,
      documents,
    )
    const session = agent.createSession({ pageLabel: 'Context Room', roomId: 'room-a' })
    const run = await agent.startRun(session.id, {
      prompt: '读取当前 Room 文档',
      idempotencyKey: 'trusted-mcp-run',
    })

    expect(() => agent.createTrustedMcpSession(session.id, run.id, 'room-b'))
      .toThrow('mcp_agent_context_mismatch')
    expect(() => agent.createTrustedMcpSession('missing-session', run.id, 'room-a'))
      .toThrow('mcp_agent_context_not_found')
    expect(() => agent.validateDocumentOperationContext({
      capabilityId: 'document.edit',
      agentSessionId: session.id,
      runId: run.id,
      roomId: 'room-b',
    })).toThrow('agent_operation_context_invalid')
    expect(() => agent.validateDocumentOperationContext({
      capabilityId: 'document.edit',
      agentSessionId: session.id,
      runId: run.id,
      roomId: 'room-a',
    })).not.toThrow()
    const trusted = agent.createTrustedMcpSession(session.id, run.id, 'room-a')
    expect(trusted).toEqual({ sessionId: expect.any(String), expiresAt: expect.any(String) })
    expect(trusted.sessionId).not.toContain(session.id)
    expect(trusted.sessionId).not.toContain(run.id)

    const host = new DocumentMcpHost(documents, rooms)
    const app = Fastify()
    await app.register(documentMcpRoutes(host))
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gateway-test', version: '1' },
      },
    }

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/mcp/documents/not-a-token?agentSessionId=forged&runId=forged&roomId=room-b',
      payload: initialize,
    })
    const initialized = await app.inject({
      method: 'POST',
      url: `/v1/mcp/documents/${trusted.sessionId}?agentSessionId=forged&runId=forged&roomId=room-b`,
      payload: initialize,
    })
    const get = await app.inject({
      method: 'GET',
      url: `/v1/mcp/documents/${trusted.sessionId}`,
    })
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/mcp/documents/${trusted.sessionId}`,
    })
    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/mcp/documents/${trusted.sessionId}`,
      payload: initialize,
    })

    expect(invalid.statusCode).toBe(404)
    expect(invalid.json()).toMatchObject({ error: { code: -32001 } })
    expect(initialized.statusCode).toBe(200)
    expect(initialized.json()).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(get.statusCode).toBe(405)
    expect(deleted.statusCode).toBe(204)
    expect(revoked.statusCode).toBe(404)

    const terminalSession = agent.createTrustedMcpSession(session.id, run.id, 'room-a')
    runtime.queues.get(run.id)?.push({ type: 'run.completed', payload: {} })
    runtime.queues.get(run.id)?.end()
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    const terminalRevoked = await app.inject({
      method: 'POST',
      url: `/v1/mcp/documents/${terminalSession.sessionId}`,
      payload: initialize,
    })
    expect(terminalRevoked.statusCode).toBe(404)
    expect(() => agent.createTrustedMcpSession(session.id, run.id, 'room-a'))
      .toThrow('mcp_agent_context_not_active')
    expect(() => agent.validateDocumentOperationContext({
      capabilityId: 'document.selection-rewrite',
      agentSessionId: session.id,
      runId: run.id,
      roomId: 'room-a',
    })).not.toThrow()
    expect(() => agent.validateDocumentOperationContext({
      capabilityId: 'document.edit',
      agentSessionId: session.id,
      runId: run.id,
      roomId: 'room-a',
    })).toThrow('agent_operation_context_invalid')

    await app.close()
    await host.close()
    await agent.dispose()
    database.sqlite.close()
  })
})
