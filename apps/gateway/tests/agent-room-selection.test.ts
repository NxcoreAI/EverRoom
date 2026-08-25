import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RuntimeCapabilities } from '@nxcore/agent-contract'
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from '@nxcore/agent-runtime'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  agentSessions,
  documents,
  pendingAgentIntents,
  roomDocumentLinks,
} from '../src/infrastructure/database/schema.js'
import { AgentEventBroker } from '../src/modules/agent/event-broker.js'
import { AgentService, type AgentCompletedMessageResolver } from '../src/modules/agent/service.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'

const temporaryDirectories: string[] = []

class RecordingRuntime implements AgentRuntime {
  readonly id = 'recording'
  readonly starts: StartRuntimeRunInput[] = []

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false }
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input)
    const events = new AsyncEventQueue<RuntimeEvent>()
    events.push({ type: 'run.completed', payload: {} })
    events.end()
    return { runId: input.runId, runtimeSessionRef: `runtime-${input.sessionId}`, events }
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error('not supported')
  }

  async sendInput(): Promise<void> {}
  async cancel(_runId: string): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class CompletingRuntime extends RecordingRuntime {
  override async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input)
    const events = new AsyncEventQueue<RuntimeEvent>()
    events.push({ type: 'message.completed', payload: { role: 'assistant', content: '文档已成功修改。' } })
    events.push({ type: 'run.completed', payload: {} })
    events.end()
    return { runId: input.runId, runtimeSessionRef: `runtime-${input.sessionId}`, events }
  }
}

class RoomListRuntime extends RecordingRuntime {
  constructor(private readonly candidateRoomIds?: string[]) {
    super()
  }

  override async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input)
    const events = new AsyncEventQueue<RuntimeEvent>()
    if (!input.roomId) {
      const candidateIds = this.candidateRoomIds ? new Set(this.candidateRoomIds) : null
      const rooms = candidateIds
        ? (input.availableRooms ?? []).filter((room) => candidateIds.has(room.id))
        : input.availableRooms ?? []
      const toolCallId = `room-list-${input.runId}`
      events.push({
        type: 'tool.started',
        payload: { toolCallId, name: 'context_room_list', args: { candidateRoomIds: this.candidateRoomIds } },
      })
      events.push({
        type: 'tool.completed',
        payload: {
          toolCallId,
          name: 'context_room_list',
          result: { details: { rooms, selectionRequired: true } },
        },
      })
    }
    events.push({ type: 'run.completed', payload: {} })
    events.end()
    return { runId: input.runId, runtimeSessionRef: `runtime-${input.sessionId}`, events }
  }
}

class HangingRuntime extends RecordingRuntime {
  readonly cancels: string[] = []
  private readonly queues = new Map<string, AsyncEventQueue<RuntimeEvent>>()

