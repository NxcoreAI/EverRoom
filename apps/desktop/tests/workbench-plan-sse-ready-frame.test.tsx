// @vitest-environment happy-dom
/**
 * 回归：点工作空间「计划」→「工作空间暂时无法显示
 * Cannot read properties of undefined (reading 'status')」（2026-11-05）。
 *
 * 根因：gateway /v1/plan/stream 连接建立即推 `event: ready` 帧
 * （data: {"workspaceId":...}，无 item）；主进程桥曾不区分事件类型把任何
 * data 帧原样转发成 plan:changed，渲染层 listener(payload.item) 收到
 * undefined，被 upsert 进看板数组后在 groupPlanItems/工具栏过滤器上崩。
 *
 * 本测试按真实时序模拟：订阅建立即送达无 item 的 ready 帧。
 * 数据形状来自真实 gateway（/v1/files/catalog、/v1/agent/sessions、
 * /v1/plan/items、activities、insight），渲染整个 WorkspaceTabHost。
 */
import type { AgentSession, AgentWorkspace, FileCatalogDto } from '@nxcore/agent-contract'
import type { FileCatalogDto as CatalogDto } from '../src/shared/ingest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceTabHost } from '../src/renderer/src/workbench/shell/WorkspaceTabHost'
import type { WorkspaceTab } from '../src/renderer/src/workbench/types'
import { useWorkbenchStore } from '../src/renderer/src/workbench/state/store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-04T13:55:00.000Z'
const WS = '4912f23c-260f-4e64-abb8-4e52741a15a3'

function makeWorkspace(): AgentWorkspace {
  return {
    id: WS,
    name: '测试空间',
    description: null,
    goals: [],
    path: null,
    kind: 'custom' as const,
    createdAt: ISO,
    updatedAt: ISO,
    lastOpenedAt: ISO,
  }
}

function makeSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    workspaceId: WS,
    roomId: null,
    pageLabel: 'Agent',
    runtimeId: 'main',
    title: `会话 ${id.slice(0, 6)}`,
    status: 'idle' as const,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

/** 真实文件库条目（14 条，含 manual-upload 的 .html / failed 状态条目）。 */
function makeCatalogs(): CatalogDto[] {
  return [
    ['示例-月度支出统计.xlsx', 'agent-generated'],
    ['飞书工作信息汇总-李展萍-20261104.pdf', 'agent-generated'],
    ['最简单的PDF.pdf', 'agent-generated'],
    ['最简单的PDF.docx', 'agent-generated'],
    ['《就业推荐表》院系推荐意见模板.doc', 'manual-upload', 'failed'],
    ['nexwing-radial-funnel.html', 'manual-upload'],
    ['谢国新的使用说明书.docx', 'agent-generated'],
    ['ARM AI随身硬件 — Pre-Seed Pitch Deck.pptx', 'manual-upload'],
    ['2027届毕业生就业推荐表模板（定）.docx', 'manual-upload'],
    ['谢国新的使用说明书.pdf', 'manual-upload'],
  ].map(([name, kind, state], index) => ({
    id: `file-${String(index).padStart(4, '0')}`,
    originalName: name as string,
    displayName: null,
    sharedTitle: name as string,
    sourceKind: kind as CatalogDto['sourceKind'],
    sourceLabel: kind === 'manual-upload' ? '本地上传' : 'Agent 生成',
    relativePath: null,
    provider: null,
    bytes: 12_800,
    dataType: null,
    agentCategory: null,
    summary: null,
    tags: [],
    processingState: (state ?? 'ready') as CatalogDto['processingState'],
    clusterId: null,
    contentHash: 'a'.repeat(64),
    currentVersionId: null,
    parsed: state !== 'failed',
    updatedAt: ISO,
    workspaceId: WS,
  }))
}

