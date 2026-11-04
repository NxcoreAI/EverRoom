// @vitest-environment happy-dom
/**
 * 工作空间「概览」页回归：
 *
 * 1) 派生数据（纯函数）：动态合并排序 / 8→20 折叠、洞察文本提取（消息与 run 事件两种来源）；
 * 2) 页面无数据空态：项目描述占位、目标空态、无桥时洞察整卡不渲染、动态空态；
 * 3) 页面真实数据：洞察来自 `agent.getSession` 的 assistant 消息，来源行/落款/证据浮层齐备，动态点击分别跳会话/气泡打开文件；
 * 4) 降级：洞察失败时展示错误态、不注入 mock，文件库失败不影响剩余内容；
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
  ACTIVITY_TONE,
  buildActivities,
  collapseActivities,
  extractInsightDetail,
  extractInsightText,
  insightTextFromEvents,
} from '../src/renderer/src/workbench/workspace/activity'
import {
  INSIGHT_COPY,
  composeWorkspaceInsight,
  deriveWorkspaceInsight,
  formatInsightSourceLine,
  formatInsightUpdatedLabel,
  pickLatestSession,
  scopedSessions,
  validateInsightCopy,
  type WorkspaceInsightReader,
} from '../src/renderer/src/workbench/workspace/insight'
import {
  OverviewPage,
  __resetInsightTypewriterForTests,
  __setInsightTypewriterEnabledForTests,
} from '../src/renderer/src/workbench/workspace/OverviewPage'
import {
  __resetInsightStateForTests,
  __setInsightCooldownForTests,
  __setInsightDebounceForTests,
  __setInsightRetryDelaysForTests,
} from '../src/renderer/src/workbench/workspace/useWorkspaceInsight'

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

function messageFixture(role: 'user' | 'assistant', content: string, id = 'm-1'): AgentSessionSnapshot['messages'][number] {
  return {
    id,
    sessionId: 's-1',
    runId: 'run-1',
    role,
    content,
    createdAt: '2026-10-30T01:30:00.000Z',
  }
}

function runFixture(overrides: Partial<NonNullable<AgentSessionSnapshot['activeRun']>> = {}): NonNullable<AgentSessionSnapshot['activeRun']> {
  return {
    id: 'run-1',
    sessionId: 's-1',
    status: 'running',
    prompt: '整理连接器需求',
    lastEventSeq: 0,
    error: null,
    startedAt: '2026-10-30T01:00:00.000Z',
    completedAt: null,
    createdAt: '2026-10-30T01:00:00.000Z',
    ...overrides,
  }
}

function fakeReader(
  snapshots: Record<string, AgentSessionSnapshot>,
  events: AgentEvent[] = [],
): WorkspaceInsightReader & { getSession: ReturnType<typeof vi.fn> } {
  return {
    getSession: vi.fn((sessionId: string) => {
      const snapshot = snapshots[sessionId]
      return snapshot ? Promise.resolve(snapshot) : Promise.reject(new Error('session not found'))
    }),
    getEvents: vi.fn(() => Promise.resolve(events)),
  }
}

/* ───────────────── 纯函数：动态 ───────────────── */

