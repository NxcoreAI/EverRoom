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

import type { RoomDocument, RoomOverviewProjection } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { ActivityPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ActivityPane'

/** 本月内锚定的相对时间：跨月漂移时钳到 1 号，保证条目始终落在当前月视图里；
 * 各条目小时错开，钳制同日后排序仍然确定。 */
function monthDay(daysBack: number, hour: number, minute = 0): string {
  const now = new Date()
  const day = Math.max(1, now.getDate() - daysBack)
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0).toISOString()
}

function claim(
  id: string,
  text: string,
  occurredAt: string | null,
  evidence: Array<{
    sourceKind: string
    sourceId: string
    sourceTitle?: string
  }>,
  eventType: 'source' | 'fact' | 'meeting' | 'task' | 'update' = 'source',
) {
  return {
    id,
    section: 'timeline',
    text,
    origin: 'fact',
    confidence: 1,
    evidence: evidence.map((source) => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceTitle: source.sourceTitle ?? null,
    })),
    corrected: false,
    occurredAt,
    data: { kind: 'timeline', eventType, title: text, description: null, certainty: 'fact' },
  }
}

function clusterProjectionFixture(): RoomOverviewProjection {
  return {
    roomId: 'room-timeline',
    revision: 1,
    generatedAt: '2026-08-26T08:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    nextSteps: [],
    entities: [],
    appliedCorrectionIds: [],
    // 同期批：02:00 会议 + 02:00 事实 + 02:08 任务（10 分钟窗口内）；
    // 两天前的文档事件与无日期事件各自独立成组。
    timeline: [
      claim('c-meeting', '发布评审', monthDay(2, 23, 0), [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' }], 'meeting'),
      claim('c-fact', '林薇负责 V1 视觉设计', monthDay(2, 23, 0), [{ sourceKind: 'mail', sourceId: 'mail-1', sourceTitle: '设计周报' }], 'fact'),
      claim('c-task', '补充天线参数', monthDay(2, 23, 8), [{ sourceKind: 'todo', sourceId: 'todo-1', sourceTitle: '补充天线参数' }], 'task'),
      claim('c-doc', '《评审纪要》已收录于 Room', monthDay(6, 15), [{ sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '评审纪要' }], 'update'),
      claim('c-undated', '明天对齐会', null, [], 'meeting'),
    ],
  }
}

function projectionFixture(): RoomOverviewProjection {
  return {
    roomId: 'room-timeline',
    revision: 1,
    generatedAt: '2026-08-26T08:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    nextSteps: [],
    entities: [],
    appliedCorrectionIds: [],
    // 顺序故意打乱 + 一条无日期事件 + 一条无证据事件：前端必须本地重排并把无日期沉底。
    // t-doc 是 update 事件且证据命中 doc-1/同日：与真实文档条目去重后由文档条目承载。
    timeline: [
      claim('t-undated', '明天对齐会', null, [{ sourceKind: 'calendar-event', sourceId: 'cal-2', sourceTitle: '明天对齐会' }], 'meeting'),
      claim('t-doc', '《评审纪要》已收录于 Room', monthDay(6, 15), [
        { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '评审纪要' },
      ], 'update'),
      claim('t-doc-evidence', '《评审纪要》关联了新证据', monthDay(8, 10), [
        { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '评审纪要' },
        { sourceKind: 'file', sourceId: 'file-1', sourceTitle: '需求原文.md' },
        { sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' },
        { sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' },
      ], 'fact'),
      claim('t-cal', '发布评审', monthDay(2, 23, 0), [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' }], 'meeting'),
      claim('t-plain', '手工补充的背景事件', monthDay(9, 8), []),
    ],
  }
}

const backendDocuments: RoomDocument[] = [{
  id: 'doc-1',
  roomId: 'room-timeline',
  title: '评审纪要',
  contentJson: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  version: 2,
  status: 'active',
  activeTransactionId: null,
  createdAt: monthDay(6, 14),
  updatedAt: monthDay(6, 14),
}]

const knowledgeFiles = [{
  id: 'file-1',
  roomId: 'room-timeline',
  originalName: '需求原文.md',
  bytes: 1024,
  uploadedAt: monthDay(7, 12),
  status: 'ready',
}] as unknown as Parameters<typeof ActivityPane>[0]['knowledgeFiles']

function renderPane() {
  return TestRenderer.create(
    <ActivityPane
      room={createContextRoomFixture('room-timeline', '时间轴 Room')}
      backendDocuments={backendDocuments}
      knowledgeFiles={knowledgeFiles}
      onSelectResource={() => {}}
      onOpenObject={() => {}}
    />,
  )
}

async function renderWithProjection(
  fixture: RoomOverviewProjection = projectionFixture(),
  extras: { versionChangeSummary?: (documentId: string, version: number) => Promise<{ summary: string }> } = {},
) {
  const overview = vi.fn().mockResolvedValue(fixture)
  const versionChangeSummary = extras.versionChangeSummary
  // 保留 node 全局（setInterval 等），只补 nxcore 桥与事件监听
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: {
      contextRooms: { overview },
      documents: versionChangeSummary ? { versionChangeSummary } : undefined,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = renderPane()
  })
  return { renderer: renderer!, overview }
}

/** 按钮文案匹配：children 可能是字符串或 [icon, 文案] 混排。 */
function buttonWithText(node: TestRenderer.ReactTestInstance, text: string) {
  return node.findAllByType('button').find((button) => {
    const children = Array.isArray(button.props.children) ? button.props.children : [button.props.children]
    return children.some((child) => typeof child === 'string' && child.includes(text))
  })
}

describe('动态时间轴：排序与真实对象条目', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('本地按发生时间倒序重排，无日期事件沉底且仍可见', async () => {
    const { renderer } = await renderWithProjection()
    const items = renderer.root.findAllByType('li')
    expect(items.map((node) => node.findByType('b').children[0])).toEqual([
      '发布评审',
      '评审纪要',
      '需求原文.md',
      '《评审纪要》关联了新证据',
      '手工补充的背景事件',
      '明天对齐会',
    ])
    // 无日期事件不渲染 <time>，避免拿生成时间冒充事件时间
    expect(items[5].findAllByType('time')).toHaveLength(0)
    expect(items[4].findAllByType('time')).toHaveLength(1)
  })

  it('同对象同日的收录类 claim 让位给真实文档条目（带版本徽标与版本入口）', async () => {
    const { renderer } = await renderWithProjection()
    const docEntry = renderer.root.findAllByType('li')[1]
    // 「《评审纪要》已收录于 Room」被去重，文档条目带 V2 徽标
    const versionBadge = docEntry.findAll((node) =>
      typeof node.props?.className === 'string' && node.props.className.includes('context-room-activity-version'))
    expect(versionBadge).toHaveLength(1)
    expect(versionBadge[0].children.join('')).toBe('V2')
    expect(buttonWithText(docEntry, '变更摘要')).toBeTruthy()
    expect(buttonWithText(docEntry, '查看版本')).toBeTruthy()
  })

  it('「查看版本」打开文档并请求打开历史面板', async () => {
    const onSelectResource = vi.fn()
    const overview = vi.fn().mockResolvedValue(projectionFixture())
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', {
      ...globalThis,
      nxcore: { contextRooms: { overview } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent,
    })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <ActivityPane
          room={createContextRoomFixture('room-timeline', '时间轴 Room')}
          backendDocuments={backendDocuments}
          knowledgeFiles={knowledgeFiles}
          onSelectResource={onSelectResource}
          onOpenObject={() => {}}
        />,
      )
    })
    const docEntry = renderer!.root.findAllByType('li')[1]
    await act(async () => {
      buttonWithText(docEntry, '查看版本')!.props.onClick()
    })
    expect(onSelectResource).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ documentId?: string }>
    expect(event.type).toBe('everroom:document:open-history')
    expect(event.detail.documentId).toBe('doc-1')
    vi.unstubAllGlobals()
  })

  it('文档条目懒加载变更摘要（PRD 6.4：不能只显示"文件已更新"）', async () => {
    const versionChangeSummary = vi.fn().mockResolvedValue({ summary: '新增了天线参数章节' })
    const { renderer } = await renderWithProjection(projectionFixture(), { versionChangeSummary })
    const docEntry = renderer.root.findAllByType('li')[1]
    await act(async () => {
      buttonWithText(docEntry, '变更摘要')!.props.onClick()
    })
    expect(versionChangeSummary).toHaveBeenCalledWith('doc-1', 2)
    const summaryNode = renderer.root.findAll((node) =>
      typeof node.props?.className === 'string' && node.props.className.includes('context-room-activity-summary'))
    expect(summaryNode).toHaveLength(1)
    expect(summaryNode[0].children).toContain('新增了天线参数章节')
  })

  it('相关资料按证据去重展示：云文档/上传文件可跳转，连接器来源为标签', async () => {
    const { renderer } = await renderWithProjection()
    const evidenceEntry = renderer.root.findAllByType('li')[3]
    const toggle = evidenceEntry.findAllByType('button')
      .find((node) => 'aria-expanded' in node.props)
    expect(toggle).toBeTruthy()
    expect(toggle!.props['aria-expanded']).toBe(false)
    await act(async () => {
      toggle!.props.onClick()
    })
    const materials = renderer.root.findAll((node) =>
      typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('context-room-timeline-material'))
    // 4 条证据去重为 3（cal-1 重复一次），计数徽标同步
    expect(toggle!.props['aria-expanded']).toBe(true)
    expect(materials).toHaveLength(3)
    const labels = materials.map((node) => node.children[node.children.length - 1])
    expect(labels).toEqual(['评审纪要', '需求原文.md', '发布评审'])
    // 可跳转的是 button（云文档 + 上传文件），连接器来源是 span 标签
    expect(materials.filter((node) => node.type === 'button')).toHaveLength(2)
    expect(materials.filter((node) => node.type === 'span')).toHaveLength(1)
    const plain = materials.find((node) => node.type === 'span')!
    expect(plain.props.className).toContain('is-plain')
  })

  it('对象类型筛选：只保留所选类别的条目', async () => {
    const { renderer } = await renderWithProjection()
    const chipWithText = (text: string) => renderer.root.findAllByType('button')
      .filter((button) => button.props['aria-pressed'] !== undefined)
      .find((button) => {
        const children = Array.isArray(button.props.children) ? button.props.children : [button.props.children]
        return children.some((child) => typeof child === 'string' && child.includes(text))
      })
    expect(chipWithText('全部')).toBeTruthy()
    const meetingChip = chipWithText('会议')
    expect(meetingChip).toBeTruthy()
    await act(async () => {
      meetingChip!.props.onClick()
    })
    const items = renderer.root.findAllByType('li')
    expect(items.map((node) => node.findByType('b').children[0])).toEqual(['发布评审', '明天对齐会'])
  })
})