function installBridge() {
  const sessions = [
    makeSession('6392539b-e740-4d56-aace-93bc865c6869', { title: '李展萍飞书工作信息汇总' }),
    makeSession('69f9b046-5907-4214-9436-cd1a65d6039f', {
      title: '制作最简单的PDF文件',
      status: 'interrupted' as const,
      updatedAt: '2026-11-05T05:18:47.283Z',
    }),
    makeSession('18dd88ac-1111-4111-8111-111111111111', { title: '就业推荐表奖学金模板段落含义解读' }),
    makeSession('f1af083d-2222-4222-8222-222222222222', { title: '我是谁', status: 'interrupted' as const }),
  ]
  const nxcore = {
    agent: {
      listSessions: vi.fn().mockResolvedValue(sessions),
      createSession: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockImplementation(async (sessionId: string) => ({
        session: sessions.find((s) => s.id === sessionId) ?? sessions[0],
        messages: [
          {
            id: 'msg-user-1',
            sessionId,
            runId: 'run-1',
            role: 'user',
            authorAgentId: null,
            content: '合并文案',
            createdAt: ISO,
            noteCards: [{ excerpt: '2026-03-06 办公用品', note: '这有多少钱', title: '示例-月度支出统计.xlsx' }],
            displayContent: '',
          },
          {
            id: 'msg-assistant-1',
            sessionId,
            runId: 'run-1',
            role: 'assistant',
            authorAgentId: 'main',
            content: '这是回复内容',
            createdAt: ISO,
          },
        ],
        activeRun: null,
        lastEventSeq: 3,
      })),
      getEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
      getPermissionMode: vi.fn().mockResolvedValue(null),
      startRun: vi.fn(),
      selectSession: vi.fn(),
      setSessionThinkingLevel: vi.fn(),
      updateSession: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      cancelRun: vi.fn(),
      createSession: vi.fn(),
      createSessionLink: vi.fn(),
      deleteSession: vi.fn(),
      generateSessionTitle: vi.fn(),
      markSessionLinkReturned: vi.fn(),
      resolveApproval: vi.fn(),
      setPermissionMode: vi.fn(),
      setThinkingLevel: vi.fn(),
      submitPendingIntent: vi.fn(),
    },
    plan: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      assign: vi.fn(),
      remove: vi.fn(),
      events: vi.fn().mockResolvedValue({ events: [] }),
      batch: vi.fn(),
      claimPackage: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      // 复现真实时序：gateway SSE 连接建立即推 `event: ready` 帧
      // （data: {"workspaceId":...}，无 item），主进程桥不区分事件类型原样
      // 转发成 plan:changed → 渲染层 listener(payload.item) = listener(undefined)。
      onChanged: vi.fn((listener: (payload: { workspaceId: string; item?: unknown }) => void) => {
        listener({ workspaceId: WS })
        return () => {}
      }),
    },
    workspace: {
      list: vi.fn().mockResolvedValue([makeWorkspace()]),
      activities: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'file:file-0000',
            kind: 'output',
            at: '2026-11-05T05:18:47.283Z',
            segments: [{ text: '生成了 ' }, { fileId: 'file-0000' }],
          },
          {
            id: 'run:6a0b104a-1',
            kind: 'work-done',
            at: '2026-11-04T13:55:03.588Z',
            segments: [{ text: '结束了工作 ' }, { sessionId: '69f9b046-5907-4214-9436-cd1a65d6039f' }],
          },
          {
            id: 'run:6a0b104a-2',
            kind: 'work-run',
            at: '2026-11-04T13:53:10.302Z',
            segments: [{ text: '开始了工作 ' }, { sessionId: '69f9b046-5907-4214-9436-cd1a65d6039f' }],
          },
        ],
        nextBeforeAt: '2026-11-04T13:06:27.517Z',
        nextBeforeId: 'file:file-0002',
      }),
    },
    workspaceInsight: {
      get: vi.fn().mockResolvedValue({
        summary: '当前工作区有8项任务完成，资料库含4份材料、8份产物，整体进展稳定。',
        advice: [
          { text: '检查《制作最简单的PDF文件》的图表展示效果是否符合预期', sessionId: '69f9b046-5907-4214-9436-cd1a65d6039f' },
          { text: '确认《李展萍飞书工作信息汇总》的PDF是否需进一步分发或归档', sessionId: '6392539b-e740-4d56-aace-93bc865c6869' },
        ],
        model: 'memory-slot',
        cached: false,
      }),
    },
    files: {
      list: vi.fn().mockResolvedValue({ items: makeCatalogs(), total: 10 }),
      pickAndImport: vi.fn().mockResolvedValue([]),
      openOriginal: vi.fn().mockResolvedValue({ openedWith: 'office', instanceId: 'x', kind: 'doc', title: 'x' }),
    },
    office: {
      onAgentFile: vi.fn(() => () => {}),
      closeInstance: vi.fn().mockResolvedValue(true),
    },
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return { nxcore, sessions }
}

