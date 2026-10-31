// @vitest-environment happy-dom
/**
 * 工作空间工具页回归：
 * 1) 计划看板分列（running / idle / closed+interrupted）与列计数；
 * 2) 新建空间两步引导——跳过某一步不丢前面已完成步骤的结果（原型 bug 回归）。
 *
 * 与 tests/office-proto-recent-view.test.tsx 同款 happy-dom + 手动 act/createRoot 写法，
 * 不引入 testing-library；只 mock preload 桥 window.nxcore。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import { PlanPage, groupPlanColumns } from '../src/renderer/src/workbench/workspace/PlanPage'
import { SetupWizard } from '../src/renderer/src/workbench/workspace/SetupWizard'
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

function makeSession(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    workspaceId: 'ws-1',
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'rt-main',
    title: '工作',
    status: 'idle',
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
  pickAndImport?: () => Promise<unknown>
  createSession?: (input: unknown) => Promise<unknown>
  updateSession?: (sessionId: string, input: { title: string }) => Promise<unknown>
} = {}) {
  const api = {
    agent: {
      createSession: vi.fn(overrides.createSession ?? (async () => ({ id: 'sess-new', title: null }))),
      updateSession: vi.fn(overrides.updateSession ?? (async (sessionId: string) => ({ id: sessionId }))),
    },
    files: {
      pickAndImport: vi.fn(overrides.pickAndImport ?? (async () => [])),
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

describe('计划看板分列', () => {
  it('按 running / idle / closed+interrupted 归类，并保持输入顺序', () => {
    const sessions = [
      makeSession({ id: 's-run', status: 'running' }),
      makeSession({ id: 's-idle', status: 'idle' }),
      makeSession({ id: 's-closed', status: 'closed' }),
      makeSession({ id: 's-interrupted', status: 'interrupted' }),
      makeSession({ id: 's-idle-2', status: 'idle' }),
    ]
    const groups = groupPlanColumns(sessions)
    expect(groups.running.map((session) => session.id)).toEqual(['s-run'])
    expect(groups.idle.map((session) => session.id)).toEqual(['s-idle', 's-idle-2'])
    expect(groups.done.map((session) => session.id)).toEqual(['s-closed', 's-interrupted'])
  })

  it('渲染三列计数、卡片点开会话', async () => {
    const onOpenSession = vi.fn()
    const onNewWork = vi.fn()
    render(
      <PlanPage
        {...pageProps({
          sessions: [
            makeSession({ id: 's-run', title: '写发布计划', status: 'running', updatedAt: new Date().toISOString() }),
            makeSession({ id: 's-idle', title: '对比供应商', status: 'idle' }),
            makeSession({ id: 's-closed', title: '整理会议纪要', status: 'closed' }),
          ],
          onOpenSession,
          onNewWork,
        })}
      />,
    )

    const counts = Array.from(document.querySelectorAll('.wb-plan-col-count')).map((node) => node.textContent)
    expect(counts).toEqual(['1', '1', '1'])
    const labels = Array.from(document.querySelectorAll('.wb-plan-col-head strong')).map((node) => node.textContent)
    expect(labels).toEqual(['进行中', '待开始', '已结束'])
    // 去说明化：页头不再有重复 eyebrow/subtitle，看板不再有 footnote 解释段。
    expect(document.querySelector('.ui-pagehead-eyebrow')).toBeNull()
    expect(document.querySelector('.ui-pagehead-sub')).toBeNull()
    expect(document.querySelector('.wb-plan-footnote')).toBeNull()

    await click(document.querySelector('.wb-plan-card'))
    expect(onOpenSession).toHaveBeenCalledWith('s-run')

    const newWork = buttonByText('新建工作')
    await click(newWork)
    expect(onNewWork).toHaveBeenCalledTimes(1)
  })

  it('空看板只显示列头计数，不额外渲染空态说明', async () => {
    render(<PlanPage {...pageProps()} />)
    const counts = Array.from(document.querySelectorAll('.wb-plan-col-count')).map((node) => node.textContent)
    expect(counts).toEqual(['0', '0', '0'])
    const bodies = Array.from(document.querySelectorAll('.wb-plan-col-body'))
    expect(bodies).toHaveLength(3)
    for (const body of bodies) expect(body.textContent).toBe('')
    expect(document.querySelector('.wb-plan-none')).toBeNull()
  })
})

/* ───────────────── 两步引导 ───────────────── */

