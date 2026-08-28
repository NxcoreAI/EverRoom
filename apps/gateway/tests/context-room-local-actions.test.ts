import { describe, expect, it, vi } from 'vitest'
import type { StartRuntimeRunInput } from '@nxcore/agent-runtime'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { roomLocalActions } from '../src/infrastructure/database/schema.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import { RoomOverviewService } from '../src/modules/context-rooms/overview-service.js'
import { createRoomOverviewAgentTools } from '../src/modules/context-rooms/overview-agent-tools.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-local-actions-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const rooms = new ContextRoomService(database.db)
  const overviews = new RoomOverviewService(database.db, rooms)
  rooms.saveSnapshot({
    rooms: [{ id: 'room-local', title: 'Local Room', data: { id: 'room-local', title: 'Local Room' } }],
    deletedRooms: [],
  })
  return { ...database, rooms, overviews }
}

function run(overrides: Partial<StartRuntimeRunInput> = {}): StartRuntimeRunInput {
  return {
    runId: 'run-local',
    sessionId: 'session-1',
    runtimeSessionRef: null,
    prompt: '记录待办',
    pageLabel: 'Room',
    roomId: 'room-local',
    ...overrides,
  }
}

function tools(service: Record<string, unknown>) {
  return Object.fromEntries(createRoomOverviewAgentTools(service as unknown as RoomOverviewService)
    .map((tool) => [tool.name, tool]))
}

