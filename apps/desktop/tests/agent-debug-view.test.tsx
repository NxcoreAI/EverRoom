// @vitest-environment happy-dom
/**
 * 「Agent 调试」覆盖层回归：
 *
 * 1) 左栏按内置 / 子 Agent / 外部连接 / 本地 Agent 分组，默认选中第一个 Agent；
 * 2) 选中 Agent 后展示系统上下文（模型、系统提示词）与工具上下文（实际挂载的工具）；
 * 3) 外部连接复用旧调试面板的数据面（回写提交 + 最近调用）；
 * 4) Esc / 返回按钮关闭面板。
 *
 * 只 mock preload 桥 window.nxcore，真实渲染 AgentDebugView 组件树。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../src/renderer/src/i18n/i18next'
import { AgentDebugView } from '../src/renderer/src/office-proto/AgentDebugView'
import { AgentView } from '../src/renderer/src/office-proto/pages/AgentView'
import type { AgentDebugAgentDetail, AgentDebugAgentSummary } from '../src/shared/agent-debug'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GENERATED_AT = '2026-10-29T08:00:00.000Z'

const MAIN_SUMMARY: AgentDebugAgentSummary = {
  id: 'main',
  kind: 'builtin',
  name: 'Main Agent',
  description: '处理用户对话与文档',
  runtime: 'pi',
  runtimeRole: 'user-facing',
  model: 'openai/gpt-5',
  state: 'idle',
  activeRunCount: 0,
  toolCount: 2,
  skillCount: 1,
  revisionId: null,
  updatedAt: GENERATED_AT,
}

const MAIN_DETAIL: AgentDebugAgentDetail = {
  ...MAIN_SUMMARY,
  systemPrompt: '你是 Main Agent，负责文档与 Office 产物。',
  skills: [{ name: 'document-export', path: './skills/document-export', prompt: '# document-export' }],
  tools: [
    { name: 'read', label: 'Read', description: '读取文件内容', source: 'builtin' },
    { name: 'document_read', label: '读取文档', description: '读取文档正文与 block', source: 'custom' },
  ],
  mcpServers: ['everroom-connectors'],
  promptGuidelines: ['外部服务请求优先使用 connector 工具。'],
  modelInfo: {
    provider: 'openai',
    model: 'gpt-5',
    baseUrl: 'https://api.example.test',
    api: 'openai-responses',
    reasoning: 'medium',
    temperature: 0.2,
    maxTokens: 8192,
    contextWindow: 128_000,
  },
  capabilities: { streaming: true, reasoning: true, tools: true, steering: true, resume: false },
  limits: { maxToolCallsPerRun: null, maxToolResultChars: null, runContextGuard: null },
  policy: null,
  subagent: null,
  recentActivity: [{
    id: 'run-1',
    task: '整理今天的会议记录',
    status: 'completed',
    startedAt: '2026-10-29T01:00:00.000Z',
    completedAt: '2026-10-29T01:02:00.000Z',
    pageLabel: '首页',
    source: null,
  }],
}

const SUBAGENT_SUMMARY: AgentDebugAgentSummary = {
  id: 'doc-writer',
  kind: 'subagent',
  name: 'Doc Writer',
  description: '文档写作子 Agent',
  runtime: 'pi',
  runtimeRole: 'internal',
  model: 'openai/gpt-5-mini',
  state: 'idle',
  activeRunCount: 0,
  toolCount: 1,
  skillCount: 0,
  revisionId: 'rev-1',
  updatedAt: GENERATED_AT,
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

function installNxcore(overrides: Record<string, unknown>) {
  const nxcore = {
    platform: 'darwin',
    ...overrides,
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

function agentDebugMock(
  detail: AgentDebugAgentDetail,
  summaries: AgentDebugAgentSummary[],
  usage?: unknown,
) {
  return {
    listAgents: vi.fn().mockResolvedValue({ agents: summaries, generatedAt: GENERATED_AT }),
    getAgent: vi.fn().mockResolvedValue({ agent: detail, generatedAt: GENERATED_AT }),
    listUsage: vi.fn().mockResolvedValue(usage ?? {
      agentId: detail.id,
      records: [],
      totals: { runs: 0, inputTokens: 0, outputTokens: 0 },
      generatedAt: GENERATED_AT,
    }),
    openWindow: vi.fn().mockResolvedValue(undefined),
  }
}

const MAIN_USAGE = {
  agentId: 'main',
  records: [
    {
      id: 'run-1',
      kind: 'run',
      sessionId: 'sess-1',
      sessionTitle: '发布计划',
      task: '把本周会议纪要整理成发布计划文档',
      status: 'running',
      roomId: null,
      pageLabel: '首页',
      startedAt: '2026-10-29T07:52:00.000Z',
      completedAt: null,
      durationMs: 1_200_000,
      toolCalls: 7,
      inputTokens: 12_000,
      outputTokens: 3_400,
      cacheReadTokens: 0,
      error: null,
      source: null,
      revisionId: null,
    },
    {
      id: 'run-0',
      kind: 'run',
      sessionId: 'sess-1',
      sessionTitle: '发布计划',
      task: '生成 Q4 复盘 PPT 提纲',
      status: 'completed',
      roomId: null,
      pageLabel: '首页',
      startedAt: '2026-10-29T06:10:00.000Z',
      completedAt: '2026-10-29T06:18:00.000Z',
      durationMs: 480_000,
      toolCalls: 3,
      inputTokens: 8_000,
      outputTokens: 1_200,
      cacheReadTokens: 0,
      error: null,
      source: null,
      revisionId: null,
    },
  ],
  totals: { runs: 2, inputTokens: 20_000, outputTokens: 4_600 },
  generatedAt: GENERATED_AT,
}

function findButton(textContent: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === textContent) as HTMLButtonElement | undefined
}

beforeEach(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500)
      i18n.once('initialized', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('Agent 调试覆盖层', () => {
  it('默认选中第一个内置 Agent，并展示系统上下文与工具上下文', async () => {
    installNxcore({
      agentDebug: agentDebugMock(MAIN_DETAIL, [MAIN_SUMMARY, SUBAGENT_SUMMARY]),
      agentAccess: { listConnections: vi.fn().mockResolvedValue({ connections: [] }) },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })

    await act(async () => {
      root.render(<AgentDebugView onClose={() => undefined} />)
    })
    await flush()

    // 左栏分组与条目
    expect(container.textContent).toContain('内置 Agent')
    expect(container.textContent).toContain('子 Agent')
    expect(container.querySelectorAll('.op-agent-debug-item')).toHaveLength(2)

    // 系统上下文：模型 + SYSTEM.md 原文
    expect(container.textContent).toContain('Main Agent')
    expect(container.textContent).toContain('gpt-5')
    expect(container.textContent).toContain('你是 Main Agent，负责文档与 Office 产物。')

    // 切到工具分段：展示实际挂载的工具与 MCP 服务器
    const toolsTab = [...container.querySelectorAll('.op-agent-debug-tabs button')]
      .find((button) => button.textContent === '工具') as HTMLButtonElement
    await act(async () => { toolsTab.click() })
    await flush(2)

    expect(container.textContent).toContain('document_read')
    expect(container.textContent).toContain('读取文档正文与 block')
    expect(container.textContent).toContain('everroom-connectors')
  })

  it('外部连接展示旧调试面板数据（回写提交 + 最近调用）', async () => {
    installNxcore({
      agentDebug: {
        listAgents: vi.fn().mockResolvedValue({ agents: [], generatedAt: GENERATED_AT }),
        getAgent: vi.fn(),
      },
      agentAccess: {
        listConnections: vi.fn().mockResolvedValue({
          connections: [{
            id: 'conn-1',
            name: 'Claude Code（本机）',
            tool: 'claude-code',
            status: 'active',
            scopes: { roomIds: 'all', capabilities: ['read_documents', 'write_candidates'], writebackRoomId: null },
            tokenPrefix: 'evr_abc123',
            createdAt: GENERATED_AT,
            updatedAt: GENERATED_AT,
            lastSeenAt: GENERATED_AT,
            revokedAt: null,
            exampleQueryAt: null,
          }],
        }),
        submissions: vi.fn().mockResolvedValue({
          submissions: [{
            clientSubmissionId: 'sub-1',
            status: 'received',
            duplicateCount: 2,
            createdAt: GENERATED_AT,
          }],
        }),
        events: vi.fn().mockResolvedValue({
          events: [{
            kind: 'call',
            tool: 'everroom_search',
            status: 'ok',
            durationMs: 42,
            createdAt: GENERATED_AT,
          }],
        }),
      },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })

    await act(async () => {
      root.render(<AgentDebugView onClose={() => undefined} />)
    })
    await flush()

    expect(container.textContent).toContain('Claude Code（本机）')
    expect(container.textContent).toContain('回写提交')
    expect(container.textContent).toContain('sub-1')
    expect(container.textContent).toContain('call · everroom_search')
  })

  it('使用记录分段展示每次运行的任务、工具次数与 token', async () => {
    installNxcore({
      agentDebug: agentDebugMock(MAIN_DETAIL, [MAIN_SUMMARY], MAIN_USAGE),
      agentAccess: { listConnections: vi.fn().mockResolvedValue({ connections: [] }) },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })

    await act(async () => {
      root.render(<AgentDebugView onClose={() => undefined} />)
    })
    await flush()

    const usageTab = [...container.querySelectorAll('.op-agent-debug-tabs button')]
      .find((button) => button.textContent === '使用记录') as HTMLButtonElement
    expect(usageTab).toBeTruthy()
    await act(async () => { usageTab.click() })
    await flush(2)

    expect(container.textContent).toContain('把本周会议纪要整理成发布计划文档')
    expect(container.textContent).toContain('7 次工具调用')
    expect(container.textContent).toContain('12.0k in / 3.4k out')
    expect(container.textContent).toContain('生成 Q4 复盘 PPT 提纲')
    expect(container.textContent).toContain('20.0k tokens')
  })

  it('运行中的 Agent 置顶显示并展示当前任务与已运行时长', async () => {
    const runningSummary: AgentDebugAgentSummary = {
      ...MAIN_SUMMARY,
      state: 'running',
      activeRunCount: 1,
      currentRun: {
        id: 'run-live',
        task: '整理今天的会议记录',
        status: 'running',
        startedAt: new Date(Date.now() - 65_000).toISOString(),
        completedAt: null,
        pageLabel: '首页',
        source: null,
      },
    }
    installNxcore({
      agentDebug: agentDebugMock(MAIN_DETAIL, [runningSummary]),
      agentAccess: { listConnections: vi.fn().mockResolvedValue({ connections: [] }) },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })

    await act(async () => {
      root.render(<AgentDebugView onClose={() => undefined} />)
    })
    await flush()

    expect(container.textContent).toContain('运行中')
    expect(container.textContent).toContain('整理今天的会议记录')
    expect(container.querySelectorAll('.op-agent-debug-group.is-live')).toHaveLength(1)
  })

  it('Agent 页「调试」按钮打开独立窗口（agentDebug.openWindow）', async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined)
    installNxcore({
      agentDebug: { openWindow },
      agentAccess: { listConnections: vi.fn().mockResolvedValue({ connections: [] }) },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })

    await act(async () => {
      root.render(<AgentView onOpenFile={() => undefined} onToast={() => undefined} />)
    })
    await flush(2)

    const debugButton = findButton('调试')
    expect(debugButton).toBeTruthy()
    await act(async () => { debugButton?.click() })
    await flush(2)

    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it('Esc 与返回按钮都能关闭面板', async () => {
    installNxcore({
      agentDebug: agentDebugMock(MAIN_DETAIL, [MAIN_SUMMARY]),
      agentAccess: { listConnections: vi.fn().mockResolvedValue({ connections: [] }) },
      agent: { discoverLocalAgents: vi.fn().mockResolvedValue([]) },
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<AgentDebugView onClose={onClose} />)
    })
    await flush()

    await act(async () => {
      findButton('返回')?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})