describe('概览动态派生（buildActivities / collapseActivities）', () => {
  it('把会话与文件按时间倒序合并，事件类型、文案分段与引用 id 都对', () => {
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

    const byId = new Map(activities.map((item) => [item.id, item]))
    // 引用只存 id（不存名字）：工作/文件改名后历史行自动跟随。
    expect(byId.get('file:f-gen')?.kind).toBe('output')
    expect(byId.get('file:f-gen')?.segments).toEqual([{ text: '生成了 ' }, { fileId: 'f-gen' }])
    expect(byId.get('file:f-manual')?.kind).toBe('material')
    expect(byId.get('file:f-manual')?.segments).toEqual([{ text: '添加了材料 ' }, { fileId: 'f-manual' }])
    expect(byId.get('session:s-run')?.kind).toBe('work-run')
    expect(byId.get('session:s-run')?.segments).toEqual([{ text: '开始了工作 ' }, { workId: 's-run' }])
    expect(byId.get('session:s-done')?.kind).toBe('work-done')
    expect(byId.get('session:s-done')?.segments).toEqual([{ text: '结束了工作 ' }, { workId: 's-done' }])
    expect(byId.get('session:s-created')?.segments).toEqual([{ text: '新建了工作 ' }, { workId: 's-created' }])
    expect(byId.get('session:s-updated')?.segments).toEqual([{ text: '更新了工作 ' }, { workId: 's-updated' }])
    // kind 只管视觉分组：idle 会话的「新建 / 更新」共用 work-created，动词区分语义。
    expect(byId.get('session:s-created')?.kind).toBe('work-created')
    expect(byId.get('session:s-updated')?.kind).toBe('work-created')

    // 事件类型 → 视觉 tone（不写死 hex，页面据此取 token）。
    expect(ACTIVITY_TONE['work-run']).toBe('running')
    expect(ACTIVITY_TONE['work-done']).toBe('success')
    expect(ACTIVITY_TONE.output).toBe('success')
    expect(ACTIVITY_TONE.material).toBe('muted')
    expect(ACTIVITY_TONE['work-review']).toBe('warning')
  })

  it('产物导入也算产物（与产物页同一口径），其余 sourceKind 一律算材料', () => {
    const activities = buildActivities({
      files: [
        realFileFixture({ id: 'f-art', name: '导入产物.docx', sourceKind: 'artifact-imported', updatedAt: '2026-10-30T10:00:00.000Z' }),
        realFileFixture({ id: 'f-conn', name: '连接器文件.docx', sourceKind: 'connector', updatedAt: '2026-10-30T09:00:00.000Z' }),
      ],
    })
    expect(activities.map((item) => item.kind)).toEqual(['output', 'material'])
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
  /** 概览动态的网关派生接口；不传 = 无桥（走本地派生回落）。 */
  activities?: (workspaceId: string, query?: Record<string, unknown>) => Promise<unknown>
  office?: { onAgentFile: (listener: (event: { type: string; workspaceId?: string }) => void) => () => void }
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
    ...(options.office ? { office: options.office } : {}),
    workspace: {
      list: vi.fn().mockResolvedValue([]),
      ...(options.activities ? { activities: vi.fn(options.activities) } : {}),
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
  __resetInsightStateForTests()
  __setInsightRetryDelaysForTests([]) // 单测不等待 1s/3s 退避
  __setInsightDebounceForTests(0) // 单测不等待 800ms 去抖
  __setInsightTypewriterEnabledForTests(false) // 断言全文，不等 interval
  __resetInsightTypewriterForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  __resetInsightStateForTests()
  __setInsightRetryDelaysForTests(null)
  __setInsightDebounceForTests(null)
  __setInsightCooldownForTests(null)
  __setInsightTypewriterEnabledForTests(true)
  __resetInsightTypewriterForTests()
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
    expect(container.textContent).toContain('空间里发生的工作与文件变化会记录在这里')

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

    // 洞察：运行中的会话 → 聚合正文（在跑建议）+ 更新中角标 + 来源行 / 落款
    expect(textOf('.wb-ov-insight-text')).toContain('正在跑，完成后我会把结果汇总在这里')
    expect(container.querySelector('.wb-ov-insight-text .wb-sr-only')?.textContent)
      .toContain('正在跑，完成后我会把结果汇总在这里')
    expect(textOf('.wb-ov-insight-badge')).toContain('洞察')
    expect(container.textContent).toContain(INSIGHT_COPY.updating)
    expect(textOf('.wb-ov-insight-source-btn')).toContain('基于本空间 1 项工作')
    expect(textOf('.wb-ov-insight-source-btn')).toContain('与 1 个文件')
    expect(textOf('.wb-ov-insight-source-btn')).toContain('更新于')
    expect(textOf('.wb-ov-insight-footer')).toContain('小 E · 你的工作台助理')
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
    // 文案是分段渲染的：正文 + 引用按钮（引用不写书名号，名字来自实时解析）。
    expect(rows[0]!.textContent).toContain('开始了工作')
    expect(rows[0]!.querySelector('.wb-ov-activity-ref')?.textContent).toBe('跑数据核对')
    expect(rows[1]!.textContent).toContain('生成了')
    expect(rows[1]!.querySelector('.wb-ov-activity-ref')?.textContent).toBe('季度汇报.docx')

    // 文件库按本空间过滤（修掉跨空间泄漏），且只拉最近 20 条。
    expect(nxcore.files.list).toHaveBeenCalledWith(20, 0, { workspaceId: 'ws-1' })

    await click(rows[0]!.querySelector('.wb-ov-activity-ref'))
    expect(props.onOpenSession).toHaveBeenCalledWith('s-run')

    await click(rows[1]!.querySelector('.wb-ov-activity-ref'))
    expect(props.onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'real:f-gen' }))

    // 行本身不是按钮（引用才是）：一行多引用时按钮不能嵌套；图标按事件类型取 tone。
    expect(rows[0]!.tagName.toLowerCase()).toBe('div')
    expect(rows[0]!.querySelector('.wb-ov-activity-ref')?.tagName.toLowerCase()).toBe('button')
    expect(rows[0]!.querySelector('.wb-ov-activity-icon')?.className).toContain('is-running')
    expect(rows[1]!.querySelector('.wb-ov-activity-icon')?.className).toContain('is-success')
    // 时间是 <time>，带绝对时间 title（相对时间不会自己跳，悬停可看准点）。
    const time = rows[0]!.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe('2026-10-30T12:00:00.000Z')
    expect(time?.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    // 「全部工作」入口
    await click(container.querySelector('.wb-ov-card-action'))
    expect(props.onOpenPage).toHaveBeenCalledWith('plan')
  })

  it('洞察请求失败时展示错误态、可重试，且不挡工作动态', async () => {
    const { nxcore } = installNxcore({
      files: () => Promise.reject(new Error('files down')),
    })
    const closed = sessionFixture({
      id: 's-done',
      title: '周报整理',
      status: 'closed',
      updatedAt: '2026-10-29T12:00:00.000Z',
    })
    // getSession 默认 reject（未登记的会话）。
    const props = pageProps({ sessions: [closed] })
    await renderPage(props)

    // 无缓存失败 → 错误态（不注入 mock 文案），动态照常。
    expect(textOf('.wb-ov-insight-badge')).toContain('洞察')
    expect(container.textContent).toContain(INSIGHT_COPY.error)
    expect(container.textContent).not.toContain('暂无洞察')
    expect(container.textContent).toContain('结束了工作')
    expect(container.textContent).toContain('周报整理')
    expect(container.textContent).toContain('文件库暂不可用')
    expect(container.textContent).not.toContain('暂时只显示工作动态')

    // 错误态给重试入口：手动刷新会再次请求（冷却只拦自动重试）。
    const before = nxcore.agent.getSession.mock.calls.length
    await click(container.querySelector('.wb-ov-insight-error button'))
    expect(nxcore.agent.getSession.mock.calls.length).toBeGreaterThan(before)
    expect(props.onToast).not.toHaveBeenCalledWith(INSIGHT_COPY.refreshToast)
  })
})

