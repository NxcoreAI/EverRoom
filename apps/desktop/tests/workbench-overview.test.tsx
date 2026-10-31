// @vitest-environment happy-dom
/**
 * 工作空间「概览」页回归：
 *
 * 1) 派生数据（纯函数）：动态合并排序 / 8→20 折叠、洞察文本提取（消息与 run 事件两种来源）；
 * 2) 页面无数据空态：项目描述占位、目标空态、洞察无内容时整卡不渲染、动态空态；
 * 3) 页面真实数据：洞察来自 `agent.getSession` 的 assistant 消息，动态点击分别跳会话/气泡打开文件；
 * 4) 降级：洞察/文件库请求失败时静默降级，不影响剩余内容；
 * 5) 项目描述行内编辑（失焦或 ⌘Enter）写回 `updateWorkspaceMeta`。
 *
 * 与 tests/office-proto-recent-view.test.tsx 同款 happy-dom + createRoot 手写渲染（无 testing-library）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentSession, AgentSessionSnapshot, AgentWorkspace } from '@nxcore/agent-contract'

import type { RealOfficeFile } from '../src/renderer/src/office-proto/data'
import type { FileCatalogDto } from '../src/shared/ingest'
import type { WorkspacePageProps } from '../src/renderer/src/workbench/workspace/contracts'
import {
  ACTIVITY_COLLAPSED_LIMIT,
  ACTIVITY_EXPANDED_LIMIT,
  buildActivities,
  collapseActivities,
  extractInsightText,
  insightTextFromEvents,
} from '../src/renderer/src/workbench/workspace/activity'
import { OverviewPage } from '../src/renderer/src/workbench/workspace/OverviewPage'

// React 18 的 act() 需要显式声明测试环境。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ───────────────── fixtures ───────────────── */

function workspaceFixture(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
  return {
    id: 'ws-1',
    name: '连接器项目',
    description: null,
    goals: [],
    path: null,
    kind: 'custom',
    createdAt: '2026-10-30T01:00:00.000Z',
    updatedAt: '2026-10-30T01:00:00.000Z',
    lastOpenedAt: '2026-10-30T01:00:00.000Z',
    ...overrides,
  }
}

function sessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'runtime-1',
    title: '整理连接器需求',
    status: 'idle',
    createdAt: '2026-10-30T02:00:00.000Z',
    updatedAt: '2026-10-30T02:00:00.000Z',
    ...overrides,
  }
}

function catalogFixture(options: {
  id: string
  name: string
  sourceKind: FileCatalogDto['sourceKind']
  updatedAt: string
}): FileCatalogDto {
  return {
    id: options.id,
    originalName: options.name,
    displayName: null,
    sharedTitle: options.name,
    sourceKind: options.sourceKind,
    sourceLabel: '文件库',
    relativePath: null,
    provider: null,
    bytes: 1024,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: 'hash',
    currentVersionId: null,
    parsed: true,
    updatedAt: options.updatedAt,
  }
}

function realFileFixture(options: {
  id: string
  name: string
  sourceKind: FileCatalogDto['sourceKind']
  updatedAt: string
}): RealOfficeFile {
  const catalog = catalogFixture(options)
  return {
    catalog,
    file: {
      id: `real:${catalog.id}`,
      name: catalog.originalName,
      kind: 'docx',
      roomId: null,
      updatedLabel: '刚刚',
      sizeLabel: '1 KB',
      memoryCount: 0,
      content: { type: 'md', source: '' },
      realCatalog: catalog,
    },
  }
}

function snapshotFixture(
  session: AgentSession,
  messages: AgentSessionSnapshot['messages'],
  activeRun: AgentSessionSnapshot['activeRun'] = null,
): AgentSessionSnapshot {
  return { session, participants: [], activeRun, messages, lastEventSeq: 0 }
}

