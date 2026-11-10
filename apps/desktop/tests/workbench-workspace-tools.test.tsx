// @vitest-environment happy-dom
/**
 * 工作空间工具页回归：计划看板四列（待开始/进行中/已完成/已取消）计数、
 * 卡片点开详情、新建任务。
 *
 * 原第二部分「新建空间两步引导」已随引导弹窗一起移除（一步式创建不再有
 * 创建后引导），相关流程回归见 tests/project-space-directory.test.tsx。
 *
 * 与 tests/office-proto-recent-view.test.tsx 同款 happy-dom + 手动 act/createRoot 写法，
 * 不引入 testing-library；只 mock preload 桥 window.nxcore。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentWorkspace, PlanItem } from '@nxcore/agent-contract'

import { PlanPage } from '../src/renderer/src/workbench/workspace/PlanPage'
import type { WorkspacePageProps } from '../src/renderer/src/workbench/workspace/contracts'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-20T08:00:00.000Z'

const WORKSPACE: AgentWorkspace = {
  id: 'ws-1',
  name: '连接器项目',
  description: null,
  goals: [],
  path: null,
  kind: 'custom',
  createdAt: ISO,
  updatedAt: ISO,
  lastOpenedAt: ISO,
}

function makePlanItem(overrides: Partial<PlanItem> & { id: string }): PlanItem {
  return {
    workspaceId: 'ws-1',
    title: overrides.id,
    detail: null,
    acceptance: null,
    constraints: [],
    status: 'todo',
    priority: 'normal',
    ownerKind: 'unassigned',
    ownerAgentId: null,
    assigneeSessionId: null,
    lastRunId: null,
    createdBy: 'user',
    createdByAgentId: null,
    dueAt: null,
    rank: overrides.id,
    tags: [],
    checklist: [],
    refs: [],
    blockedBy: [],
    resultSummary: null,
    closeReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    version: 1,
    completedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function pageProps(overrides: Partial<WorkspacePageProps> = {}): WorkspacePageProps {
  return {
    tab: { id: 'ws:ws-1', kind: 'workspace', workspaceId: 'ws-1', view: { kind: 'page', page: 'plan' } },
    workspace: WORKSPACE,
    sessions: [],
    onOpenSession: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenPage: vi.fn(),
    onNewWork: vi.fn(),
    onToast: vi.fn(),
    ...overrides,
  }
}

function installNxcore(overrides: {
  listPlanItems?: (query: unknown) => Promise<unknown>
  createPlanItem?: (input: unknown) => Promise<unknown>
} = {}) {
  const api = {
    plan: {
      list: vi.fn(overrides.listPlanItems ?? (async () => ({ items: [] }))),
      create: vi.fn(overrides.createPlanItem ?? (async (input: unknown) => input)),
      get: vi.fn(async () => null),
      update: vi.fn(async (itemId: string, input: unknown) => ({ id: itemId, ...(input as object) })),
      move: vi.fn(async (itemId: string, input: unknown) => ({ id: itemId, ...(input as object) })),
      release: vi.fn(async (itemId: string) => ({ id: itemId })),
      assign: vi.fn(async (itemId: string) => ({ item: { id: itemId }, sessionId: 'sess-1', runId: 'run-1' })),
      remove: vi.fn(async (itemId: string) => ({ id: itemId })),
      events: vi.fn(async () => ({ events: [] })),
      claimPackage: vi.fn(async (itemId: string) => ({
        item: {
          id: itemId, workspaceId: 'ws-1', title: '任务', detail: null, acceptance: null,
          constraints: [], priority: 'normal', dueAt: null, tags: [], checklist: [], status: 'todo',
        },
        why: { createdBy: 'user', createdByLabel: '你（用户）', createdAt: ISO, assignReason: null },
        space: { name: 'ws', root: null, libraryPath: null, artifactsPath: null },
        materials: [],
        history: [],
        dependencies: [],
        contract: { mustUpdateStatus: true, mustWriteResultSummary: true, leaseTtlSec: 600, outputHint: null },
      })),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      batch: vi.fn(async () => ({ items: [], failed: [] })),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { nxcore?: unknown }).nxcore = api
  return api
}

let container: HTMLDivElement
let root: Root | null = null

async function flush(rounds = 8, step = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function render(element: React.ReactElement) {
  root = createRoot(container)
  act(() => {
    root?.render(element)
  })
}

function bodyText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

function buttonByText(text: string): HTMLButtonElement {
  const normalized = text.replace(/\s+/g, '')
  const buttons = Array.from(document.body.querySelectorAll('button'))
  const found = buttons.find((button) => (button.textContent ?? '').replace(/\s+/g, '').includes(normalized))
  if (!found) throw new Error(`button not found: ${text} · buttons=${buttons.map((button) => button.textContent).join('|')}`)
  return found
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('click target not found')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  document.body.innerHTML = ''
  localStorage.clear()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  vi.restoreAllMocks()
})

/* ───────────────── 计划看板 ───────────────── */