describe('room local actions (service + projection)', () => {
  it('projects local tasks and schedules with local-* evidence into nextSteps and timeline', async () => {
    const { overviews } = await createHarness()

    const task = overviews.createLocalAction('room-local', {
      kind: 'task', title: '开学前买教材', dueAt: '2026-09-01T01:00:00.000Z', priority: '高',
    }, { createdBy: 'agent', runId: 'run-local' })
    const schedule = overviews.createLocalAction('room-local', {
      kind: 'schedule', title: '新生报到', startedAt: '2026-12-01T02:00:00.000Z',
      endAt: '2026-12-01T03:00:00.000Z', location: '大礼堂',
    }, { createdBy: 'agent' })

    expect(task.action).toMatchObject({
      roomId: 'room-local', kind: 'task', title: '开学前买教材',
      status: 'needsAction', dueAt: '2026-09-01T01:00:00.000Z', priority: '高',
      createdBy: 'agent', completedAt: null,
    })
    expect(task.duplicate).toBe(false)
    expect(schedule.action).toMatchObject({
      kind: 'schedule', startedAt: '2026-12-01T02:00:00.000Z', endAt: '2026-12-01T03:00:00.000Z', location: '大礼堂',
    })

    // projection 取最后一次 refresh（schedule 创建在其后，task.overview 里还没有日程）。
    const projection = overviews.refresh('room-local')
    const nextSteps = projection.nextSteps.filter((item) => item.data?.kind === 'next_step')
    const localTask = nextSteps.find((item) => item.text === '开学前买教材')
    const localSchedule = nextSteps.find((item) => item.text === '新生报到')
    expect(localTask).toMatchObject({
      origin: 'fact',
      evidence: [{ sourceKind: 'local-task', sourceId: task.action.id, sourceTitle: '开学前买教材' }],
      data: { itemType: 'task', actionId: task.action.id, dueAt: '2026-09-01T01:00:00.000Z', priority: 'high' },
    })
    expect(localSchedule).toMatchObject({
      evidence: [{ sourceKind: 'local-schedule', sourceId: schedule.action.id }],
      data: { itemType: 'schedule', actionId: schedule.action.id, dueAt: '2026-12-01T02:00:00.000Z', status: 'scheduled' },
    })
    // 时间轴同样携带 local-* 证据（occurredAt 取 dueAt/startedAt）。
    const timelineByTitle = new Map(projection.timeline.map((item) => [item.text, item]))
    expect(timelineByTitle.get('开学前买教材')).toMatchObject({
      occurredAt: '2026-09-01T01:00:00.000Z',
      evidence: [{ sourceKind: 'local-task', sourceId: task.action.id }],
      data: { kind: 'timeline', eventType: 'task' },
    })
    expect(timelineByTitle.get('新生报到')).toMatchObject({
      occurredAt: '2026-12-01T02:00:00.000Z',
      evidence: [{ sourceKind: 'local-schedule', sourceId: schedule.action.id }],
      data: { kind: 'timeline', eventType: 'meeting' },
    })
  })

  it('is idempotent per room + kind + uncompleted title', async () => {
    const { overviews } = await createHarness()

    const first = overviews.createLocalAction('room-local', { kind: 'task', title: '买教材' }, { createdBy: 'agent' })
    const again = overviews.createLocalAction('room-local', { kind: 'task', title: ' 买教材 ' }, { createdBy: 'agent' })
    // 不同 kind（日程）不视为重复；已完成的同名待办也不算重复（由 complete 用例覆盖）。
    const schedule = overviews.createLocalAction('room-local', { kind: 'schedule', title: '买教材', startedAt: '2026-12-01T02:00:00.000Z' }, { createdBy: 'agent' })

    expect(again.duplicate).toBe(true)
    expect(again.action.id).toBe(first.action.id)
    expect(schedule.duplicate).toBe(false)
  })

  it('completes tasks (removing the claim) and refuses schedules', async () => {
    const { overviews } = await createHarness()
    const task = overviews.createLocalAction('room-local', { kind: 'task', title: '买教材' }, { createdBy: 'agent' })
    const schedule = overviews.createLocalAction('room-local', { kind: 'schedule', title: '新生报到', startedAt: '2026-12-01T02:00:00.000Z' }, { createdBy: 'agent' })

    expect(() => overviews.completeLocalAction('room-local', schedule.action.id)).toThrow('local_action_not_task')
    expect(() => overviews.completeLocalAction('room-local', 'act-missing')).toThrow('local_action_not_found')

    const done = overviews.completeLocalAction('room-local', task.action.id)
    expect(done.action).toMatchObject({ completedAt: expect.any(String), status: 'completed' })
    expect(done.overview.nextSteps.filter((item) => item.text === '买教材')).toHaveLength(0)
    // 时间轴保留（occurredAt 换成完成时间）。
    expect(done.overview.timeline.filter((item) => item.text === '买教材')).toHaveLength(1)

    // 完成后同名可再建（幂等守卫只看未完成）。
    const recreated = overviews.createLocalAction('room-local', { kind: 'task', title: '买教材' }, { createdBy: 'agent' })
    expect(recreated.duplicate).toBe(false)

    const restored = overviews.completeLocalAction('room-local', recreated.action.id, false)
    expect(restored.action).toMatchObject({ completedAt: null, status: 'needsAction' })
    expect(restored.overview.nextSteps.filter((item) => item.text === '买教材')).toHaveLength(1)
  })

  it('soft-deletes local actions out of the projection and advances the freshness watermark', async () => {
    const { overviews, db } = await createHarness()
    const task = overviews.createLocalAction('room-local', { kind: 'task', title: '买教材' }, { createdBy: 'agent' })

    const removed = overviews.deleteLocalAction('room-local', task.action.id)
    expect(removed.action).toMatchObject({ title: '买教材' })
    expect(removed.overview.nextSteps.filter((item) => item.text === '买教材')).toHaveLength(0)
    expect(removed.overview.timeline.filter((item) => item.text === '买教材')).toHaveLength(0)
    expect(() => overviews.deleteLocalAction('room-local', task.action.id)).toThrow('local_action_not_found')

    // 水位：直接落库一行（绕过 create 的即时 refresh），get() 应自动增量重建并带出该行。
    const watermark = new Date(Date.now() + 60_000)
    db.insert(roomLocalActions).values({
      id: 'act-direct', roomId: 'room-local', kind: 'task', title: '直连落库待办',
      status: 'needsAction', createdBy: 'user', createdAt: watermark, updatedAt: watermark,
    }).run()
    const projection = overviews.get('room-local')
    expect(projection.nextSteps.filter((item) => item.text === '直连落库待办')).toHaveLength(1)
  })

  it('requires a parseable start for local schedules and a title', async () => {
    const { overviews } = await createHarness()
    expect(() => overviews.createLocalAction('room-local', { kind: 'task', title: '  ' })).toThrow('local_action_title_required')
    expect(() => overviews.createLocalAction('room-local', { kind: 'schedule', title: '无时间日程', startedAt: '下周吧' }))
      .toThrow('local_schedule_start_required')
  })
})

