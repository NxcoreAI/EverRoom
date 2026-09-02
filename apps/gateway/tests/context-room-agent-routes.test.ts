import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { SubagentInvocation } from '@nxcore/agent-contract'
import Fastify from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { contextRoomRoutes } from '../src/modules/context-rooms/routes.js'
import type { RoomAgentDispatcher, RoomAgentDispatchInput } from '../src/modules/context-rooms/room-agent.js'
import { CONTEXT_ROOM_AGENT_ID } from '../src/modules/context-rooms/room-agent.js'
import type { DocWriterDispatcher } from '../src/modules/subagents/doc-writer-dispatcher.js'
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

function fakeDocWriter(overrides: Partial<DocWriterDispatcher> = {}): DocWriterDispatcher {
  return {
    dispatchDetached: vi.fn(async () => 'invocation-detached'),
    ...overrides,
  }
}

async function harness(roomAgent?: RoomAgentDispatcher, docWriter?: DocWriterDispatcher) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-room-routes-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const service = new ContextRoomService(database.db)
  if (roomAgent) service.setRoomAgentDispatcher(roomAgent)
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
  await app.register(contextRoomRoutes(service, undefined, docWriter))
  return { app, service, ...database }
}

describe('context room agent routes', () => {
  it('dispatches selection rewrites to doc-writer (M2) and returns the invocation id immediately', async () => {
    const docWriter = fakeDocWriter({ dispatchDetached: vi.fn(async () => 'invocation-rewrite-1') })
    const { app, sqlite } = await harness(undefined, docWriter)

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
    expect(docWriter.dispatchDetached).toHaveBeenCalledWith({
      task: 'rewrite',
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
    const { app, sqlite } = await harness(undefined, fakeDocWriter())

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

  it('suggests merge names for two rooms and maps service errors to status codes', async () => {
    const dispatch = vi.fn(async (_input: RoomAgentDispatchInput) => completedInvocation(JSON.stringify({
      names: ['校园生活全景', '校园生活'],
    })))
    const roomAgent = fakeDispatcher({ dispatch })
    const { app, service, sqlite } = await harness(roomAgent)
    const a = await service.createRoom({ title: '校园生活', description: '校园活动' })
    const b = await service.createRoom({ title: '校园生活记录', description: '活动记录' })

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/merge-name-suggestions',
      payload: { sourceAId: a.room.id, sourceBId: b.room.id, responseLanguage: 'zh-CN' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ names: ['校园生活全景', '校园生活'] })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      task: 'merge-name',
      taskInput: expect.objectContaining({ responseLanguage: 'zh-CN' }),
    }))

    // 幂等键配对序归一：A/B 调换顺序的两次请求命中同一 invocation 键。
    // （createRoom 也会经同一 dispatcher 发 room-enrich，这里按任务过滤。）
    expect((await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/merge-name-suggestions',
      payload: { sourceAId: b.room.id, sourceBId: a.room.id },
    })).statusCode).toBe(200)
    const mergeNameCalls = dispatch.mock.calls.map(([input]) => input).filter((input) => input.task === 'merge-name')
    expect(mergeNameCalls).toHaveLength(2)
    const call = mergeNameCalls[0]!
    const { roomA, roomB } = call.taskInput as { roomA: { title: string }; roomB: { title: string } }
    expect(new Set([roomA.title, roomB.title])).toEqual(new Set(['校园生活', '校园生活记录']))
    expect(mergeNameCalls[1]!.idempotencyKey).toBe(call.idempotencyKey)

    expect((await app.inject({
      method: 'POST',
      url: '/v1/context-rooms/merge-name-suggestions',
      payload: { sourceAId: a.room.id, sourceBId: 'room-missing' },
    })).statusCode).toBe(404)
    await app.close()
    sqlite.close()

    const noAgent = await harness()
    const na = await noAgent.service.createRoom({ title: '校园生活', description: '校园活动' })
    const nb = await noAgent.service.createRoom({ title: '校园生活记录', description: '活动记录' })
    expect((await noAgent.app.inject({
      method: 'POST',
      url: '/v1/context-rooms/merge-name-suggestions',
      payload: { sourceAId: na.room.id, sourceBId: nb.room.id },
    })).statusCode).toBe(503)
    await noAgent.app.close()
    noAgent.sqlite.close()
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