function eventFixture(
  type: AgentEvent['type'],
  payload: unknown,
  seq: number,
): AgentEvent {
  return {
    id: `event-${seq}`,
    sessionId: 's-1',
    runId: 'run-1',
    seq,
    type,
    occurredAt: '2026-10-30T02:00:00.000Z',
    payload,
  }
}

/* ───────────────── 纯函数：动态 ───────────────── */

describe('概览动态派生（buildActivities / collapseActivities）', () => {
  it('把会话与文件按时间倒序合并，并给出可点击目标与文案', () => {
    const activities = buildActivities({
      sessions: [
        sessionFixture({
          id: 's-run',
          title: '跑数据核对',
          status: 'running',
          createdAt: '2026-10-30T09:30:00.000Z',
          updatedAt: '2026-10-30T10:00:00.000Z',
        }),
        sessionFixture({
          id: 's-done',
          title: '周报整理',
          status: 'closed',
          createdAt: '2026-10-28T08:00:00.000Z',
          updatedAt: '2026-10-29T12:00:00.000Z',
        }),
        sessionFixture({
          id: 's-created',
          title: '新建分析',
          status: 'idle',
          createdAt: '2026-10-30T09:00:00.000Z',
          updatedAt: '2026-10-30T09:00:00.000Z',
        }),
        sessionFixture({
          id: 's-updated',
          title: '资料归档',
          status: 'idle',
          createdAt: '2026-10-26T09:00:00.000Z',
          updatedAt: '2026-10-28T09:00:00.000Z',
        }),
      ],
      files: [
        realFileFixture({
          id: 'f-gen',
          name: '季度汇报.docx',
          sourceKind: 'agent-generated',
          updatedAt: '2026-10-30T11:00:00.000Z',
        }),
        realFileFixture({
          id: 'f-manual',
          name: '需求材料.docx',
          sourceKind: 'manual-upload',
          updatedAt: '2026-10-27T11:00:00.000Z',
        }),
      ],
    })

    expect(activities.map((item) => item.id)).toEqual([
      'file:f-gen',
      'session:s-run',
      'session:s-created',
      'session:s-done',
      'session:s-updated',
      'file:f-manual',
    ])

    const labels = new Map(activities.map((item) => [item.id, item.label]))
    expect(labels.get('file:f-gen')).toBe('生成了《季度汇报.docx》')
    expect(labels.get('file:f-manual')).toBe('添加了材料《需求材料.docx》')
    expect(labels.get('session:s-run')).toBe('开始了工作《跑数据核对》')
    expect(labels.get('session:s-created')).toBe('新建了工作《新建分析》')
    expect(labels.get('session:s-done')).toBe('结束了工作《周报整理》')
    expect(labels.get('session:s-updated')).toBe('更新了工作《资料归档》')

    expect(activities[0]?.target).toEqual({ type: 'file', file: expect.objectContaining({ id: 'real:f-gen' }) })
    expect(activities[1]?.target).toEqual({ type: 'session', sessionId: 's-run' })
  })

  it('同时刻的工作排在文件前，时间无效的条目沉底', () => {
    const sameTime = '2026-10-30T10:00:00.000Z'
    const activities = buildActivities({
      sessions: [sessionFixture({ id: 's-1', status: 'running', createdAt: sameTime, updatedAt: sameTime })],
      files: [
        realFileFixture({ id: 'f-1', name: '材料.docx', sourceKind: 'manual-upload', updatedAt: sameTime }),
        realFileFixture({ id: 'f-bad', name: '坏时间.docx', sourceKind: 'manual-upload', updatedAt: 'not-a-date' }),
      ],
    })
    expect(activities.map((item) => item.id)).toEqual(['session:s-1', 'file:f-1', 'file:f-bad'])
  })

  it('默认折叠 8 条、展开到 20 条', () => {
    const sessions = Array.from({ length: 25 }, (_, index) => sessionFixture({
      id: `s-${String(index).padStart(2, '0')}`,
      title: `工作 ${index}`,
      status: 'closed',
      createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`,
      updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`,
    }))
    const activities = buildActivities({ sessions })
    expect(activities).toHaveLength(25)

    const collapsed = collapseActivities(activities, false)
    expect(collapsed.visible).toHaveLength(ACTIVITY_COLLAPSED_LIMIT)
    expect(collapsed.visible).toHaveLength(8)
    expect(collapsed.hiddenCount).toBe(17)

    const expanded = collapseActivities(activities, true)
    expect(expanded.visible).toHaveLength(ACTIVITY_EXPANDED_LIMIT)
    expect(expanded.visible).toHaveLength(20)
    expect(expanded.hiddenCount).toBe(5)

    expect(collapseActivities(activities.slice(0, 3), false)).toMatchObject({
      hiddenCount: 0,
      visible: expect.arrayContaining([]),
    })
    expect(collapseActivities(activities.slice(0, 3), false).visible).toHaveLength(3)
  })
})