const IMPORT_OUTCOMES = [
  { filename: '需求.docx', fileId: 'f-1', fileVersionId: 'v-1', error: null, skippedReason: null, deduped: false },
  { filename: '坏文件.zip', fileId: null, fileVersionId: null, error: '不支持的格式', skippedReason: null, deduped: false },
]

describe('新建空间两步引导', () => {
  it('导入资料后能创建工作，标题按用户输入落库', async () => {
    const api = installNxcore({
      pickAndImport: async () => IMPORT_OUTCOMES,
      createSession: async () => ({ id: 'sess-new', title: null }),
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    // 两步引导：资料 / 工作（工作空间内的「智能体」页已移除）。
    expect(document.querySelectorAll('.wb-setup-steps li')).toHaveLength(2)
    expect(bodyText()).not.toContain('智能体')
    // 去说明化：步骤里不再有 hint 说明小字，也没有空态说明块。
    expect(document.querySelectorAll('.wb-setup-step-hint')).toHaveLength(0)
    expect(document.querySelectorAll('.wb-setup-step-title')).toHaveLength(0)
    expect(document.querySelectorAll('.wb-tool-note')).toHaveLength(0)
    expect(document.querySelector('.ui-modal-desc')).toBeNull()

    await click(buttonByText('选择文件并导入'))
    await flush()
    expect(bodyText()).toContain('成功 1')
    expect(bodyText()).toContain('失败 1')

    await click(buttonByText('下一步'))
    await flush()

    // 翻到第 2 步后，第 1 步的结果仍在摘要里（关键回归点）。
    expect(bodyText()).toContain('1 份资料')
    expect(api.files.pickAndImport).toHaveBeenCalledTimes(1)

    const titleInput = document.querySelector<HTMLInputElement>('input[aria-label="工作名称"]')
    if (!titleInput) throw new Error('work title input not found')
    await act(async () => {
      setInputValue(titleInput, '整理发布计划')
    })
    // 步骤条里也有一个同名「添加工作」按钮，这里点表单里的操作按钮。
    await click(document.querySelector('.wb-setup-work-form .ui-btn'))
    await flush()

    expect(api.agent.createSession).toHaveBeenCalledWith({ pageLabel: 'Agent', roomId: null, workspaceId: 'ws-1' })
    expect(api.agent.updateSession).toHaveBeenCalledWith('sess-new', { title: '整理发布计划' })
    expect(bodyText()).toContain('已创建')
    expect(bodyText()).toContain('1 项工作')

    await click(buttonByText('完成'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('在最后一步点「跳过本步」：前面已落库的导入不丢（原型 bug 回归）', async () => {
    const api = installNxcore({
      pickAndImport: async () => [IMPORT_OUTCOMES[0]],
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    await click(buttonByText('选择文件并导入'))
    await flush()
    await click(buttonByText('下一步'))
    await flush()

    // 最后一步直接跳过：onDone 应被调用，而第 1 步的结果仍在。
    await click(buttonByText('跳过本步'))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(api.files.pickAndImport).toHaveBeenCalledTimes(1)
    expect(bodyText()).toContain('1 份资料')
  })

  it('导入失败给出可读错误，且不阻塞跳过完成', async () => {
    installNxcore({
      pickAndImport: async () => { throw new Error('导入通道不可用') },
    })
    const onDone = vi.fn()
    render(<SetupWizard workspace={WORKSPACE} onDone={onDone} />)
    await flush()

    await click(buttonByText('选择文件并导入'))
    await flush()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('导入通道不可用')

    await click(buttonByText('跳过本步'))
    await flush()
    await click(buttonByText('跳过本步'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
