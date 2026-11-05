// @vitest-environment happy-dom
/**
 * 工作台「新建任务」空态（hero）输入框一致性回归：
 * 用户反馈草稿态对话框缺少「智能档位」「+」等控件（已有会话的
 * AgentComposer 全有）。修复方式是草稿态与会话态共用同一个 AgentComposer。
 *
 * 1) hero 里渲染 AgentComposer：模型档位切换钮（智能）、「+」添加入口、
 *    思考档位切换钮、发送按钮都在；
 * 2) 点「+」展开添加菜单（导入文件 / 挂载目录）；
 * 3) 点「智能」展开档位选择器（智能/强模型/轻量）。
 */
import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPane } from '../src/renderer/src/workbench/conversation/ConversationPane'
import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-05T06:00:00.000Z'
const WS = 'ws-hero-composer'

const TAB_ID = 'tab-hero'

function installGateway() {
  const gateway = {
    listSessions: vi.fn(async () => [] as AgentSession[]),
    createSession: vi.fn(async () => ({
      id: 'created-1',
      workspaceId: WS,
      roomId: null,
      pageLabel: 'Agent',
      runtimeId: 'rt-main',
      title: null,
      status: 'idle' as const,
      createdAt: ISO,
      updatedAt: ISO,
    })),
    getSession: vi.fn(async (): Promise<AgentSessionSnapshot> => ({
      session: {
        id: 'created-1',
        workspaceId: WS,
        roomId: null,
        pageLabel: 'Agent',
        runtimeId: 'rt-main',
        title: null,
        status: 'idle' as const,
        createdAt: ISO,
        updatedAt: ISO,
      },
      participants: [],
      activeRun: null,
      messages: [],
      lastEventSeq: 0,
    })),
    getEvents: vi.fn(async () => []),
    startRun: vi.fn(async () => ({
      id: 'run-1',
      sessionId: 'created-1',
      status: 'accepted' as const,
      prompt: '',
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
    setThinkingLevel: vi.fn(async () => ({ thinkingLevel: 'high', applied: true })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway }
  return gateway
}

let container: HTMLDivElement
let root: Root

async function flush(rounds = 12, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  useWorkbenchStore.setState({
    askDrafts: [],
    pendingAgentAsk: null,
    askQueueSendNonce: 0,
  } as Partial<ReturnType<typeof useWorkbenchStore.getState>>)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  ;(window as unknown as { nxcore: unknown }).nxcore = undefined
  window.localStorage.clear()
})

describe('工作台新建任务 hero 输入框（AgentComposer 一致性）', () => {
  it('草稿态 hero 渲染模型档位钮、「+」添加钮、思考档位钮与发送钮', async () => {
    installGateway()
    await act(async () => {
      root.render(
        <LocaleProvider>
          <ConversationPane tabId={TAB_ID} workspaceId={WS} sessionId={null} />
        </LocaleProvider>,
      )
    })
    await flush()

    const hero = container.querySelector('.wb-hero-input')
    expect(hero, 'hero 输入框应存在').not.toBeNull()

    const tier = hero!.querySelector<HTMLElement>('.agent-model-tier-toggle')
    expect(tier, 'hero 里应有模型档位切换钮（智能）').not.toBeNull()
    expect(tier!.textContent).toContain('智能')

    const add = hero!.querySelector<HTMLElement>('.agent-add-button')
    expect(add, 'hero 里应有「+」添加入口').not.toBeNull()

    const thinking = hero!.querySelector<HTMLElement>('.agent-thinking-level-toggle')
    expect(thinking, 'hero 里应有思考档位切换钮').not.toBeNull()

    const send = hero!.querySelector<HTMLElement>('button[type="submit"]')
    expect(send, 'hero 里应有发送按钮').not.toBeNull()

    const textarea = hero!.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea, 'hero 输入框 textarea 应存在').not.toBeNull()
    expect(textarea!.placeholder).toContain('今天帮你做些什么')
  })

  it('点「+」展开添加菜单：导入文件 / 挂载目录', async () => {
    installGateway()
    await act(async () => {
      root.render(
        <LocaleProvider>
          <ConversationPane tabId={TAB_ID} workspaceId={WS} sessionId={null} />
        </LocaleProvider>,
      )
    })
    await flush()

    const add = container.querySelector<HTMLElement>('.wb-hero-input .agent-add-button')
    await act(async () => {
      add!.click()
    })

    const menu = container.querySelector('.agent-add-menu')
    expect(menu, '「+」应展开添加菜单').not.toBeNull()
    const items = [...menu!.querySelectorAll<HTMLElement>('.agent-add-menu-item')]
    expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual(['导入文件', '挂载目录'])
  })

  it('点「智能」展开模型档位选择器并可切到「强模型」', async () => {
    const gateway = installGateway()
    await act(async () => {
      root.render(
        <LocaleProvider>
          <ConversationPane tabId={TAB_ID} workspaceId={WS} sessionId={null} />
        </LocaleProvider>,
      )
    })
    await flush()

    const tier = container.querySelector<HTMLElement>('.wb-hero-input .agent-model-tier-toggle')
    await act(async () => {
      tier!.click()
    })

    const picker = container.querySelector('.agent-model-picker')
    expect(picker, '「智能」应展开档位选择器').not.toBeNull()
    const options = [...picker!.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(['智能', '强模型', '轻量'])

    // 草稿态选择档位只改「下次新会话默认」，不发请求（会话还没建）。
    const primary = options.find((option) => option.querySelector('strong')?.textContent === '强模型')!
    await act(async () => {
      primary.click()
    })
    await flush(2)
    expect(gateway.createSession).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('nxcore-ce:agent-model-preference:v1')).toBe('primary')
  })
})