/* ───────────────── 纯函数：洞察 ───────────────── */

describe('洞察文本提取（extractInsightText / insightTextFromEvents）', () => {
  it('取最后一条 assistant 正文，折成 2–4 行纯文本（去 markdown、跳过代码块）', () => {
    const text = extractInsightText([
      { role: 'user', content: '帮我整理一下连接器进展' },
      { role: 'assistant', content: '# 本周进展\n\n- 完成映射表 60%\n- 联调窗口定在 11/05\n\n```ts\nconst secret = 1\n```\n\n**下一步**：等设计确认。' },
    ])

    expect(text).toBeTruthy()
    const lines = text!.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(text).toContain('本周进展')
    expect(text).toContain('完成映射表 60%')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('#')
    expect(text).not.toContain('**')
  })

  it('超过 4 行的正文截断并加省略号', () => {
    const text = extractInsightText([
      { role: 'assistant', content: '一\n二\n三\n四\n五\n六' },
    ])
    expect(text).toBe('一\n二\n三\n四…')
  })

  it('没有 assistant 正文时返回 null', () => {
    expect(extractInsightText([])).toBeNull()
    expect(extractInsightText([{ role: 'user', content: '只说了话' }])).toBeNull()
    expect(extractInsightText([{ role: 'assistant', content: '   \n\n' }])).toBeNull()
  })

  it('消息快照为空时从 run 事件里折出 assistant 文本', () => {
    const deltas = insightTextFromEvents([
      eventFixture('message.started', { role: 'assistant' }, 1),
      eventFixture('message.delta', { delta: '结论：' }, 2),
      eventFixture('message.delta', { delta: '映射表已收口 60%。' }, 3),
      eventFixture('message.completed', { role: 'assistant', content: '' }, 4),
    ])
    expect(deltas).toBe('结论：映射表已收口 60%。')

    const completed = insightTextFromEvents([
      eventFixture('message.delta', { delta: '半截' }, 1),
      eventFixture('message.completed', { role: 'assistant', content: '## 最终结论\n\n下周补完联调。' }, 2),
    ])
    expect(completed).toBe('最终结论\n下周补完联调。')

    const userOnly = insightTextFromEvents([
      eventFixture('message.completed', { role: 'user', content: '用户的话' }, 1),
    ])
    expect(userOnly).toBeNull()
  })
})

/* ───────────────── 页面渲染 ───────────────── */

let container: HTMLDivElement
let root: Root

