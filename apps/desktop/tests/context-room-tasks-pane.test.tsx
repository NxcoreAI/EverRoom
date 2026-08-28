import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import type { RoomOverviewProjection } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { TasksPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPanes'

function projectionFixture(): RoomOverviewProjection {
  return {
    roomId: 'room-connector',
    revision: 1,
    generatedAt: '2026-08-26T08:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    entities: [],
    appliedCorrectionIds: [],
    timeline: [],
    nextSteps: [
      {
        id: 'ns-task-connector',
        section: 'next_steps',
        text: '补充天线参数',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'todo', sourceId: 'todo-1', sourceTitle: '补充天线参数' }],
        corrected: false,
        data: {
          kind: 'next_step', itemType: 'task', actionId: 'todo-1', owner: null,
          dueAt: '2026-09-05T01:00:00.000Z', status: 'needsAction', priority: 'high',
        },
      },
      {
        // 与本地未完成任务同名：投影叠加按标题去重，不重复渲染
        id: 'ns-task-duplicate',
        section: 'next_steps',
        text: '本地验收任务',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'todo', sourceId: 'todo-2', sourceTitle: '本地验收任务' }],
        corrected: false,
        data: {
          kind: 'next_step', itemType: 'task', actionId: 'todo-2', owner: null,
          dueAt: null, status: 'needsAction', priority: null,
        },
      },
      {
        // 日程 claim 不进待办面板
        id: 'ns-schedule',
        section: 'next_steps',
        text: '发射协调会',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发射协调会' }],
        corrected: false,
        data: {
          kind: 'next_step', itemType: 'schedule', actionId: 'cal-1', owner: null,
          dueAt: '2026-09-01T02:00:00.000Z', status: 'scheduled', priority: null,
        },
      },
    ],
  }
}

async function renderTasksPane(
  projection: RoomOverviewProjection = projectionFixture(),
  withLocalTasks = true,
) {
  const overview = vi.fn().mockResolvedValue(projection)
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { overview } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  const room = createContextRoomFixture('room-connector', '连接器 Room')
  room.actionItems = withLocalTasks ? [
    { id: 'task-pending', title: '本地验收任务', status: '进行中', owner: '林薇', deadline: '2026-09-01 09:00', completed: false },
    { id: 'task-done', title: '已完成的本地任务', status: '已完成', owner: '林薇', deadline: '2026-08-01 09:00', completed: true },
  ] : []
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <TasksPane room={room} onSelect={() => {}} onToggle={() => {}} onUpdateRoom={() => {}} />,
    )
  })
  return { renderer: renderer!, overview }
}

/** 待办面板里的任务行（data-connector-source="todo" 的为投影叠加项）。 */
function taskRows(renderer: TestRenderer.ReactTestRenderer, connectorOnly?: string) {
  return renderer.root.findAll((node) =>
    typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('context-room-task-row')
    && (connectorOnly === undefined || node.props['data-connector-source'] === connectorOnly))
}

describe('待办面板：确定性待办投影合并', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未完成区叠加连接器 task claim，与本地任务同名去重，日程 claim 不混入', async () => {
    const { renderer } = await renderTasksPane()
    const connectorRows = taskRows(renderer, 'todo')
    expect(connectorRows.map((node) => node.findByType('b').children[0])).toEqual(['补充天线参数'])
    // 本地未完成任务仍以可勾选行渲染
    const allRows = taskRows(renderer)
    expect(allRows.map((node) => node.findByType('b').children[0])).toEqual(['本地验收任务', '补充天线参数'])
    // 未完成计数 = 本地 1 + 投影 1
    const incompleteHeader = renderer.root.findAll((node) => node.type === 'h3')[0]
    expect(incompleteHeader.findByType('span').children[0]).toBe('2')
  })

  it('连接器待办为只读行：无勾选按钮、无跳转按钮', async () => {
    const { renderer } = await renderTasksPane()
    const row = taskRows(renderer, 'todo')[0]
    expect(row.findAllByType('button')).toHaveLength(0)
    expect(row.findAll((node) => node.props?.className === 'context-room-task-check')).toHaveLength(1)
  })

  it('本地与投影均为空时仍显示空态', async () => {
    const empty = { ...projectionFixture(), nextSteps: [] }
    const { renderer } = await renderTasksPane(empty, false)
    expect(taskRows(renderer)).toHaveLength(0)
    expect(renderer.root.findAll((node) =>
      typeof node.props?.title === 'string' && node.props.title === '还没有任务')).toHaveLength(1)
  })
})
