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
import { SchedulePane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPanes'

/** 本地“今天”的 ISO 串（默认月视图 cursor=今天，投影日程要落在本月才可见）。 */
function todayAtLocal(hour: number): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).toISOString()
}

function localDateString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
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
    nextSteps: [],
    timeline: [
      {
        id: 'tl-cal-1',
        section: 'timeline',
        text: '学校开学',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '学校开学' }],
        corrected: false,
        occurredAt: todayAtLocal(9),
        data: { kind: 'timeline', eventType: 'meeting', title: '学校开学', description: null, certainty: 'fact' },
      },
      {
        // 待办/文档时间轴 claim 不进日程面板
        id: 'tl-todo-1',
        section: 'timeline',
        text: '补充天线参数',
        origin: 'fact',
        confidence: 1,
        evidence: [{ sourceKind: 'todo', sourceId: 'todo-1', sourceTitle: '补充天线参数' }],
        corrected: false,
        occurredAt: todayAtLocal(12),
        data: { kind: 'timeline', eventType: 'task', title: '补充天线参数', description: null, certainty: 'fact' },
      },
    ],
  }
}

async function renderSchedulePane(
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
      <SchedulePane
        room={room}
        onOpen={() => {}}
        onUpdateRoom={() => {}}
      />,
    )
  })
  return { renderer: renderer!, overview }
}

/** 日程条目按钮（popover 触发器，含 data-connector-source 的为投影叠加项）。 */
function scheduleItemButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) =>
    typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('context-room-schedule-item'))
}

describe('日程面板：确定性日历事件投影合并', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('本地会议为空时投影日历事件仍让面板出日程，且带连接器来源标记', async () => {
    const { renderer } = await renderSchedulePane()
    const items = scheduleItemButtons(renderer)
    expect(items.map((node) => node.findByType('b').children[0])).toEqual(['学校开学'])
    expect(items[0].props['data-connector-source']).toBe('calendar-event')
    // 待办时间轴 claim 不混入
    expect(items.some((node) => node.props['data-connector-source'] === 'todo')).toBe(false)
  })

  it('与投影日历事件同名同日的 LLM 会议快照去重（保留精确时间的投影版本）', async () => {
    const room = createContextRoomFixture('room-connector', '连接器 Room')
    room.materials = [{
      id: 'meeting-llm', type: '会议', title: '学校开学', time: `${localDateString()} 09:00`,
      summary: 'LLM 快照里的同一场开学日程', attendees: [], attachments: [],
    }]
    const { renderer } = await renderSchedulePane(room)
    const items = scheduleItemButtons(renderer)
    expect(items).toHaveLength(1)
    expect(items[0].props['data-connector-source']).toBe('calendar-event')
  })

  it('local-schedule 时间轴 claim 并入日程面板：带 local-schedule 来源标记与「助手日程」徽标', async () => {
    const base = projectionFixture()
    const projection: RoomOverviewProjection = {
      ...base,
      timeline: [
        ...base.timeline,
        {
          id: 'tl-local-1',
          section: 'timeline',
          text: '新生报到',
          origin: 'fact',
          confidence: 1,
          evidence: [{ sourceKind: 'local-schedule', sourceId: 'act-2', sourceTitle: '新生报到' }],
          corrected: false,
          occurredAt: todayAtLocal(15),
          data: { kind: 'timeline', eventType: 'meeting', title: '新生报到', description: null, certainty: 'fact' },
        },
      ],
    }
    const { renderer } = await renderSchedulePane(createContextRoomFixture('room-connector', '连接器 Room'), projection)
    const items = scheduleItemButtons(renderer)
    expect(items.map((node) => node.findByType('b').children[0])).toEqual(['学校开学', '新生报到'])
    expect(items[1].props['data-connector-source']).toBe('local-schedule')
    // 徽标文案走 memory.sourceKind.local-schedule
    expect(JSON.stringify(items[1].findByType('small').children)).toContain('助手日程')
  })

  it('投影不可用时回落本地快照（不渲染连接器条目）', async () => {
    const room = createContextRoomFixture('room-connector', '连接器 Room')
    room.materials = [{
      id: 'meeting-llm', type: '会议', title: '本地记录的会议', time: `${localDateString()} 14:00`,
      summary: '', attendees: [], attachments: [],
    }]
    const overview = vi.fn().mockRejectedValue(new Error('overview unavailable'))
    vi.stubGlobal('window', {
      ...globalThis,
      nxcore: { contextRooms: { overview } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <SchedulePane room={room} onOpen={() => {}} onUpdateRoom={() => {}} />,
      )
    })
    const items = scheduleItemButtons(renderer!)
    expect(items.map((node) => node.findByType('b').children[0])).toEqual(['本地记录的会议'])
    expect(items[0].props['data-connector-source']).toBeUndefined()
  })
})