describe('洞察纯逻辑（pickLatestSession / deriveWorkspaceInsight）', () => {
  it('compose：建议按状态触发——中断提示续跑、全收尾建议开新、信号不足引用正文一句', () => {
    const latest = sessionFixture({ id: 's-a', title: '周报整理', status: 'idle', updatedAt: '2026-10-30T11:00:00.000Z' })
    const interrupted = sessionFixture({ id: 's-b', title: '供应商比价', status: 'interrupted', updatedAt: '2026-10-29T10:00:00.000Z' })
    // 中断优先于「查看结果」。
    const withInterrupted = composeWorkspaceInsight({
      sessions: [latest, interrupted], latest, latestText: '周报已整理完成。', fileCount: 5,
    })
    expect(withInterrupted.summary).toContain('2 项工作')
    expect(withInterrupted.summary).toContain('1 项待续')
    expect(withInterrupted.summary).toContain('资料库 5 个文件')
    expect(withInterrupted.suggestions[0]).toContain('「供应商比价」被中断过')

    // 全部收尾 → 建议开新工作。
    const done1 = sessionFixture({ id: 's-c', title: 'A', status: 'closed' })
    const done2 = sessionFixture({ id: 's-d', title: 'B', status: 'closed' })
    const allDone = composeWorkspaceInsight({ sessions: [done1, done2], latest: done1, latestText: null })
    expect(allDone.suggestions[0]).toContain('都收尾了')

    // 单项无状态信号 → 引用正文第一句作「最近进展」。
    const closedSingle = sessionFixture({ id: 's-e', status: 'closed' })
    const single = composeWorkspaceInsight({ sessions: [closedSingle], latest: closedSingle, latestText: '第一句结论。第二句补充。' })
    expect(single.suggestions[0]).toContain('最近进展：第一句结论')

    // idle + 正文 → 查看结果。
    const idleSingle = composeWorkspaceInsight({ sessions: [latest], latest, latestText: '有新结果' })
    expect(idleSingle.suggestions[0]).toContain('有你没细看的结果')
  })

  it('compose 文案过 validateInsightCopy 硬规则（markdown/emoji/营销词/感叹号）', () => {
    const latest = sessionFixture({ id: 's-a', status: 'running' })
    const composed = composeWorkspaceInsight({ sessions: [latest], latest, latestText: null, fileCount: 3 })
    const hard = validateInsightCopy(composed.text).filter((issue) => !issue.startsWith('too-short'))
    expect(hard).toEqual([])
  })

  it('LLM 通道：成功时正文用 LLM 产物并标注模型；失败/为空回落确定性聚合', async () => {
    const latest = sessionFixture({ id: 's-a', title: '周报整理', status: 'idle', updatedAt: '2026-10-30T11:00:00.000Z' })
    const reader = {
      getSession: async () => ({
        session: latest,
        participants: [],
        activeRun: null,
        messages: [{ id: 'm-1', sessionId: 's-a', runId: null, role: 'assistant', content: '周报已按新口径整理完成。', createdAt: '2026-10-30T11:00:00.000Z' }],
        lastEventSeq: 0,
      }) as AgentSessionSnapshot,
    }

    // 成功：LLM summary + advice 成为正文，origin.model 记录模型名。
    const ok = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [latest], reader,
      llm: {
        get: async () => ({
          summary: '本周两项工作都已收尾，材料库新增三份参考。',
          advice: [{ text: '下周可从结论页直接开新工作。', sessionId: 's-a' }],
          model: 'glm-4.7', cached: false,
        }),
      },
      retryDelaysMs: [],
    })
    expect(ok.status).toBe('ready')
    expect(ok.text).toContain('本周两项工作都已收尾')
    expect(ok.text).toContain('下周可从结论页直接开新工作')
    expect(ok.origin?.model).toBe('glm-4.7')

    // 失败：回落确定性聚合（状态分布），model=null。
    const failed = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [latest], reader,
      llm: { get: async () => { throw new Error('gateway down') } },
      retryDelaysMs: [],
    })
    expect(failed.status).toBe('ready')
    expect(failed.text).toContain('1 项工作')
    expect(failed.origin?.model).toBeNull()

    // 空 summary：视为无产物，同样回落。
    const empty = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [latest], reader,
      llm: { get: async () => ({ summary: '', advice: [], model: 'glm-4.7', cached: false }) },
      retryDelaysMs: [],
    })
    expect(empty.status).toBe('ready')
    expect(empty.text).toContain('1 项工作')
    expect(empty.origin?.model).toBeNull()

    // 超长正文经 normalize 截断（≤240 字 + 省略号）。
    const long = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [latest], reader,
      llm: {
        get: async () => ({
          summary: '长总结。'.repeat(80),
          advice: [{ text: '建议。', sessionId: null }],
          model: 'glm-4.7', cached: false,
        }),
      },
      retryDelaysMs: [],
    })
    // normalize 口径：截断产物以「…」收尾（slice 240 + 省略号，上限 241）。
    const longText = long.text ?? ''
    expect(longText.endsWith('…')).toBe(true)
    expect(longText.length).toBeLessThanOrEqual(241)
  })

  it('按最近更新选会话，平手用创建时间与 id 稳定排序，并过滤其它空间', () => {
    const sessions = [
      sessionFixture({ id: 's-a', updatedAt: '2026-10-30T10:00:00.000Z' }),
      sessionFixture({ id: 's-b', updatedAt: '2026-10-30T11:00:00.000Z' }),
      sessionFixture({ id: 's-other', workspaceId: 'ws-2', updatedAt: '2026-10-30T12:00:00.000Z' }),
    ]
    const scoped = scopedSessions(sessions, 'ws-1')
    expect(scoped.map((session) => session.id)).toEqual(['s-a', 's-b'])
    expect(pickLatestSession(scoped)?.id).toBe('s-b')

    const sameTime = '2026-10-30T10:00:00.000Z'
    const tied = [
      sessionFixture({ id: 't-1', createdAt: sameTime, updatedAt: sameTime }),
      sessionFixture({ id: 't-2', createdAt: sameTime, updatedAt: sameTime }),
    ]
    expect(pickLatestSession(tied)?.id).toBe('t-2')
  })

  it('ready：取最后一条 assistant 正文并记录来源（会话/消息/run/抓取时间/统计）', async () => {
    const session = sessionFixture({ id: 's-1', status: 'idle', updatedAt: '2026-10-30T11:00:00.000Z' })
    const reader = fakeReader({
      's-1': snapshotFixture(session, [
        messageFixture('user', '帮我整理一下连接器进展', 'm-0'),
        messageFixture('assistant', '## 结论\n\n映射表收口 60%。', 'm-1'),
      ]),
    })

    const insight = await deriveWorkspaceInsight({
      workspaceId: 'ws-1',
      sessions: [session],
      fileCount: 2,
      reader,
      retryDelaysMs: [],
      now: () => Date.parse('2026-11-03T10:00:00.000Z'),
    })

    expect(insight).toMatchObject({
      workspaceId: 'ws-1',
      status: 'ready',
      // 正文 = 聚合总结（状态分布 + 建议），不再复述消息原文。
      text: expect.stringContaining('1 项工作：1 项有新结果。资料库 2 个文件。'),
      updatedAt: '2026-10-30T11:00:00.000Z',
      stats: { workCount: 1, fileCount: 2 },
      origin: {
        sessionId: 's-1',
        messageId: 'm-1',
        capturedAt: '2026-11-03T10:00:00.000Z',
        sourceUpdatedAt: '2026-10-30T11:00:00.000Z',
        model: null,
      },
    })
    expect(insight.text).not.toContain('映射表收口 60%')
    expect(insight.error).toBeNull()
  })

  it('运行中的会话返回 updating（正文可用 + 角标语义）', async () => {
    const session = sessionFixture({ id: 's-1', status: 'running' })
    const insight = await deriveWorkspaceInsight({
      workspaceId: 'ws-1',
      sessions: [session],
      reader: fakeReader({ 's-1': snapshotFixture(session, [messageFixture('assistant', '正在核对数据。')]) }),
      retryDelaysMs: [],
    })
    expect(insight.status).toBe('updating')
    // 在跑 → 建议行「正在跑」；不复述半截正文。
    expect(insight.text).toContain('正在跑，完成后我会把结果汇总在这里')
    expect(insight.text).not.toBe('正在核对数据。')
  })

  it('无 assistant 正文 → no-content（不报错、不造文案）', async () => {
    const session = sessionFixture({ id: 's-1' })
    const insight = await deriveWorkspaceInsight({
      workspaceId: 'ws-1',
      sessions: [session],
      reader: fakeReader({ 's-1': snapshotFixture(session, [messageFixture('user', '只说了话')]) }),
      retryDelaysMs: [],
    })
    expect(insight.status).toBe('no-content')
    // 聚合总结仍然成立：状态分布 + 建议，没有消息级证据。
    expect(insight.text).toContain('1 项工作')
    expect(insight.origin).toMatchObject({ sessionId: 's-1', messageId: null, runId: null })
  })

  it('快照无正文时用 run 事件兜底（message.completed 优先）', async () => {
    const session = sessionFixture({ id: 's-1' })
    const events = [
      eventFixture('message.delta', { delta: '半截' }, 1),
      eventFixture('message.completed', { role: 'assistant', content: '## 最终结论\n\n下周补完联调。' }, 2),
    ]
    const insight = await deriveWorkspaceInsight({
      workspaceId: 'ws-1',
      sessions: [session],
      reader: fakeReader({ 's-1': snapshotFixture(session, [], runFixture()) }, events),
      retryDelaysMs: [],
    })
    expect(insight.status).toBe('ready')
    // idle + 事件兜底正文 → 「查看结果」建议；正文是聚合总结而非事件原文。
    expect(insight.text).toContain('有你没细看的结果')
    expect(insight.text).not.toContain('下周补完联调')
    expect(insight.origin).toMatchObject({ messageId: null, runId: 'run-1' })
  })

  it('无桥 / 无工作 / 失败 / 超时分别落到 unavailable / empty / error', async () => {
    const session = sessionFixture({ id: 's-1' })
    expect(await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [session], reader: null, retryDelaysMs: [],
    })).toMatchObject({ status: 'unavailable', error: { code: 'bridge-unavailable' } })

    expect(await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [], reader: fakeReader({}), retryDelaysMs: [],
    })).toMatchObject({ status: 'empty', stats: { workCount: 0 } })

    const failing = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [session], reader: fakeReader({}), retryDelaysMs: [],
    })
    expect(failing.status).toBe('error')
    expect(failing.error?.code).toBe('session-fetch-failed')

    const hanging: WorkspaceInsightReader = { getSession: () => new Promise<AgentSessionSnapshot>(() => {}) }
    const timedOut = await deriveWorkspaceInsight({
      workspaceId: 'ws-1', sessions: [session], reader: hanging, retryDelaysMs: [], timeoutMs: 10,
    })
    expect(timedOut.status).toBe('error')
    expect(timedOut.error?.code).toBe('timeout')
  })

  it('瞬时失败会重试：第二次成功即返回 ready', async () => {
    const session = sessionFixture({ id: 's-1' })
    const snapshot = snapshotFixture(session, [messageFixture('assistant', '重试后拿到了正文。')])
    const getSession = vi.fn()
      .mockRejectedValueOnce(new Error('temporary down'))
      .mockResolvedValue(snapshot)
    const insight = await deriveWorkspaceInsight({
      workspaceId: 'ws-1',
      sessions: [session],
      reader: { getSession },
      retryDelaysMs: [0],
    })
    expect(insight.status).toBe('ready')
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('来源行/时效文案按真实计数拼接，缺文件数时省略分句', () => {
    expect(formatInsightSourceLine({ workCount: 5, fileCount: 12 }, '更新于 2 小时前'))
      .toBe('基于本空间 5 项工作与 12 个文件 · 更新于 2 小时前')
    expect(formatInsightSourceLine({ workCount: 3 }, ''))
      .toBe('基于本空间 3 项工作')
    expect(formatInsightUpdatedLabel('刚刚')).toBe('刚刚更新')
    expect(formatInsightUpdatedLabel('昨天')).toBe('更新于 昨天')
  })

  it('文案校验能挡下 markdown / emoji / 感叹号 / 营销词 / 绝对日期 / 多问句', () => {
    expect(validateInsightCopy(
      '这个空间里有 5 项工作：周报在等你审阅，比价卡在交期取舍。建议先定比价口径，要不要我按「交期优先」再出一版？',
    )).toEqual([])
    expect(validateInsightCopy('## 进展\n- 周报待审')).toContain('markdown-block')
    expect(validateInsightCopy('进展顺利 ✅')).toContain('emoji')
    expect(validateInsightCopy('太好了！')).toContain('exclamation')
    expect(validateInsightCopy('我们闭环赋能')).toEqual(expect.arrayContaining(['marketing:闭环', 'marketing:赋能']))
    expect(validateInsightCopy('2026-11-03 完成')).toContain('absolute-date')
    expect(validateInsightCopy('先做哪个？要不要我出方案？')).toContain('too-many-questions')
    expect(validateInsightCopy('先做哪个？我等你定。')).toContain('question-not-last')
    // C5：URL 与模板占位符。
    expect(validateInsightCopy('详见 https://everroom.example/plan 的第三节，我已经核对过了。')).toContain('url')
    expect(validateInsightCopy('价格是 {{price}} 元，交期已确认，建议按这个口径推进。')).toContain('template-placeholder')
    // C11：免责/谦虚声明。
    expect(validateInsightCopy('周报已整理完成，数据口径也已统一。希望对你有帮助。')).toContain('disclaimer')
    // C2：短fragment必须能独立成句。
    expect(validateInsightCopy('还在整理')).toContain('too-short-fragment')
    // C3：最多 3 句。
    expect(validateInsightCopy('周报在等你审阅。比价卡在交期取舍。定稿还没回。建议先定比价口径。')).toContain('too-many-sentences')
  })

  it('extractInsightDetail 返回命中的消息 id', () => {
    expect(extractInsightDetail([
      { role: 'assistant', content: '旧结论', id: 'm-old' },
      { role: 'assistant', content: '新结论', id: 'm-new' },
    ])).toEqual({ text: '新结论', messageId: 'm-new' })
  })
})

