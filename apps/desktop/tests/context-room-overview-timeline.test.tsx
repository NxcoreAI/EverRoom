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
import { OverviewDashboard } from '../src/renderer/src/components/context-room/ported/components/detail-panels/OverviewDashboard'

function claim(id: string, text: string, occurredAt: string | null, evidence: Array<{
  sourceKind: string
  sourceId: string
  sourceTitle?: string
}>) {
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
    data: { kind: 'timeline', eventType: 'source', title: text, description: null, certainty: 'fact' },
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
    // 顺序故意打乱 + 一条无日期事件 + 一条无证据事件：前端必须本地重排并把无日期沉底
    timeline: [
      claim('t-undated', '明天对齐会', null, [{ sourceKind: 'calendar-event', sourceId: 'cal-2', sourceTitle: '明天对齐会' }]),
      claim('t-doc', '《评审纪要》已收录于 Room', '2026-08-10T08:00:00.000Z', [
        { sourceKind: 'everroom-doc', sourceId: 'doc-1', sourceTitle: '评审纪要' },
        { sourceKind: 'file', sourceId: 'file-1', sourceTitle: '需求原文.md' },
        { sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' },
        { sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' },
      ]),
      claim('t-cal', '发布评审', '2026-08-20T02:00:00.000Z', [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: '发布评审' }]),
      claim('t-plain', '手工补充的背景事件', '2026-08-05T08:00:00.000Z', []),
    ],
  }
}

const backendDocuments: RoomDocument[] = [{
  id: 'doc-1',
  roomId: 'room-timeline',
  title: '评审纪要',
  contentJson: { type: 'doc', content: [] },
  contentSchemaVersion: 1,
  version: 1,
  status: 'active',
  activeTransactionId: null,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
}]

const knowledgeFiles = [{
  id: 'file-1',
  roomId: 'room-timeline',
  originalName: '需求原文.md',
  bytes: 1024,
  uploadedAt: '2026-08-09T08:00:00.000Z',
  status: 'ready',
}] as unknown as Parameters<typeof OverviewDashboard>[0]['knowledgeFiles']

function renderDashboard() {
  return TestRenderer.create(
    <OverviewDashboard
      room={createContextRoomFixture('room-timeline', '时间轴 Room')}
      backendDocuments={backendDocuments}
      knowledgeFiles={knowledgeFiles}
      onSelectResource={() => {}}
      onOpenObject={() => {}}
      onToggleTask={() => {}}
    />,
  )
}

async function renderWithProjection() {
  const overview = vi.fn().mockResolvedValue(projectionFixture())
  // 保留 node 全局（setInterval 等），只补 nxcore 桥与事件监听
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { overview } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = renderDashboard()
  })
  return { renderer: renderer!, overview }
}

describe('概览时间轴：排序与多来源资料', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('本地按发生时间倒序重排，无日期事件沉底且仍可见', async () => {
    const { renderer } = await renderWithProjection()
    const items = renderer.root.findAllByType('li')
    expect(items.map((node) => node.findByType('b').children[0])).toEqual([
      '发布评审',
      '《评审纪要》已收录于 Room',
      '手工补充的背景事件',
      '明天对齐会',
    ])
    // 无日期事件不渲染 <time>，避免拿生成时间冒充事件时间
    expect(items[3].findAllByType('time')).toHaveLength(0)
    expect(items[2].findAllByType('time')).toHaveLength(1)
  })

  it('相关资料按证据去重展示：云文档/上传文件可跳转，连接器来源为标签', async () => {
    const { renderer } = await renderWithProjection()
    const docEntry = renderer.root.findAllByType('li')[1]
    const toggle = docEntry.findAllByType('button')
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

  it('无证据的事件不显示「相关资料」入口', async () => {
    const { renderer } = await renderWithProjection()
    const plainEntry = renderer.root.findAllByType('li')[2]
    expect(plainEntry.findAllByType('button')
      .some((node) => 'aria-expanded' in node.props)).toBe(false)
  })
})
