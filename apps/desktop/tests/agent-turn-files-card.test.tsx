// @vitest-environment happy-dom
/**
 * 「本轮产生的文件」卡条组件测试（AgentChatView 集成）。
 *
 * 锁定三件事：
 * ① 生成类工具（office_create 等）转终态后，文件卡出现在 assistant 正文下方；
 * ② 点击文件卡调用 files.openOriginal（可编辑打开）；
 * ③ slides_draft 的成品不出卡（SlidesProgressCard 专属车道，避免重复）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatView } from '../src/renderer/src/components/agent/AgentChatView'
import type { DisplayAgentMessage } from '../src/renderer/src/components/agent/useAgentSession'
import type { DisplayAgentToolCall } from '../src/renderer/src/components/agent/agentRunActivity'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-04T06:00:00.000Z'

function assistantMessage(runId: string): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    runId,
    role: 'assistant',
    authorAgentId: null,
    content: '报告已生成，请查收。',
    createdAt: ISO,
  }
}

function userMessage(runId: string): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    runId,
    role: 'user',
    authorAgentId: null,
    content: '帮我生成一份报告',
    createdAt: ISO,
  }
}

function completedTool(over: Partial<DisplayAgentToolCall> & { id: string; name: string }): DisplayAgentToolCall {
  return {
    runId: 'run-1',
    args: {},
    status: 'completed',
    startedAt: ISO,
    completedAt: ISO,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root | null = null
let openOriginal: ReturnType<typeof vi.fn>

function baseProps(over: Record<string, unknown> = {}) {
  return {
    activeRunId: null,
    agentIdByRun: {},
    agentNamesById: {},
    activityByRun: {},
    composer: null,
    currentSessionId: 'session-1',
    draftHasContent: false,
    error: null,
    loading: false,
    interruptedRunIds: new Set<string>(),
    cancelledRunIds: new Set<string>(),
    onRetryError: () => undefined,
    onRetryPrompt: () => undefined,
    onOpenMention: () => undefined,
    onOpenSessionLink: () => undefined,
    onSelectPrompt: () => undefined,
    pendingNavigationByRun: {},
    reasoningByRun: {},
    resolvingApprovalIds: new Set<string>(),
    runCompletedAtByRun: { 'run-1': ISO },
    runStartedAtByRun: { 'run-1': ISO },
    scopeReady: true,
    sessionLinks: [],
    submitting: false,
    toolCallsByRun: {},
    ...over,
  }
}

async function renderView(over: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<AgentChatView {...baseProps(over)} />)
  })
}

function turnFileButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.agent-turn-file')]
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  openOriginal = vi.fn(() => Promise.resolve({ openedWith: 'in-app' }))
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    clipboard: { writeText: () => undefined },
    files: { openOriginal },
  }
  window.matchMedia = window.matchMedia ?? ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container.remove()
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

describe('AgentTurnFilesCard in AgentChatView', () => {
  it('renders a file card below the assistant message for office_create results', async () => {
    const tool = completedTool({
      id: 'tool-1',
      name: 'office_create',
      result: JSON.stringify({ fileEntryId: 'fe-1', originalName: '季度报告.docx', format: 'docx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    const buttons = turnFileButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toContain('季度报告.docx')
    // 卡片在 assistant 正文下方（同一 turn 容器内、正文之后）。
    const turn = container.querySelector('.agent-assistant-turn')
    expect(turn).not.toBeNull()
    expect(turn!.querySelector('.agent-message')!.compareDocumentPosition(buttons[0]!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders an md file card for markdown_create results', async () => {
    const tool = completedTool({
      id: 'tool-1b',
      name: 'markdown_create',
      result: JSON.stringify({ fileEntryId: 'fe-9', originalName: '会议纪要.md', format: 'md' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    const buttons = turnFileButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toContain('会议纪要.md')
  })

  it('opens the file editable via files.openOriginal on click', async () => {
    const tool = completedTool({
      id: 'tool-2',
      name: 'sheets_create',
      result: JSON.stringify({ fileEntryId: 'fe-2', originalName: '预算.xlsx', format: 'xlsx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    await act(async () => {
      turnFileButtons()[0]!.click()
    })
    expect(openOriginal).toHaveBeenCalledWith('fe-2', '预算.xlsx', undefined, { editable: true })
  })

  it('does not render cards for slides_draft artifacts', async () => {
    const tool = completedTool({
      id: 'tool-3',
      name: 'slides_draft',
      result: JSON.stringify({ status: 'completed', fileEntryId: 'fe-3', fileName: '发布会.pptx' }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    expect(turnFileButtons()).toHaveLength(0)
  })

  it('renders nothing when the run has no file-producing tools', async () => {
    const tool = completedTool({
      id: 'tool-4',
      name: 'web_search',
      result: JSON.stringify({ results: [] }),
    })
    await renderView({
      messages: [userMessage('run-1'), assistantMessage('run-1')],
      toolCallsByRun: { 'run-1': [tool] },
    })
    expect(turnFileButtons()).toHaveLength(0)
  })
})