describe('概览页洞察状态', () => {
  it('无工作时显示空态卡「等待第一项工作」，无来源/落款/刷新', async () => {
    installNxcore()
    await renderPage(pageProps())

    expect(textOf('.wb-ov-insight-badge')).toContain('洞察')
    expect(textOf('.wb-ov-insight-empty-title')).toBe(INSIGHT_COPY.emptyTitle)
    expect(textOf('.wb-ov-insight-empty-desc')).toBe(INSIGHT_COPY.emptyBody)
    expect(container.querySelector('.wb-ov-insight-source-btn')).toBeNull()
    expect(container.querySelector('.wb-ov-insight-footer')).toBeNull()
    expect(container.querySelector('.wb-ov-insight-refresh')).toBeNull()
  })

  it('有工作但无可归纳正文时显示聚合总结，不再显示 no-content 说明', async () => {
    const idle = sessionFixture({ id: 's-1', status: 'idle' })
    installNxcore({ sessions: { 's-1': snapshotFixture(idle, [messageFixture('user', '只说了话')]) } })
    await renderPage(pageProps({ sessions: [idle] }))

    // 聚合总结成立：no-content 也渲染正文，不再显示「还没有可汇总的内容」。
    expect(container.textContent).toContain('1 项工作')
    expect(container.textContent).not.toContain(INSIGHT_COPY.noContent)
    expect(container.querySelector('.wb-ov-insight-refresh')).not.toBeNull()
  })

  it('ready 时展示来源行与落款；来源行可展开证据并跳会话', async () => {
    const idle = sessionFixture({
      id: 's-1',
      title: '整理连接器需求',
      status: 'idle',
      updatedAt: '2026-10-30T11:00:00.000Z',
    })
    installNxcore({
      sessions: { 's-1': snapshotFixture(idle, [messageFixture('assistant', '结论：映射表收口 60%。')]) },
      files: () => Promise.resolve({ items: [], total: 0 }),
    })
    const props = pageProps({ sessions: [idle] })
    await renderPage(props)

    expect(container.textContent).not.toContain(INSIGHT_COPY.updating)
    expect(textOf('.wb-ov-insight-source-btn')).toContain('基于本空间 1 项工作')
    expect(textOf('.wb-ov-insight-source-btn')).toContain('与 0 个文件')
    expect(textOf('.wb-ov-insight-footer')).toContain('你的工作台助理')

    await click(container.querySelector('.wb-ov-insight-source-btn'))
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain(INSIGHT_COPY.evidenceTitle)
    expect(dialog?.textContent).toContain('整理连接器需求')

    await click(container.querySelector('.wb-ov-insight-evidence-row'))
    expect(props.onOpenSession).toHaveBeenCalledWith('s-1')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('点刷新重新派生并 toast；失败不 toast', async () => {
    const idle = sessionFixture({ id: 's-1', status: 'idle', updatedAt: '2026-10-30T11:00:00.000Z' })
    const { nxcore } = installNxcore({
      sessions: { 's-1': snapshotFixture(idle, [messageFixture('assistant', '结论：映射表收口 60%。')]) },
    })
    const props = pageProps({ sessions: [idle] })
    await renderPage(props)
    expect(nxcore.agent.getSession).toHaveBeenCalledTimes(1)

    await click(container.querySelector('.wb-ov-insight-refresh'))
    expect(nxcore.agent.getSession).toHaveBeenCalledTimes(2)
    expect(props.onToast).toHaveBeenCalledWith(INSIGHT_COPY.refreshToast)

    // 刷新中不丢焦点：aria-disabled 而非原生 disabled（§7.1）。
    const refreshBtn = container.querySelector<HTMLButtonElement>('.wb-ov-insight-refresh')
    expect(refreshBtn?.getAttribute('aria-disabled')).toBeDefined()
    expect(refreshBtn?.disabled).toBeFalsy()
    // 读屏可读完整正文（视觉隐藏全文节点）——聚合总结口径。
    expect(container.querySelector('.wb-ov-insight-text .wb-sr-only')?.textContent)
      .toContain('1 项工作：1 项有新结果')
  })

  it('失败进入冷却；冷却到期自动重试（不再永久停在错误态）', async () => {
    // 冷却 160ms：renderPage 自带 ~100ms flush，之后记录基线；再等 200ms 跨过冷却窗口。
    __setInsightCooldownForTests(160)
    const failing = sessionFixture({ id: 's-1', status: 'idle' })
    const { nxcore } = installNxcore() // getSession 默认 reject
    await renderPage(pageProps({ sessions: [failing] }))
    expect(container.textContent).toContain(INSIGHT_COPY.error)
    const callsAfterFirstFailure = nxcore.agent.getSession.mock.calls.length
    expect(callsAfterFirstFailure).toBeGreaterThanOrEqual(1)

    // 冷却到期 → 自动再派生（仍是错误，但请求确实重发了）。
    await flush(14, 15) // ~210ms，跨过 160ms 冷却
    expect(nxcore.agent.getSession.mock.calls.length).toBeGreaterThan(callsAfterFirstFailure)
    expect(container.textContent).toContain(INSIGHT_COPY.error)
  })

  it('其它空间的会话不参与本空间洞察（防串台）', async () => {
    installNxcore()
    const other = sessionFixture({ id: 's-other', workspaceId: 'ws-2' })
    await renderPage(pageProps({ sessions: [other] }))

    expect(textOf('.wb-ov-insight-empty-title')).toBe(INSIGHT_COPY.emptyTitle)
  })
})

describe('概览页动态（网关派生 + 游标）', () => {
  const doneRow = {
    id: 'run:r1:end',
    kind: 'work-done',
    actor: 'agent',
    at: '2026-10-30T12:00:00.000Z',
    segments: [{ text: '结束了工作 ' }, { sessionId: 's-1' }],
    source: { table: 'agent_runs', rowId: 'r1' },
  }
  const planRow = {
    id: 'plan:e1',
    kind: 'plan',
    actor: 'user',
    at: '2026-10-30T11:00:00.000Z',
    segments: [{ planItemId: 'p-1' }, { text: ' 移动到进行中' }],
    source: { table: 'workspace_plan_item_events', rowId: 'e1' },
  }

  it('桥可用时用网关派生事件：分段引用、计划行可点', async () => {
    const { nxcore } = installNxcore({
      activities: () => Promise.resolve({ items: [doneRow, planRow], nextBeforeAt: null, nextBeforeId: null }),
    })
    const props = pageProps({ sessions: [sessionFixture({ id: 's-1', title: '周报整理', status: 'closed' })] })
    await renderPage(props)

    expect(nxcore.workspace.activities).toHaveBeenCalledWith('ws-1', { limit: 20 })

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.wb-ov-activity'))
    expect(rows).toHaveLength(2)
    // 契约里的 sessionId 段按 id 实时解析成名字（不是文案快照）。
    expect(rows[0]!.querySelector('.wb-ov-activity-ref')?.textContent).toBe('周报整理')
    expect(rows[1]!.textContent).toContain('移动到进行中')
    // 计划行的引用跳「计划」看板。
    expect(rows[1]!.querySelector('.wb-ov-activity-ref')?.textContent).toBe('计划项')
    await click(rows[1]!.querySelector('.wb-ov-activity-ref'))
    expect(props.onOpenPage).toHaveBeenCalledWith('plan')
  })

  it('「显示更早」按 (at, id) 游标续拉下一页', async () => {
    const page1 = {
      items: Array.from({ length: 8 }, (_, index) => ({
        ...doneRow,
        id: `run:r${index}:end`,
        at: `2026-10-30T1${index}:00:00.000Z`,
      })),
      nextBeforeAt: '2026-10-30T10:00:00.000Z',
      nextBeforeId: 'run:r7:end',
    }
    const page2 = { items: [{ ...doneRow, id: 'run:old:end', at: '2026-10-29T10:00:00.000Z' }], nextBeforeAt: null, nextBeforeId: null }
    const { nxcore } = installNxcore({
      activities: () => Promise.resolve(nxcore.workspace.activities.mock.calls.length === 1 ? page1 : page2),
    })
    await renderPage(pageProps({ sessions: [sessionFixture({ id: 's-1' })] }))

    // 首屏 8 条正好等于折叠上限，但服务端还有更早的 → 仍给入口。
    expect(container.querySelectorAll('.wb-ov-activity')).toHaveLength(8)
    await click(container.querySelector('.wb-ov-more'))
    expect(nxcore.workspace.activities).toHaveBeenLastCalledWith('ws-1', {
      limit: 20,
      beforeAt: page1.nextBeforeAt,
      beforeId: page1.nextBeforeId,
    })
    expect(container.querySelectorAll('.wb-ov-activity')).toHaveLength(9)
  })

  it('网关不可用时回落本地派生，不显示空态', async () => {
    installNxcore({ activities: () => Promise.reject(new Error('gateway down')) })
    const running = sessionFixture({ id: 's-9', title: '跑数据核对', status: 'running', updatedAt: '2026-10-30T12:00:00.000Z' })
    await renderPage(pageProps({ sessions: [running] }))

    expect(container.textContent).toContain('开始了工作')
    expect(container.textContent).toContain('跑数据核对')
    expect(container.textContent).not.toContain('还没有动态')
  })
})

describe('概览页「等你确认」（审批活状态）', () => {
  const reviewRow = {
    id: 'approval:run-1:apr-1',
    kind: 'work-review',
    actor: 'agent',
    at: '2026-10-30T12:00:00.000Z',
    segments: [{ text: '等你确认 ' }, { sessionId: 's-1' }, { text: ' · bash' }],
    source: { table: 'agent_events', rowId: 'ev-1' },
  }

  it('渲染成 warning 色的「等你确认」，点会话引用回到对话（卡片就在那里）', async () => {
    installNxcore({
      activities: () => Promise.resolve({ items: [reviewRow], nextBeforeAt: null, nextBeforeId: null }),
    })
    const props = pageProps({ sessions: [sessionFixture({ id: 's-1', title: '跑一遍测试', status: 'running' })] })
    await renderPage(props)

    const row = container.querySelector<HTMLElement>('.wb-ov-activity')
    expect(row?.textContent).toContain('等你确认')
    expect(row?.textContent).toContain('bash')
    expect(row?.querySelector('.wb-ov-activity-icon')?.className).toContain('is-warning')

    await click(row!.querySelector('.wb-ov-activity-ref'))
    expect(props.onOpenSession).toHaveBeenCalledWith('s-1')
  })

  it('有运行中会话时低频轮询，卡片处理掉后行消失', async () => {
    vi.useFakeTimers()
    try {
      const activities = vi
        .fn()
        .mockResolvedValueOnce({ items: [reviewRow], nextBeforeAt: null, nextBeforeId: null })
        .mockResolvedValue({ items: [], nextBeforeAt: null, nextBeforeId: null })
      installNxcore({ activities })
      const props = pageProps({ sessions: [sessionFixture({ id: 's-1', status: 'running' })] })
      // 这里不能用共享的 flush（它靠真实 setTimeout），用 advanceTimersByTimeAsync 驱动。
      await act(async () => {
        root.render(<OverviewPage {...props} />)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.textContent).toContain('等你确认')
      expect(activities).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(activities).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('等你确认')
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有运行中会话时不轮询', async () => {
    vi.useFakeTimers()
    try {
      const activities = vi.fn().mockResolvedValue({ items: [], nextBeforeAt: null, nextBeforeId: null })
      installNxcore({ activities })
      await act(async () => {
        root.render(<OverviewPage {...pageProps({ sessions: [sessionFixture({ id: 's-1', status: 'idle' })] })} />)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const calls = activities.mock.calls.length

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(activities.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('概览页动态 · 产物落盘实时性', () => {
  it('本空间产物落盘后重拉首屏；别的空间不打扰', async () => {
    const listeners: Array<(event: { type: string; workspaceId?: string }) => void> = []
    const activities = vi.fn().mockResolvedValue({ items: [], nextBeforeAt: null, nextBeforeId: null })
    installNxcore({
      activities,
      office: {
        onAgentFile: (listener) => {
          listeners.push(listener)
          return () => {}
        },
      },
    })
    await renderPage(pageProps())
    expect(activities).toHaveBeenCalledTimes(1)

    await act(async () => {
      for (const listener of listeners) listener({ type: 'done', workspaceId: 'ws-1' })
    })
    await flush()
    expect(activities).toHaveBeenCalledTimes(2)

    await act(async () => {
      for (const listener of listeners) listener({ type: 'done', workspaceId: 'ws-2' })
    })
    await flush()
    expect(activities).toHaveBeenCalledTimes(2)
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