  override async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input)
    const events = new AsyncEventQueue<RuntimeEvent>()
    this.queues.set(input.runId, events)
    return { runId: input.runId, runtimeSessionRef: `runtime-${input.sessionId}`, events }
  }

  override async cancel(runId: string): Promise<void> {
    this.cancels.push(runId)
    this.queues.get(runId)?.end()
    this.queues.delete(runId)
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHarness(options: {
  runtime?: RecordingRuntime
  completedMessageResolver?: AgentCompletedMessageResolver
  disposeRuntime?: boolean
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-agent-room-selection-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const runtime = options.runtime ?? new RecordingRuntime()
  const rooms = new ContextRoomService(database.db)
  const service = new AgentService(
    database.db,
    runtime,
    new AgentEventBroker(),
    undefined,
    rooms,
    { validateActiveDocumentContext: (context) => context },
    options.completedMessageResolver,
    'direct',
    options.disposeRuntime ?? true,
  )
  return { ...database, rooms, runtime, service }
}

describe('Agent Room selection', () => {
  it('cancels active event streams before disposing a shared runtime', async () => {
    const runtime = new HangingRuntime()
    const { service, sqlite } = await createHarness({ runtime, disposeRuntime: false })
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })
    const run = await service.startRun(session.id, {
      prompt: 'keep running',
      idempotencyKey: 'dispose-active-stream',
    })

    await service.dispose()

    expect(runtime.cancels).toEqual([run.id])
    sqlite.close()
  })

  it('replaces a misleading completed message with the authoritative operation result', async () => {
    const runtime = new CompletingRuntime()
    const completedMessageResolver: AgentCompletedMessageResolver = {
      resolveCompletedMessage: () => ({
        content: '未能生成有效的修改建议，文档未发生变化。',
        reason: 'document-operation-cancelled',
        operationId: 'operation-cancelled',
        operationStatus: 'cancelled',
        itemCount: 0,
      }),
    }
    const { service, sqlite } = await createHarness({ runtime, completedMessageResolver })
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })
    const run = await service.startRun(session.id, {
      prompt: '修改当前文档',
      idempotencyKey: 'authoritative-completed-message',
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(service.getSnapshot(session.id)?.messages.at(-1)?.content)
      .toBe('未能生成有效的修改建议，文档未发生变化。')
    expect(service.listEvents(session.id, run.id, 0)
      .find((event) => event.type === 'message.completed')?.payload).toMatchObject({
      content: '未能生成有效的修改建议，文档未发生变化。',
    })
    sqlite.close()
  })

  it('normalizes legacy empty Room ids to the global session scope', async () => {
    const { service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: '首页', roomId: '' })

    expect(session.roomId).toBeNull()
    expect(service.listSessions('首页', null)).toEqual([
      expect.objectContaining({ id: session.id, roomId: null }),
    ])
    sqlite.close()
  })

  it('treats Room selection as per-run context instead of session binding', async () => {
    const { rooms, runtime, service, sqlite } = await createHarness()
    rooms.saveSnapshot({
      rooms: [
        {
          id: 'room-current',
          title: '当前 Room',
          kind: '项目',
          data: {
            id: 'room-current',
            title: '当前 Room',
            kind: '项目',
            brief: { background: '用户创建的背景', goal: '完成首个版本', status: '等待资料' },
            generatedContext: {
              overview: '该 Room 聚焦资料评审。',
              status: '资料已进入评审',
              nextSteps: ['确认评审意见'],
              entities: [],
              actionItems: [],
              meetings: [],
              sourceDocuments: [],
            },
          },
        },
        { id: 'room-other', title: '其他 Room', data: { id: 'room-other', title: '其他 Room' } },
      ],
      deletedRooms: [],
    })
    const session = service.createSession({ pageLabel: 'Context Room', roomId: 'room-current' })
    await service.startRun(session.id, {
      prompt: '创建文档',
      idempotencyKey: 'room-scoped-run',
      context: {
        rooms: [{ id: 'room-other', title: '其他 Room' }],
        selectedRoomId: 'room-other',
      },
    })

    expect(runtime.starts[0]).toMatchObject({
      roomId: 'room-other',
      roomSelectionRequired: false,
      availableRooms: [
        {
          id: 'room-current',
          title: '当前 Room',
          kind: '项目',
          background: '用户创建的背景',
          goal: '完成首个版本',
          status: '资料已进入评审',
          contextSummary: expect.objectContaining({ nextSteps: ['确认评审意见'] }),
        },
        { id: 'room-other', title: '其他 Room' },
      ],
    })
    expect(session.roomId).toBeNull()
    sqlite.close()
  })

  it('passes lightweight run controls to the runtime while preserving enabled defaults', async () => {
    const { rooms, runtime, service, sqlite } = await createHarness()
    rooms.saveSnapshot({
      rooms: [{ id: 'room-current', title: '当前 Room', data: { id: 'room-current', title: '当前 Room' } }],
      deletedRooms: [],
    })
    const session = service.createSession({ pageLabel: 'Context Room', roomId: 'room-current' })
    await service.startRun(session.id, {
      prompt: '补全文档当前句子',
      idempotencyKey: 'cursor-completion-run',
      captureMemory: false,
      recallMemory: false,
      toolsEnabled: false,
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    await service.startRun(session.id, {
      prompt: '普通聊天',
      idempotencyKey: 'default-agent-run',
    })

    expect(runtime.starts[0]).toMatchObject({
      captureMemory: false,
      recallMemory: false,
      toolsEnabled: false,
    })
    expect(runtime.starts[1]).toMatchObject({
      captureMemory: true,
      recallMemory: true,
      toolsEnabled: true,
    })
    sqlite.close()
  })

  it('uses the Agent candidate list in a global session and binds the user selection for one run', async () => {
    const runtime = new RoomListRuntime(['room-b'])
    const { rooms: roomRegistry, service, sqlite } = await createHarness({ runtime })
    const session = service.createSession({ pageLabel: '首页', roomId: null })
    const rooms = [
      { id: 'room-a', title: '产品规划', kind: '项目' },
      { id: 'room-b', title: '后端进阶', kind: '主题' },
    ]
    roomRegistry.saveSnapshot({
      rooms: rooms.map((room) => ({ ...room, data: room })),
      deletedRooms: [],
    })

    const listRun = await service.startRun(session.id, {
      prompt: '创建一份后端学习文档',
      idempotencyKey: 'global-list-run',
      context: { rooms },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    await service.startRun(session.id, {
      prompt: '选择后端进阶',
      idempotencyKey: 'global-selected-run',
      context: { rooms, selectedRoomId: 'room-b' },
    })

    expect(runtime.starts).toEqual([
      expect.objectContaining({
        roomId: null,
        availableRooms: rooms,
        roomSelectionRequired: true,
      }),
      expect.objectContaining({
        roomId: 'room-b',
        availableRooms: rooms,
        roomSelectionRequired: false,
      }),
    ])
    expect(service.getRun(listRun.id)?.status).toBe('completed')
    expect(service.listEvents(session.id, listRun.id, 0).map((event) => event.type)).toEqual([
      'run.accepted',
      'tool.started',
      'tool.completed',
      'run.completed',
    ])
    expect(service.listEvents(session.id, listRun.id, 0)[2]?.payload).toMatchObject({
      name: 'context_room_list',
      result: {
        details: {
          rooms: [{ id: 'room-b', title: '后端进阶', kind: '主题' }],
          selectionRequired: true,
          pendingIntent: expect.objectContaining({ allowedRoomIds: ['room-b'] }),
        },
      },
    })
    expect(service.getSnapshot(session.id)?.session.roomId).toBeNull()
    sqlite.close()
  })

  it('lets the Agent infer a Room for an English document creation request', async () => {
    const { rooms: roomRegistry, runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Home', roomId: null })
    const rooms = [{ id: 'room-a', title: 'Java backend', kind: 'Project' }]
    roomRegistry.saveSnapshot({
      rooms: rooms.map((room) => ({ ...room, data: room })),
      deletedRooms: [],
    })

    await service.startRun(session.id, {
      prompt: 'help me to draft a java back-end guide book doc in current room',
      idempotencyKey: 'english-global-list-run',
      context: { rooms },
    })

    expect(runtime.starts).toEqual([expect.objectContaining({
      originalPrompt: 'help me to draft a java back-end guide book doc in current room',
      roomId: null,
      availableRooms: rooms,
      roomSelectionRequired: true,
    })])
    sqlite.close()
  })

  it.each([
    '创建一个管理项目文档的 context room',
    'create a context room for managing project documents',
  ])('lets the Agent handle explicit Room creation: %s', async (prompt) => {
    const { db, runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    const run = await service.startRun(session.id, {
      prompt,
      idempotencyKey: `explicit-room-creation-${prompt}`,
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(runtime.starts).toEqual([
      expect.objectContaining({ prompt, roomId: null, roomSelectionRequired: true }),
    ])
    expect(service.listEvents(session.id, run.id, 0)
      .filter((event) => event.type === 'tool.completed')).toEqual([])
    expect(db.select().from(pendingAgentIntents).all()).toEqual([])
    sqlite.close()
  })

  it.each([
    '如何创建 Context Room？',
    '不要创建 Room，只告诉我有哪些用途。',
  ])('keeps non-actionable Room creation discussion in the Agent: %s', async (prompt) => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    await service.startRun(session.id, {
      prompt,
      idempotencyKey: `room-creation-discussion-${prompt}`,
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(runtime.starts).toEqual([expect.objectContaining({ prompt })])
    sqlite.close()
  })

  it.each([
    '在当前 Room 里创建一份项目文档',
    '创建一份项目文档并保存到 Context Room',
    'create a project document in the Context Room',
  ])('preserves document creation routing when Room is only the location: %s', async (prompt) => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    await service.startRun(session.id, {
      prompt,
      idempotencyKey: `document-in-room-${prompt}`,
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })

    expect(runtime.starts).toEqual([expect.objectContaining({
      originalPrompt: prompt,
      roomId: null,
      roomSelectionRequired: true,
    })])
    sqlite.close()
  })

  it('keeps document discussion in the Agent instead of opening the Room picker', async () => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    await service.startRun(session.id, {
      prompt: '如何创建一篇结构清晰的文档？',
      idempotencyKey: 'document-discussion-run',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(runtime.starts).toEqual([
      expect.objectContaining({
        prompt: '如何创建一篇结构清晰的文档？',
        roomId: null,
        roomSelectionRequired: true,
      }),
    ])
    sqlite.close()
  })

  it('asks for document confirmation when a global creation request has only a topic', async () => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    const run = await service.startRun(session.id, {
      prompt: '帮我创建一个C语言',
      idempotencyKey: 'ambiguous-document-run',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })

    expect(runtime.starts).toEqual([])
    expect(run.status).toBe('completed')
    expect(service.listEvents(session.id, run.id, 0)[3]?.payload).toMatchObject({
      name: 'context_room_document_intent',
      result: {
        clarificationRequired: true,
        originalPrompt: '帮我创建一个C语言',
        topic: 'C语言',
      },
    })
    sqlite.close()
  })

  it('keeps explicit non-document creation targets in the Agent', async () => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    await service.startRun(session.id, {
      prompt: '帮我创建一个C语言学习计划',
      idempotencyKey: 'explicit-plan-run',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(runtime.starts).toEqual([
      expect.objectContaining({ prompt: '帮我创建一个C语言学习计划' }),
    ])
    sqlite.close()
  })

  it('does not open the Room picker when document creation is explicitly declined', async () => {
    const { runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: 'Context Room', roomId: null })

    await service.startRun(session.id, {
      prompt: '不要创建文档，直接在聊天里回答。',
      idempotencyKey: 'declined-document-run',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    expect(runtime.starts).toEqual([
      expect.objectContaining({ prompt: '不要创建文档，直接在聊天里回答。' }),
    ])
    sqlite.close()
  })

  it('rejects an invalid or stale Room before starting the Agent run', async () => {
    const { rooms, runtime, service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: '首页', roomId: null })
    rooms.saveSnapshot({
      rooms: [{ id: 'room-current', title: '仍然存在', data: { id: 'room-current', title: '仍然存在' } }],
      deletedRooms: [{ id: 'room-deleted', title: '已经删除', data: { id: 'room-deleted', title: '已经删除' } }],
    })

    await expect(service.startRun(session.id, {
      prompt: '就选刚才那个 Room',
      idempotencyKey: 'stale-room-run',
      context: {
        rooms: [{ id: 'room-current', title: '仍然存在' }],
        selectedRoomId: 'room-deleted',
      },
    })).rejects.toThrow('agent_room_not_available')
    expect(runtime.starts).toEqual([])
    expect(service.getSnapshot(session.id)?.messages).toEqual([])
    sqlite.close()
  })

  it('persists the original document intent and resumes it once with a validated Room', async () => {
    const runtime = new RoomListRuntime(['room-b'])
    const { db, rooms: roomRegistry, service, sqlite } = await createHarness({ runtime })
    const rooms = [
      { id: 'room-a', title: '产品规划' },
      { id: 'room-b', title: '后端进阶' },
    ]
    roomRegistry.saveSnapshot({
      rooms: rooms.map((room) => ({ ...room, data: room })),
      deletedRooms: [],
    })
    const session = service.createSession({ pageLabel: '首页', roomId: null })
    const originalPrompt = '创建一份后端并发控制的学习文档'
    const sourceRun = await service.startRun(session.id, {
      prompt: originalPrompt,
      idempotencyKey: 'pending-source-run',
      context: { rooms },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))

    const [intent] = service.listPendingIntents(session.id)
    expect(intent).toMatchObject({
      sessionId: session.id,
      sourceRunId: sourceRun.id,
      originalPrompt,
      targetCapability: 'document.create',
      allowedRoomIds: ['room-b'],
      allowedDocumentIds: [],
      consumedAt: null,
    })
    expect(new Date(intent!.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(service.listEvents(session.id, sourceRun.id, 0)[2]?.payload).toMatchObject({
      result: { details: { pendingIntent: { id: intent!.id, originalPrompt } } },
    })

    await expect(service.submitPendingIntent(intent!.id, {
      roomId: 'room-outside',
      idempotencyKey: 'pending-invalid-room',
    })).rejects.toThrow('pending_agent_intent_resource_not_allowed')
    expect(service.getPendingIntent(intent!.id)?.consumedAt).toBeNull()

    const resumed = await service.submitPendingIntent(intent!.id, {
      roomId: 'room-b',
      idempotencyKey: 'pending-resumed-run',
    })
    expect(resumed.intent.consumedAt).not.toBeNull()
    expect(resumed.run.prompt).toBe(originalPrompt)
    expect(runtime.starts.at(-1)).toMatchObject({
      prompt: originalPrompt,
      roomId: 'room-b',
      availableRooms: rooms,
    })
    expect(service.getSnapshot(session.id)?.messages.filter((message) => message.role === 'user'))
      .toMatchObject([{ content: originalPrompt, runId: sourceRun.id }])
    expect(service.listPendingIntents(session.id)).toEqual([])
    await expect(service.submitPendingIntent(intent!.id, {
      roomId: 'room-b',
      idempotencyKey: 'pending-second-submit',
    })).rejects.toThrow('pending_agent_intent_consumed')
    expect(db.select().from(pendingAgentIntents).where(eq(pendingAgentIntents.id, intent!.id)).get()?.consumedAt)
      .not.toBeNull()
    sqlite.close()
  })

  it('keeps an intent available when the Agent session is busy and rejects expired intents', async () => {
    const runtime = new RoomListRuntime()
    const { db, rooms, service, sqlite } = await createHarness({ runtime })
    rooms.saveSnapshot({
      rooms: [{ id: 'room-a', title: '产品规划', data: {} }],
      deletedRooms: [],
    })
    const session = service.createSession({ pageLabel: '首页', roomId: null })
    const sourceRun = await service.startRun(session.id, {
      prompt: '创建一份产品规划文档',
      idempotencyKey: 'busy-intent-source',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    const intent = service.listPendingIntents(session.id)[0]!

    db.update(agentSessions).set({ status: 'running' }).where(eq(agentSessions.id, session.id)).run()
    await expect(service.submitPendingIntent(intent.id, {
      roomId: 'room-a',
      idempotencyKey: 'busy-intent-submit',
    })).rejects.toThrow('agent_session_busy')
    expect(service.getPendingIntent(intent.id)?.consumedAt).toBeNull()

    db.update(agentSessions).set({ status: 'idle' }).where(eq(agentSessions.id, session.id)).run()
    db.update(pendingAgentIntents).set({ expiresAt: new Date(0) })
      .where(eq(pendingAgentIntents.id, intent.id)).run()
    await expect(service.submitPendingIntent(intent.id, {
      roomId: 'room-a',
      idempotencyKey: 'expired-intent-submit',
    })).rejects.toThrow('pending_agent_intent_expired')
    expect(service.getRun(sourceRun.id)).not.toBeNull()
    expect(service.getPendingIntent(intent.id)?.consumedAt).toBeNull()
    sqlite.close()
  })

  it('restores a prepared document intent with the authoritative active document context', async () => {
    const { db, rooms, runtime, service, sqlite } = await createHarness()
    rooms.saveSnapshot({
      rooms: [{ id: 'room-a', title: '产品规划', data: {} }],
      deletedRooms: [],
    })
    const session = service.createSession({ pageLabel: '首页', roomId: null })
    const sourceRun = await service.startRun(session.id, {
      prompt: '创建一份产品规划文档',
      idempotencyKey: 'document-intent-source',
      context: { rooms: [{ id: 'room-a', title: '产品规划' }] },
    })
    db.insert(documents).values({
      id: 'document-a',
      title: '权威标题',
      contentJson: { type: 'doc', content: [] },
      contentSchemaVersion: 1,
      version: 4,
      status: 'active',
    }).run()
    db.insert(roomDocumentLinks).values({ roomId: 'room-a', documentId: 'document-a' }).run()
    expect(() => service.preparePendingIntent({
      sessionId: session.id,
      sourceRunId: sourceRun.id,
      targetCapability: 'document.edit',
      allowedRoomIds: ['room-a'],
    })).toThrow('pending_agent_intent_resource_required')
    const intent = service.preparePendingIntent({
      sessionId: session.id,
      sourceRunId: sourceRun.id,
      targetCapability: 'document.edit',
      allowedRoomIds: ['room-a'],
      allowedDocumentIds: ['document-a'],
    })

    await expect(service.submitPendingIntent(intent.id, {
      roomId: 'room-a',
      idempotencyKey: 'missing-document-submit',
    })).rejects.toThrow('pending_agent_intent_resource_required')
    const resumed = await service.submitPendingIntent(intent.id, {
      roomId: 'room-a',
      documentId: 'document-a',
      idempotencyKey: 'document-intent-submit',
    })

    expect(resumed.run.prompt).toBe(sourceRun.prompt)
    expect(runtime.starts.at(-1)?.activeDocument).toEqual({
      roomId: 'room-a',
      documentId: 'document-a',
      title: '权威标题',
      version: 4,
      defaultAnchor: 'end',
    })
    sqlite.close()
  })
})
