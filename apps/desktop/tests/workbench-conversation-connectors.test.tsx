// @vitest-environment happy-dom
/**
 * 对话区操作栏「连接器」按钮回归：
 * 点击打开弹窗，弹窗里能像主页连接器页一样选择/授权连接器
 * （真实数据目录 + 分类筛选 + 详情抽屉 + 授权动作）。
 */
import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPane } from '../src/renderer/src/workbench/conversation/ConversationPane'
import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'
import {
  resetConnectorsSnapshotForTests,
} from '../src/renderer/src/office-proto/pages/connectorsData'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-06T06:00:00.000Z'
const WS = 'ws-conv-features'
const TAB_ID = 'tab-conv'

/* ───────────── Agent 网关 mock（与 workbench-hero-composer 同模式） ───────────── */

function installAgentGateway() {
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
  return gateway
}

/* ───────────── 连接器网关 mock（与 connectors-view-first-paint 同模式，直接 resolve） ───────────── */

interface ConnectorData {
  connections?: Array<{ provider: string; service: string; connectionName: string }>
}

function installConnectorGateway(data: ConnectorData = {}) {
  const gateway = {
    providers: vi.fn(async () => ({
      enabled: true,
      providers: [
        { provider: 'gmail', label: 'gmail', category: 'mail', iconKey: 'gmail', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
        { provider: 'notion', label: 'notion', category: 'docs', iconKey: 'notion', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      ],
    })),
    status: vi.fn(async () => ({
      enabled: true,
      connections: (data.connections ?? []).map((c) => ({
        id: `${c.service}:${c.connectionName}`,
        provider: c.provider,
        service: c.service,
        connectionName: c.connectionName,
        accountIdentityHash: null,
        status: 'active' as const,
        filters: {},
        createdAt: ISO,
        updatedAt: ISO,
        authMethod: 'nango-oauth' as const,
      })),
      disconnected: [],
      scopes: [],
      runs: [],
    })),
    oauthConfigs: vi.fn(async () => [
      { provider: 'gmail', displayName: 'Gmail', iconUrl: null },
      { provider: 'notion', displayName: 'Notion', iconUrl: null },
    ] satisfies Array<{ provider: string; displayName: string | null; iconUrl: string | null }>),
    startAuthorization: vi.fn(async () => ({ id: 'attempt-1' })),
    authorizationStatus: vi.fn(async () => ({ status: 'pending' as const })),
    purgeConnection: vi.fn(async () => undefined),
    reconnectConnection: vi.fn(async () => undefined),
  }
  const agentAuth = {
    status: vi.fn(async () => ({
      feishu: {
        cliState: 'ready' as const,
        cliPath: '/usr/local/bin/lark-cli',
        appConfigured: true,
        userAuthorized: false,
        userName: null,
        message: null,
      },
      activeChallenge: null,
    })),
    start: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  }
  return { gateway, agentAuth }
}

function installNxcore(connectorData: ConnectorData = {}) {
  const agentGateway = installAgentGateway()
  const { gateway: connectorGateway, agentAuth } = installConnectorGateway(connectorData)
  ;(window as unknown as { nxcore: unknown }).nxcore = {
    agent: agentGateway,
    nangoConnector: connectorGateway,
    agentAuth,
  }
  return { agentGateway, connectorGateway, agentAuth }
}

/* ───────────── 渲染工具 ───────────── */

let container: HTMLDivElement
let root: Root

async function flush(rounds = 12, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

async function renderPane(sessionId: string | null = null) {
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ConversationPane tabId={TAB_ID} workspaceId={WS} sessionId={sessionId} />
      </LocaleProvider>,
    )
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  resetConnectorsSnapshotForTests()
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
  resetConnectorsSnapshotForTests()
})

describe('对话区操作栏「连接器」', () => {
  it('操作栏渲染连接器按钮，点击打开连接器弹窗（真实目录卡片）', async () => {
    installNxcore()
    await renderPane()

    const hero = container.querySelector('.wb-hero-input')!
    const connectorsBtn = hero.querySelector<HTMLButtonElement>('.agent-connectors-toggle')
    expect(connectorsBtn, '操作栏应有「连接器」按钮').not.toBeNull()
    expect(connectorsBtn!.textContent).toContain('连接器')

    await act(async () => {
      connectorsBtn!.click()
    })
    await flush()

    // Radix Modal portal 渲染在 body 下。
    const modal = document.querySelector('.ui-modal')
    expect(modal, '点击后应打开连接器弹窗').not.toBeNull()
    expect(modal!.textContent).toContain('连接器')

    // 目录来自真实数据：gmail + notion 两张卡片。
    await flush(20)
    const cards = [...modal!.querySelectorAll('.op-conn-card .op-conn-name')]
      .map((el) => el.textContent)
    expect(cards).toContain('Gmail')
    expect(cards).toContain('Notion')
  })

  it('弹窗内点卡片打开详情抽屉，点「连接」发起授权', async () => {
    const { connectorGateway } = installNxcore()
    await renderPane()

    const connectorsBtn = container.querySelector<HTMLButtonElement>('.agent-connectors-toggle')!
    await act(async () => {
      connectorsBtn.click()
    })
    await flush(20)

    // 打开 Gmail 详情抽屉。
    const modal = document.querySelector('.ui-modal')!
    const gmailCard = [...modal.querySelectorAll<HTMLElement>('.op-conn-card')]
      .find((card) => card.textContent?.includes('Gmail'))!
    await act(async () => {
      gmailCard.click()
    })
    await flush(2)

    const drawer = document.querySelector('.op-drawer')
    expect(drawer, '弹窗内应打开详情抽屉').not.toBeNull()
    expect(drawer!.textContent).toContain('Gmail')

    // 未连接状态 →「连接」按钮 → 发起 Nango 授权。
    const connectBtn = [...drawer!.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent === '连接')
    expect(connectBtn, '抽屉应有「连接」按钮').not.toBeNull()
    await act(async () => {
      connectBtn!.click()
    })
    await flush(2)
    expect(connectorGateway.startAuthorization).toHaveBeenCalledWith('gmail')
  })

  it('弹窗内可开启已授权未开启的连接（移除墓碑）', async () => {
    const { connectorGateway } = installNxcore({
      connections: [{ provider: 'gmail', service: 'gmail', connectionName: 'me@gmail.com' }],
    })
    await renderPane()

    const connectorsBtn = container.querySelector<HTMLButtonElement>('.agent-connectors-toggle')!
    await act(async () => {
      connectorsBtn.click()
    })
    await flush(20)

    const modal = document.querySelector('.ui-modal')!
    const gmailCard = [...modal.querySelectorAll<HTMLElement>('.op-conn-card')]
      .find((card) => card.textContent?.includes('Gmail'))!
    await act(async () => {
      gmailCard.click()
    })
    await flush(2)

    const drawer = document.querySelector('.op-drawer')!
    expect(drawer!.textContent).toContain('已开启账号')
    const offBtn = [...drawer.querySelectorAll<HTMLButtonElement>('.op-conn-account-off')]
      .find((btn) => btn.textContent === '关闭')
    expect(offBtn, '已连接账号应有「关闭」按钮').not.toBeNull()
    await act(async () => {
      offBtn!.click()
    })
    await flush(2)
    expect(connectorGateway.purgeConnection).toHaveBeenCalledWith('gmail:me@gmail.com')
  })
})