describe('动态时间轴：同期事件折叠', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('10 分钟内相邻条目折叠成一组，领头条目按类别优先级（会议 > 任务）', async () => {
    const { renderer } = await renderWithProjection(clusterProjectionFixture())
    const items = renderer.root.findAllByType('li')
    // 5 条投影事件（update 被 doc-1 同日去重）+ 文档/文件真实条目 → 4 组
    expect(items.map((node) => node.findByType('b').children[0])).toEqual([
      '发布评审',
      '评审纪要',
      '需求原文.md',
      '明天对齐会',
    ])
    // 折叠态没有 peer 行；领头条目是会议而非同刻的事实/更晚的任务
    expect(renderer.root.findAll((node) => node.props?.className === 'context-room-timeline-peer')).toHaveLength(0)
    const toggle = buttonWithText(items[0], '同期事件')
    expect(toggle).toBeTruthy()
    expect(toggle!.props['aria-expanded']).toBe(false)
    expect(buttonWithText(items[0], '同期事件')!.props.children).toContain('2 条同期事件')

    await act(async () => {
      toggle!.props.onClick()
    })
    expect(toggle!.props['aria-expanded']).toBe(true)
    const peers = renderer.root.findAll((node) => node.props?.className === 'context-room-timeline-peer')
    // peer 保持时间倒序：02:08 的任务在 02:00 的事实前
    expect(peers.map((node) => node.findByType('b').children[0])).toEqual([
      '补充天线参数',
      '林薇负责 V1 视觉设计',
    ])
  })
})