describe('计划看板', () => {
  it('四列渲染 + 计数 + 卡片标题来自任务（不再是会话）', async () => {
    installNxcore({
      listPlanItems: async () => ({
        items: [
          makePlanItem({ id: 't-todo', title: '对比供应商', status: 'todo' }),
          makePlanItem({ id: 't-doing', title: '写发布计划', status: 'doing', ownerKind: 'agent', ownerAgentId: 'main' }),
          makePlanItem({ id: 't-done', title: '整理会议纪要', status: 'done', completedAt: ISO }),
          makePlanItem({ id: 't-dropped', title: '旧口径', status: 'dropped', completedAt: ISO }),
        ],
      }),
    })
    render(<PlanPage {...pageProps()} />)
    await flush()

    const labels = Array.from(document.querySelectorAll('.wb-plan-col-head strong')).map((node) => node.textContent)
    expect(labels).toEqual(['待开始', '进行中', '已完成', '已取消'])
    const counts = Array.from(document.querySelectorAll('.wb-plan-col-count')).map((node) => node.textContent)
    expect(counts).toEqual(['1', '1', '1', '1'])
    expect(bodyText()).toContain('对比供应商')
    expect(bodyText()).toContain('写发布计划')
    // 不区分负责人：卡片上没有「我 / Agent / 待认领」标签
    expect(bodyText()).not.toContain('待认领')
    expect(bodyText()).not.toContain('Agent main')
  })

  it('点卡片打开详情抽屉（不再跳会话）', async () => {
    const onOpenSession = vi.fn()
    installNxcore({
      listPlanItems: async () => ({
        items: [makePlanItem({ id: 't-1', title: '写发布计划', detail: '背景在这里' })],
      }),
    })
    render(<PlanPage {...pageProps({ onOpenSession })} />)
    await flush()

    await click(document.querySelector('.wb-plan-task'))
    await flush()
    expect(document.querySelector('.wb-plan-detail')).not.toBeNull()
    expect(bodyText()).toContain('背景与要求')
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it('空计划也渲染四列，并保留「新建工作」入口', async () => {
    const onNewWork = vi.fn()
    installNxcore({ listPlanItems: async () => ({ items: [] }) })
    render(<PlanPage {...pageProps({ onNewWork })} />)
    await flush()

    // 四列常显：没有任务时不再用空态整页替换看板
    const labels = Array.from(document.querySelectorAll('.wb-plan-col-head strong')).map((node) => node.textContent)
    expect(labels).toEqual(['待开始', '进行中', '已完成', '已取消'])
    expect(bodyText()).not.toContain('还没有任务')
    // 空列各自保留新建入口
    const empties = document.querySelectorAll('.wb-plan-empty')
    expect(empties).toHaveLength(4)
    await click(buttonByText('新建工作'))
    expect(onNewWork).toHaveBeenCalledTimes(1)
  })

  it('新建任务：输入标题回车后调用网关并渲染新卡片', async () => {
    let created: PlanItem | null = null
    const api = installNxcore({
      listPlanItems: async () => ({ items: created ? [created] : [] }),
      createPlanItem: async (input) => {
        created = makePlanItem({ id: 't-new', title: (input as { title: string }).title })
        return created
      },
    })
    render(<PlanPage {...pageProps()} />)
    await flush()

    await click(buttonByText('新建任务'))
    await flush()
    const input = document.querySelector('.wb-plan-compose-bar input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    setInputValue(input!, '整理 Q3 成本表')
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()

    const create = api.plan.create as ReturnType<typeof vi.fn>
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-1', title: '整理 Q3 成本表' })
    expect(bodyText()).toContain('整理 Q3 成本表')
  })
})