async function flush(rounds = 10, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function installNxcore(options: {
  files?: (limit?: number) => Promise<unknown>
  sessions?: Record<string, AgentSessionSnapshot>
  updateWorkspace?: (id: string, input: Record<string, unknown>) => Promise<unknown>
} = {}) {
  const updateWorkspace = vi.fn(options.updateWorkspace
    ?? ((id: string, input: Record<string, unknown>) => Promise.resolve({ ...workspaceFixture({ id }), ...input })))
  const nxcore = {
    agent: {
      getSession: vi.fn((sessionId: string) => {
        const snapshot = options.sessions?.[sessionId]
        return snapshot ? Promise.resolve(snapshot) : Promise.reject(new Error('session not found'))
      }),
      getEvents: vi.fn().mockResolvedValue([]),
    },
    files: {
      list: vi.fn(options.files ?? (() => Promise.resolve({ items: [], total: 0 }))),
    },
    workspace: {
      list: vi.fn().mockResolvedValue([]),
      update: updateWorkspace,
      remove: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      pickDirectory: vi.fn().mockResolvedValue(null),
    },
  }
  ;(window as unknown as { nxcore?: unknown }).nxcore = nxcore
  return { nxcore, updateWorkspace }
}

function pageProps(overrides: Partial<WorkspacePageProps> = {}): WorkspacePageProps {
  return {
    tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'overview' } },
    workspace: workspaceFixture(),
    sessions: [],
    onOpenSession: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenPage: vi.fn(),
    onNewWork: vi.fn(),
    onToast: vi.fn(),
    ...overrides,
  }
}

async function renderPage(props: WorkspacePageProps): Promise<void> {
  await act(async () => {
    root.render(<OverviewPage {...props} />)
  })
  await flush()
}

function textOf(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

async function click(element: Element | null): Promise<void> {
  expect(element, '待点击元素应存在').not.toBeNull()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await flush(4)
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setValue?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  vi.restoreAllMocks()
})

describe('概览页无数据空态', () => {
  it('空态只留标题与状态，说明性文案不再出现', async () => {
    // 无 preload 桥（浏览器预览/失败）时也不能崩。
    delete (window as unknown as { nxcore?: unknown }).nxcore
    await renderPage(pageProps())

    expect(container.textContent).toContain('连接器项目')
    expect(textOf('.wb-ov-head-top')).toContain('待开始')
    expect(textOf('.wb-ov-desc')).toBe('补充项目描述…')
    expect(textOf('.wb-ov-goals')).toContain('＋ 添加目标')
    expect(textOf('.wb-ov-meta')).toContain('开始')
    // 工作总数在侧栏分组头，概览 meta 行只留开始日期。
    expect(textOf('.wb-ov-meta')).not.toContain('项工作')

    // 洞察无内容时整卡不渲染，不留空态说明。
    expect(container.querySelector('.wb-ov-insight-badge')).toBeNull()
    expect(container.textContent).not.toContain('暂无洞察')
    expect(container.textContent).toContain('还没有动态')

    // 文件库不可用时只留一句事实。
    expect(container.textContent).toContain('文件库暂不可用')
    expect(container.textContent).not.toContain('暂时只显示工作动态')

    // 已删除的说明性/重复文案不得回流。
    expect(container.textContent).not.toContain('最多 12 条目标')
    expect(container.textContent).not.toContain('小 E')
    expect(container.textContent).not.toContain('正在整理最近工作')
    expect(container.textContent).not.toContain('正在读取最近动态')
    expect(container.textContent).not.toContain('工作与文件名可点击')
    expect(container.textContent).not.toContain('新建一项工作或添加材料')
  })
})