describe('room local action Agent tools', () => {
  it('creates tasks and schedules with agent attribution and returns the reprojected overview', async () => {
    const overview = { roomId: 'room-local', revision: 7 }
    const createLocalAction = vi.fn(() => ({
      action: { id: 'act-1', roomId: 'room-local', kind: 'task', title: '买教材' },
      overview,
      duplicate: false,
    }))
    const result = await tools({ createLocalAction }).context_room_task_create!.execute(run(), {
      title: '买教材', dueAt: '2026-09-01T01:00:00.000Z',
    })

    expect(createLocalAction).toHaveBeenCalledWith('room-local', {
      kind: 'task',
      title: '买教材',
      dueAt: '2026-09-01T01:00:00.000Z',
    }, { createdBy: 'agent', runId: 'run-local' })
    expect(result.details).toEqual({
      roomId: 'room-local',
      action: { id: 'act-1', roomId: 'room-local', kind: 'task', title: '买教材' },
      duplicate: false,
      overview,
    })

    const createSchedule = vi.fn(() => ({
      action: { id: 'act-2', kind: 'schedule', title: '新生报到', startedAt: '2026-12-01T02:00:00.000Z' },
      overview,
      duplicate: true,
    }))
    const scheduleResult = await tools({ createLocalAction: createSchedule }).context_room_schedule_create!.execute(run(), {
      title: '新生报到', startedAt: '2026-12-01T02:00:00.000Z', location: '大礼堂',
    })
    expect(createSchedule).toHaveBeenCalledWith('room-local', {
      kind: 'schedule',
      title: '新生报到',
      startedAt: '2026-12-01T02:00:00.000Z',
      location: '大礼堂',
    }, { createdBy: 'agent', runId: 'run-local' })
    expect(scheduleResult.content).toContain('未重复创建')
  })

  it('completes and deletes through the gated room tools', async () => {
    const overview = { roomId: 'room-local', revision: 8 }
    const completeLocalAction = vi.fn((_roomId: string, _actionId: string, completed = true) => ({
      action: {
        id: 'act-1', kind: 'task', title: '买教材',
        completedAt: completed ? '2026-08-28T00:00:00.000Z' : null,
      },
      overview,
    }))
    const deleteLocalAction = vi.fn(() => ({
      action: { id: 'act-2', kind: 'schedule', title: '新生报到' },
      overview,
    }))
    const map = tools({ completeLocalAction, deleteLocalAction })

    const done = await map.context_room_task_complete!.execute(run(), { taskId: 'act-1' })
    expect(completeLocalAction).toHaveBeenCalledWith('room-local', 'act-1', true)
    expect(done.details).toEqual({ roomId: 'room-local', action: expect.objectContaining({ id: 'act-1' }), overview })
    expect(done.content).toContain('标记完成')

    const undone = await map.context_room_task_complete!.execute(run(), { taskId: 'act-1', completed: false })
    expect(completeLocalAction).toHaveBeenLastCalledWith('room-local', 'act-1', false)
    expect(undone.content).toContain('恢复未完成')

    const removed = await map.context_room_action_delete!.execute(run(), { actionId: 'act-2' })
    expect(deleteLocalAction).toHaveBeenCalledWith('room-local', 'act-2')
    expect((removed.details as { overview: unknown }).overview).toEqual(overview)
  })
})
