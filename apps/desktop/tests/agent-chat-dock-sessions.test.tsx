// @vitest-environment happy-dom
/**
 * 回归（用户可见面）：文件标签右侧 Agent 停靠栏的「对话记录」下拉必须列出
 * 本文件的历史会话，且切走再切回（组件重挂）后仍然列得出。
 *
 * 与 agent-session-page-scope.test.tsx 互补：那边锁分区键契约，这里锁用户实际
 * 看到的那个下拉。根因是停靠栏按 pageLabel（当时 = 文件名）列会话，而建会话时
 * pageLabel 被写死成 'Agent'——写进去的会话永远读不出来。现在停靠栏用文件的
 * 稳定 id 做分区键（sessionKey = file.id），文件名只当运行上下文。
 */
import type {
  AgentSession,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatDock } from '../src/renderer/src/office-proto/AgentChatDock'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-30T06:00:00.000Z'
const FILE_NAME = '周报：连接器统一排期.docx'
const FILE: OfficeFile = {
  id: 'real:file-weekly',
  name: FILE_NAME,
  kind: 'docx',
  roomId: null,
  updatedLabel: '刚刚',
  sizeLabel: '12 KB',
  memoryCount: 0,
  content: { type: 'md', source: '' },
}

function makeSession(over: Partial<AgentSession> & { id: string; pageLabel: string }): AgentSession {
  return {
    workspaceId: 'default',
    roomId: null,
    runtimeId: 'rt-main',
    title: over.title ?? null,
    status: 'idle',
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  }
}

function fakeGateway(initial: AgentSession[] = []) {
  const sessions: AgentSession[] = [...initial]
  const snapshotOf = (session: AgentSession): AgentSessionSnapshot => ({
    session,
    participants: [],
    activeRun: null,
    messages: [],
    lastEventSeq: 0,
  })
  return {
    listSessions: vi.fn(async (pageLabel?: string) =>
      pageLabel === undefined ? [...sessions] : sessions.filter((session) => session.pageLabel === pageLabel)),
    createSession: vi.fn(async (input: { pageLabel: string; workspaceId?: string | null }) => {
      const created = makeSession({
        id: `created-${sessions.length + 1}`,
        pageLabel: input.pageLabel,
        workspaceId: input.workspaceId ?? 'default',
      })
      sessions.push(created)
      return created
    }),
    getSession: vi.fn(async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      return snapshotOf(session)
    }),
    getEvents: vi.fn(async () => []),
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    updateSession: vi.fn(async (sessionId: string, input: { title?: string | null }) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      if (input.title !== undefined) session.title = input.title
      return session
    }),
    deleteSession: vi.fn(async () => undefined),
    generateSessionTitle: vi.fn(async () => ({ title: '新标题' })),
  }
}

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

let gateway: ReturnType<typeof fakeGateway>
let mounted: { container: HTMLDivElement; root: Root }

beforeEach(() => {
  gateway = fakeGateway([
    makeSession({ id: 'file-session', pageLabel: FILE.id, title: '本周周报的讨论' }),
    // 别的分区的会话（旧实现里停靠栏建出来的 pageLabel='Agent'）不属于本文件。
    makeSession({ id: 'legacy-agent-session', pageLabel: 'Agent', title: '另一处的对话' }),
  ])
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }
  window.localStorage.clear()
  mounted = mount()
})

afterEach(async () => {
  await act(async () => {
    mounted.root.unmount()
  })
  mounted.container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  window.localStorage.clear()
  vi.restoreAllMocks()
})

async function renderDock(): Promise<void> {
  await act(async () => {
    mounted.root.render(<AgentChatDock file={FILE} onToast={() => undefined} />)
  })
  await flush()
}

async function openSessionMenu(): Promise<void> {
  const trigger = mounted.container.querySelector<HTMLElement>('.agent-session-trigger')
  expect(trigger, '停靠栏应渲染会话切换下拉').not.toBeNull()
  await act(async () => {
    trigger!.click()
  })
  await flush(2)
}

describe('文件停靠栏「对话记录」下拉', () => {
  it('列出本文件的会话，而不是空列表', async () => {
    await renderDock()
    await openSessionMenu()

    const list = mounted.container.querySelector('.agent-session-list')
    expect(list).not.toBeNull()
    expect(mounted.container.querySelector('.agent-session-empty')).toBeNull()
    expect(list!.textContent).toContain('本周周报的讨论')
    // 别的分区（pageLabel='Agent'）的会话不属于本文件，不应混进来。
    expect(list!.textContent).not.toContain('另一处的对话')
    // 下拉按文件稳定 id（file.id）读写，不用会变的文件名。
    expect(gateway.listSessions).toHaveBeenCalledWith(FILE.id)
  })

  it('切走再切回（重挂）后，下拉仍然列出本文件的会话并选中它', async () => {
    await renderDock()
    await openSessionMenu()
    expect(mounted.container.querySelector('.agent-session-list')!.textContent).toContain('本周周报的讨论')

    await act(async () => {
      mounted.root.unmount()
    })
    mounted.container.remove()
    mounted = mount()
    await renderDock()
    await openSessionMenu()

    expect(mounted.container.querySelector('.agent-session-list')!.textContent).toContain('本周周报的讨论')
    // 当前选中会话就是本文件那条（触发器标题不是「新对话」）。
    expect(mounted.container.querySelector('.agent-session-trigger')!.textContent).toContain('本周周报的讨论')
  })
})
