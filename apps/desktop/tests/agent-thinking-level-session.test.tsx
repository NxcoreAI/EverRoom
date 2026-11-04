// @vitest-environment happy-dom
/**
 * 思考档位端到端接线回归（桌面渲染层 → hook → preload API 契约）：
 * 1) 草稿态选择档位会持久化为默认值，首条消息建会话时显式带上 thinkingLevel；
 * 2) 已有会话选择档位会调 setThinkingLevel(PUT)，并用回读值更新会话展示。
 *
 * 通过文件停靠栏（AgentChatDock）真实挂载 useAgentSession + AgentComposer，
 * 用 fake gateway 断言 IPC API 的入参（对应 main/preload 的 agent:set-thinking-level）。
 */
import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatDock } from '../src/renderer/src/office-proto/AgentChatDock'
import type { OfficeFile } from '../src/renderer/src/office-proto/data'
import { persistThinkingLevel } from '../src/renderer/src/components/agent/agentThinkingLevel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-10-30T06:00:00.000Z'
const FILE: OfficeFile = {
  id: 'real:file-thinking',
  name: '思考档位测试.docx',
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
    createSession: vi.fn(async (input: { pageLabel: string; workspaceId?: string | null; thinkingLevel?: string | null }) => {
      const created = makeSession({
        id: `created-${sessions.length + 1}`,
        pageLabel: input.pageLabel,
        workspaceId: input.workspaceId ?? 'default',
        thinkingLevel: input.thinkingLevel ?? null,
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
    startRun: vi.fn(async (sessionId: string, input: { prompt: string }) => ({
      id: 'run-1',
      sessionId,
      status: 'accepted' as const,
      prompt: input.prompt,
      lastEventSeq: 0,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: ISO,
    })),
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    setThinkingLevel: vi.fn(async (sessionId: string, level: 'high' | null) => {
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`no session ${sessionId}`)
      session.thinkingLevel = level
      return { thinkingLevel: level, applied: true }
    }),
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

let gateway: ReturnType<typeof fakeGateway>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
  window.localStorage.clear()
  vi.restoreAllMocks()
})

async function renderDock(): Promise<void> {
  await act(async () => {
    root.render(<AgentChatDock file={FILE} onToast={() => undefined} />)
  })
  await flush()
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

async function openThinkingPicker(): Promise<HTMLElement[]> {
  const trigger = container.querySelector<HTMLElement>('.agent-thinking-level-toggle')
  expect(trigger, '非渠道会话应渲染思考档位切换钮').not.toBeNull()
  await act(async () => {
    trigger!.click()
  })
  return [...container.querySelectorAll<HTMLElement>('.agent-thinking-level-picker [role="option"]')]
}

describe('思考档位端到端接线', () => {
  it('草稿态默认值随首条消息建会话显式带上 thinkingLevel', async () => {
    gateway = fakeGateway([])
    ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }
    persistThinkingLevel('high')

    await renderDock()
    const textarea = container.querySelector<HTMLTextAreaElement>('.agent-composer-input textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      setTextareaValue(textarea!, '你好')
    })
    await act(async () => {
      container.querySelector<HTMLElement>('.agent-prompt-submit')!.click()
    })
    await flush()

    expect(gateway.createSession).toHaveBeenCalledTimes(1)
    expect(gateway.createSession.mock.calls[0][0]).toMatchObject({
      pageLabel: FILE.id,
      thinkingLevel: 'high',
    })
    expect(gateway.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('已有会话点「高」会 PUT 并更新会话展示', async () => {
    gateway = fakeGateway([
      makeSession({ id: 'session-1', pageLabel: FILE.id, title: '已有对话', thinkingLevel: null }),
    ])
    ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }

    await renderDock()
    const options = await openThinkingPicker()
    const high = options.find((option) => option.dataset.level === 'high')
    expect(high).not.toBeUndefined()
    await act(async () => {
      high!.click()
    })
    await flush(2)

    expect(gateway.setThinkingLevel).toHaveBeenCalledWith('session-1', 'high')
    const trigger = container.querySelector<HTMLElement>('.agent-thinking-level-toggle')
    expect(trigger!.textContent).toContain('高')
    expect(window.localStorage.getItem('nxcore-ce:agent-thinking-level:v1')).toBe('high')
  })
})