describe('概览页真实数据', () => {
  it('洞察取最近会话的 assistant 文本，动态合并文件库并支持点击跳转', async () => {
    const running = sessionFixture({
      id: 's-run',
      title: '跑数据核对',
      status: 'running',
      createdAt: '2026-10-30T09:30:00.000Z',
      updatedAt: '2026-10-30T12:00:00.000Z',
    })
    const { nxcore } = installNxcore({
      sessions: {
        's-run': snapshotFixture(running, [
          {
            id: 'm-1',
            sessionId: 's-run',
            runId: 'run-1',
            role: 'assistant',
            content: '## 结论\n\n映射表收口 60%，联调窗口 11/05。',
            createdAt: '2026-10-30T11:59:00.000Z',
          },
        ]),
      },
      files: () => Promise.resolve({
        items: [catalogFixture({
          id: 'f-gen',
          name: '季度汇报.docx',
          sourceKind: 'agent-generated',
          updatedAt: '2026-10-30T11:00:00.000Z',
        })],
        total: 1,
      }),
    })

    const props = pageProps({
      workspace: workspaceFixture({ description: '统一连接器排期。', goals: ['阶段一收口'] }),
      sessions: [running],
    })
    await renderPage(props)

    // 洞察
    expect(textOf('.wb-ov-insight-text')).toContain('映射表收口 60%')
    expect(textOf('.wb-ov-insight-badge')).toContain('洞察')
    expect(container.textContent).not.toContain('小 E')
    expect(nxcore.agent.getSession).toHaveBeenCalledWith('s-run')

    // 项目头：进行中数量只出现在页头 badge。
    expect(textOf('.wb-ov-head-top')).toContain('进行中 1')
    expect(textOf('.wb-ov-meta')).toContain('开始')
    expect(textOf('.wb-ov-meta')).not.toContain('项工作')
    expect(textOf('.wb-ov-meta')).not.toContain('项进行中')
    expect(textOf('.wb-ov-goals')).toContain('阶段一收口')

    // 动态：会话最新 → 排第一；文件生成为第二
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.wb-ov-activity'))
    expect(rows.length).toBe(2)
    expect(rows[0]!.textContent).toContain('开始了工作《跑数据核对》')
    expect(rows[1]!.textContent).toContain('生成了《季度汇报.docx》')

    await click(rows[0]!)
    expect(props.onOpenSession).toHaveBeenCalledWith('s-run')

    await click(container.querySelectorAll<HTMLElement>('.wb-ov-activity')[1] ?? null)
    expect(props.onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'real:f-gen' }))

    // 「全部工作」入口
    await click(container.querySelector('.wb-ov-card-action'))
    expect(props.onOpenPage).toHaveBeenCalledWith('plan')
  })

  it('洞察/文件库请求失败时静默降级，不挡工作动态', async () => {
    installNxcore({
      files: () => Promise.reject(new Error('files down')),
    })
    const closed = sessionFixture({
      id: 's-done',
      title: '周报整理',
      status: 'closed',
      updatedAt: '2026-10-29T12:00:00.000Z',
    })
    // getSession 默认 reject（未登记的会话）。
    await renderPage(pageProps({ sessions: [closed] }))

    // 洞察无内容时整卡不渲染，不挡工作动态。
    expect(container.querySelector('.wb-ov-insight-badge')).toBeNull()
    expect(container.textContent).not.toContain('暂无洞察')
    expect(container.textContent).toContain('结束了工作《周报整理》')
    expect(container.textContent).toContain('文件库暂不可用')
    expect(container.textContent).not.toContain('暂时只显示工作动态')
  })
})

describe('概览页项目头编辑', () => {
  it('点击描述 → 输入 → ⌘Enter 写回 updateWorkspaceMeta', async () => {
    const { updateWorkspace } = installNxcore()
    await renderPage(pageProps())

    await click(container.querySelector('.wb-ov-desc'))
    const textarea = container.querySelector<HTMLTextAreaElement>('.wb-ov-desc-input')
    expect(textarea, '描述编辑框应出现').not.toBeNull()

    await typeInto(textarea!, '统一连接器排期，11/05 联调。')
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    })
    await flush()

    expect(updateWorkspace).toHaveBeenCalledWith('ws-1', { description: '统一连接器排期，11/05 联调。' })
    expect(container.querySelector('.wb-ov-desc-input')).toBeNull()
  })

  it('添加目标写回 goals 数组', async () => {
    const { updateWorkspace } = installNxcore()
    await renderPage(pageProps())

    await click(container.querySelector('.wb-ov-goal-add'))
    const input = container.querySelector<HTMLInputElement>('.wb-ov-goal-input')
    expect(input, '目标输入框应出现').not.toBeNull()

    await typeInto(input!, '阶段一收口')
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()

    expect(updateWorkspace).toHaveBeenCalledWith('ws-1', { goals: ['阶段一收口'] })
    expect(textOf('.wb-ov-goals')).toContain('阶段一收口')
  })
})
