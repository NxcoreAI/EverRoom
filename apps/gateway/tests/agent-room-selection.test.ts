import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
import { AgentEventBroker } from '../src/modules/agent/event-broker.js'
import { AgentService } from '../src/modules/agent/service.js'
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
  async cancel(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-agent-room-selection-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const runtime = new RecordingRuntime()
  const rooms = new ContextRoomService(database.db)
  const service = new AgentService(database.db, runtime, new AgentEventBroker(), undefined, rooms)
  return { ...database, rooms, runtime, service }
}

describe('Agent Room selection', () => {
  it('normalizes legacy empty Room ids to the global session scope', async () => {
    const { service, sqlite } = await createHarness()
    const session = service.createSession({ pageLabel: '首页', roomId: '' })

    expect(session.roomId).toBeNull()
    expect(service.listSessions('首页', null)).toEqual([
      expect.objectContaining({ id: session.id, roomId: null }),
    ])
    sqlite.close()
  })

  it('keeps a Room-scoped session bound to its current Room', async () => {
    const { rooms, runtime, service, sqlite } = await createHarness()
    rooms.saveSnapshot({
      rooms: [{ id: 'room-current', title: '当前 Room', data: { id: 'room-current', title: '当前 Room' } }],
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
      roomId: 'room-current',
      roomSelectionRequired: false,
    })
    sqlite.close()
  })

  it('requires selection in a global session and binds a validated selection for one run', async () => {
    const { rooms: roomRegistry, runtime, service, sqlite } = await createHarness()
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
        roomId: 'room-b',
        availableRooms: rooms,
        roomSelectionRequired: false,
      }),
    ])
    expect(listRun.status).toBe('completed')
    expect(service.listEvents(session.id, listRun.id, 0).map((event) => event.type)).toEqual([
      'run.accepted',
      'tool.requested',
      'tool.started',
      'tool.completed',
      'run.completed',
    ])
    expect(service.listEvents(session.id, listRun.id, 0)[3]?.payload).toMatchObject({
      name: 'context_room_list',
      result: { rooms, selectionRequired: true },
    })
    expect(service.getSnapshot(session.id)?.session.roomId).toBeNull()
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
})
