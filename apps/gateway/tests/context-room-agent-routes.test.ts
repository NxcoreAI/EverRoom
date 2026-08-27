import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { SubagentInvocation } from '@nxcore/agent-contract'
import Fastify from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { contextRoomRoutes } from '../src/modules/context-rooms/routes.js'
import type { RoomAgentDispatcher } from '../src/modules/context-rooms/room-agent.js'
import { CONTEXT_ROOM_AGENT_ID } from '../src/modules/context-rooms/room-agent.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function completedInvocation(text: string): SubagentInvocation {
  const now = Date.now()
  return {
    id: `invocation-${Math.random().toString(36).slice(2, 8)}`,
    agentDefinitionId: CONTEXT_ROOM_AGENT_ID,
    agentRevisionId: 'revision-1',
    source: 'internal_workflow',
    parentSessionId: null,
    parentRunId: null,
    task: '再生成 Context Room 简报',
    input: null,
    status: 'completed',
    result: { text },
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(now - 5_000).toISOString(),
    startedAt: new Date(now - 4_000).toISOString(),
    completedAt: new Date(now - 3_000).toISOString(),
  }
}

function fakeDispatcher(overrides: Partial<RoomAgentDispatcher> = {}): RoomAgentDispatcher {
  return {
    dispatch: vi.fn(async () => completedInvocation('{}')),
    dispatchDetached: vi.fn(async () => 'invocation-detached'),
    ...overrides,
  }
}

async function harness(roomAgent?: RoomAgentDispatcher) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-room-routes-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const service = new ContextRoomService(database.db)
  if (roomAgent) service.setRoomAgentDispatcher(roomAgent)
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
  await app.register(contextRoomRoutes(service, undefined, roomAgent))
  return { app, service, ...database }
}

describe('context room agent routes', () => {
  it('dispatches selection rewrites and returns the invocation id immediately', async () => {
    const roomAgent = fakeDispatcher({ dispatchDetached: vi.fn(async () => 'invocation-rewrite-1') })
    const { app, sqlite } = await harness(roomAgent)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/selection-rewrite',
      payload: {
        roomId: 'room-1',
        documentName: '计划',
        selectedText: '原文',
        instruction: '  更简洁  ',
        contextBefore: '前文',
        contextAfter: '',
        blockType: 'paragraph',
        responseLanguage: 'zh-CN',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ invocationId: 'invocation-rewrite-1' })
    expect(roomAgent.dispatchDetached).toHaveBeenCalledWith({
      task: 'selection-rewrite',
      taskInput: {
        selectedText: '原文',
        instruction: '更简洁',
        contextBefore: '前文',
        blockType: 'paragraph',
        roomId: 'room-1',
        documentName: '计划',
        responseLanguage: 'zh-CN',
      },
    })
    await app.close()
    sqlite.close()
  })

  it('rejects invalid selection rewrite bodies and missing agents', async () => {
    const { app, sqlite } = await harness(fakeDispatcher())

    expect((await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/selection-rewrite',
      payload: { selectedText: '  ' },
    })).statusCode).toBe(400)
    expect((await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/selection-rewrite',
      payload: {},
    })).statusCode).toBe(400)
    await app.close()

    const noAgent = await harness()
    expect((await noAgent.app.inject({
      method: 'POST',
      url: '/v1/context-rooms/selection-rewrite',
      payload: { selectedText: '原文' },
    })).statusCode).toBe(503)
    await noAgent.app.close()
    noAgent.sqlite.close()
    sqlite.close()
  })

  it('refreshes a Room brief and maps service errors to status codes', async () => {
    const roomAgent = fakeDispatcher({
      dispatch: vi.fn(async () => completedInvocation(JSON.stringify({
        background: '新背景',
        goal: '新目标',
        status: '进行中',
        risks: [],
        decisions: [],
      }))),
    })
    const { app, service, sqlite } = await harness(roomAgent)
    const created = await service.createRoom({ title: 'Campus Life', description: '校园活动' })

    const refreshed = await app.inject({
      method: 'POST',
      url: `/v1/context-rooms/${encodeURIComponent(created.room.id)}/refresh-brief`,
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().data.brief).toMatchObject({ background: '新背景', goal: '新目标', status: '进行中' })

    expect((await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/room-missing/refresh-brief',
    })).statusCode).toBe(404)
    await app.close()

    const noAgent = await harness()
    const missing = await noAgent.service.createRoom({ title: 'Campus Life', description: '校园活动' })
    expect((await noAgent.app.inject({
      method: 'POST',
      url: `/v1/context-rooms/${encodeURIComponent(missing.room.id)}/refresh-brief`,
    })).statusCode).toBe(503)
    await noAgent.app.close()
    noAgent.sqlite.close()
    sqlite.close()
  })
})
