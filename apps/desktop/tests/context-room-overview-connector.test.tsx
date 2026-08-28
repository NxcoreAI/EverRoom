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

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({ refreshFromBackend: vi.fn().mockResolvedValue(undefined) }),
}))

import type { RoomOverviewProjection } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { OverviewDashboard } from '../src/renderer/src/components/context-room/ported/components/detail-panels/OverviewDashboard'

/** 本地“今天”10:00 的 ISO 串（确定性 schedule claim 的当日判断）。 */
function todayAtLocal(hour: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).toISOString()
}

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
        id: 'ns-schedule-today',
        section: 'next_steps',
        text: '发射协调会',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发射协调会' }],
        corrected: false,
        data: {
          kind: 'next_step', itemType: 'schedule', actionId: 'cal-1', owner: null,
          dueAt: todayAtLocal(10), status: 'scheduled', priority: null,
        },
      },
      {
        id: 'ns-schedule-later',
        section: 'next_steps',
        text: '下月评审会',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-2', sourceTitle: '下月评审会' }],
        corrected: false,
        data: {
          kind: 'next_step', itemType: 'schedule', actionId: 'cal-2', owner: null,
          dueAt: '2026-12-01T02:00:00.000Z', status: 'scheduled', priority: null,
        },
      },
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
        // 与本地任务同名：投影叠加应按标题去重，不重复渲染
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
    ],
  }
}

async function renderWithProjection(
  room = createContextRoomFixture('room-connector', '连接器 Room'),
  projection: RoomOverviewProjection = projectionFixture(),
) {
  const overview = vi.fn().mockResolvedValue(projection)
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { overview } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <OverviewDashboard
        room={room}
        backendDocuments={[]}
        knowledgeFiles={[]}
        onSelectResource={() => {}}
        onOpenObject={() => {}}
        onToggleTask={() => {} }
      />,
    )
  })
  return { renderer: renderer!, overview }
}

/** 「今日日程」/「待办任务」面板内的条目文本（按 data-connector-source 过滤投影叠加项）。 */
function panelButtons(renderer: TestRenderer.ReactTestRenderer, connectorSource: string) {
  return renderer.root.findAll((node) =>
    typeof node.props?.['data-connector-source'] === 'string'
    && node.props['data-connector-source'] === connectorSource)
}

describe('概览面板：连接器日程/待办投影叠加', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('今日日程叠加当日确定性 schedule claim（非当日不进面板）', async () => {
    const room = createContextRoomFixture('room-connector', '连接器 Room')
    const { renderer } = await renderWithProjection(room)
    const schedules = panelButtons(renderer, 'calendar-event')
    expect(schedules.map((node) => node.findByType('b').children[0])).toEqual(['发射协调会'])
    expect(schedules[0].findByType('time').children[0]).toMatch(/^\d{1,2}:\d{2}$/)
  })

  it('待办任务叠加确定性 task claim，与本地任务同名的投影项去重', async () => {
    const room = createContextRoomFixture('room-connector', '连接器 Room')
    room.actionItems = [{
      id: 'task-local', title: '本地验收任务', status: '进行中', owner: '林薇',
      deadline: '2026-09-01 09:00', completed: false,
    }]
    const { renderer } = await renderWithProjection(room)
    const connectorTasks = panelButtons(renderer, 'todo')
    expect(connectorTasks.map((node) => node.findByType('b').children[0])).toEqual(['补充天线参数'])
    // 本地任务仍以可勾选行渲染，不因投影叠加消失
    const localTasks = renderer.root.findAll((node) =>
      typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-dashboard-task'))
    expect(localTasks).toHaveLength(1)
    expect(localTasks[0].findByType('b').children[0]).toBe('本地验收任务')
  })

  it('本地与投影均为空时仍显示空态', async () => {
    const empty = { ...projectionFixture(), nextSteps: [] }
    const { renderer } = await renderWithProjection(
      createContextRoomFixture('room-connector', '连接器 Room'), empty)
    const emptyStateTitles = renderer.root.findAll((node) =>
      typeof node.props?.title === 'string'
      && ['今天没有日程', '没有待办任务'].includes(node.props.title))
      .map((node) => node.props.title)
    expect(emptyStateTitles).toEqual(['今天没有日程', '没有待办任务'])
  })
})