let container: HTMLDivElement
let root: Root

async function flush(rounds = 15, step = 10): Promise<void> {
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ;(window as unknown as { nxcore: unknown }).nxcore = undefined
  useWorkbenchStore.setState({
    workspaces: [],
    sessions: [],
    tabs: [],
    activeTabId: null,
    error: null,
  })
})

describe('WorkspaceTabHost plan view render', () => {
  it('renders the plan page without crashing (Cannot read status)', async () => {
    const { sessions } = installBridge()
    useWorkbenchStore.setState({
      workspaces: [makeWorkspace()],
      sessions,
      tabs: [{
        id: 'tab-1',
        kind: 'workspace' as const,
        workspaceId: WS,
        view: { kind: 'page' as const, page: 'plan' as const },
      }] as WorkspaceTab[],
      activeTabId: 'tab-1',
      error: null,
    })

    let caught: unknown = null
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error && /reading 'status'/.test(arg.message)) caught = arg
        if (typeof arg === 'string' && /reading 'status'/.test(arg)) {
          caught = new Error(arg)
        }
      }
      originalError(...args)
    }
    try {
      await act(async () => {
        root.render(
          <WorkspaceTabHost
            tab={{
              id: 'tab-1',
              kind: 'workspace',
              workspaceId: WS,
              view: { kind: 'page', page: 'plan' },
            }}
            active
          />,
        )
      })
      await flush()
    } finally {
      console.error = originalError
    }

    expect(caught).toBeNull()
    expect(container.textContent).toContain('计划')
  })

  it('survives switching from a session view to the plan page', async () => {
    // 真实操作序列：用户先在会话里聊天（ConversationPane 挂载、useAgentSession 有状态），
    // 再点侧栏「计划」。切换是同一次 store 更新里 view 的替换。
    const { sessions } = installBridge()
    useWorkbenchStore.setState({
      workspaces: [makeWorkspace()],
      sessions,
      tabs: [{
        id: 'tab-1',
        kind: 'workspace' as const,
        workspaceId: WS,
        view: { kind: 'session' as const, sessionId: sessions[0].id },
      }] as WorkspaceTab[],
      activeTabId: 'tab-1',
      error: null,
    })

    const tab = () => (useWorkbenchStore.getState().tabs.find((t) => t.id === 'tab-1')) as WorkspaceTab
    let caught: unknown = null
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error && /reading 'status'/.test(arg.message)) caught = arg
        if (typeof arg === 'string' && /reading 'status'/.test(arg)) caught = new Error(arg)
      }
      originalError(...args)
    }
    try {
      await act(async () => {
        root.render(<WorkspaceTabHost tab={tab()} active />)
      })
      await flush()
      // 切到计划页（侧栏按钮的实际效果：setWorkspaceView）
      await act(async () => {
        useWorkbenchStore.setState({
          tabs: [{ id: 'home', kind: 'home' as const, page: 'recent' as const }, {
            id: 'tab-1',
            kind: 'workspace' as const,
            workspaceId: WS,
            view: { kind: 'page' as const, page: 'plan' as const },
          }] as WorkspaceTab[],
        })
      })
      await act(async () => {
        root.render(<WorkspaceTabHost tab={tab()} active />)
      })
      await flush()
    } finally {
      console.error = originalError
    }

    expect(caught).toBeNull()
    expect(container.textContent).toContain('计划')
  })
})
