// @vitest-environment happy-dom
/**
 * 用户消息操作行回归测试（复制 / 重新发送）。
 *
 * 锁定三件事：
 * ① 复制与重新发送按钮在气泡**下方**的操作行里（不再浮在气泡左侧）；
 * ② 复制可反复点击：每次都写剪贴板，图标始终保持复制不变（无勾号切换）；
 * ③ 重新发送把该消息原文 + runId 交给 onRetryPrompt（以 replace 语义重跑），
 *    带附件占位符（[附件：…]）的消息不可重发。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatView } from '../src/renderer/src/components/agent/AgentChatView'
import type { DisplayAgentMessage } from '../src/renderer/src/components/agent/useAgentSession'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-04T06:00:00.000Z'

function userMessage(over: Partial<DisplayAgentMessage> & { id: string; runId: string }): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    role: 'user',
    authorAgentId: null,
    content: '帮我整理这段会议纪要',
    createdAt: ISO,
    ...over,
  }
}

function assistantMessage(over: Partial<DisplayAgentMessage> & { id: string; runId: string }): DisplayAgentMessage {
  return {
    sessionId: 'session-1',
    role: 'assistant',
    authorAgentId: null,
    content: '好的，已整理完成。',
    createdAt: ISO,
    ...over,
  }
}

interface MountOptions {
  messages: DisplayAgentMessage[]
  runCompletedAtByRun?: Record<string, string>
}

let container: HTMLDivElement
let root: Root | null = null
let retryPrompt: ReturnType<typeof vi.fn>
let clipboardWrites: string[]

function baseProps(over: Record<string, unknown> = {}) {
  return {
    activeRunId: null,
    agentIdByRun: {},
    agentNamesById: {},
    activityByRun: {},
    availableRooms: [],
    composer: null,
    currentSessionId: 'session-1',
    draftHasContent: false,
    error: null,
    loading: false,
    interruptedRunIds: new Set<string>(),
    cancelledRunIds: new Set<string>(),
    onRejectDocumentIntent: () => undefined,
    onRetryError: () => undefined,
    onRetryPrompt: retryPrompt,
    onOpenMention: () => undefined,
    onOpenSessionLink: () => undefined,
    onSelectPrompt: () => undefined,
    onSelectRoom: async () => undefined,
    pendingNavigationByRun: {},
    reasoningByRun: {},
    resolvingApprovalIds: new Set<string>(),
    runCompletedAtByRun: {},
    runStartedAtByRun: {},
    scopeReady: true,
    sessionLinks: [],
    submitting: false,
    toolCallsByRun: {},
    ...over,
  }
}

async function renderView(options: MountOptions): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <AgentChatView
        {...baseProps({
          messages: options.messages,
          runCompletedAtByRun: options.runCompletedAtByRun ?? {},
        })}
      />,
    )
  })
}

/** 找到某条用户消息的操作行（气泡下方）。 */
function userActionsRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.agent-user-turn .agent-user-actions')
}

function actionButtons(): HTMLButtonElement[] {
  return [...(userActionsRow()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
}

function resendButton(): HTMLButtonElement | undefined {
  return actionButtons().find((button) => button.getAttribute('aria-label') === '重新发送')
}

function copyButton(): HTMLButtonElement | undefined {
  return actionButtons().find((button) => button.getAttribute('aria-label') === '复制提问')
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  retryPrompt = vi.fn()
  clipboardWrites = []
  ;(window as unknown as { nxcore?: unknown }).nxcore = {
    clipboard: {
      writeText: (text: string) => {
        clipboardWrites.push(text)
      },
    },
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('用户消息操作行（复制 / 重新发送）', () => {
  it('按钮渲染在气泡下方的操作行里，悬浮区域包住气泡与按钮', async () => {
    await renderView({
      messages: [
        userMessage({ id: 'u1', runId: 'run-1' }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    const turn = container.querySelector<HTMLElement>('.agent-user-turn')
    expect(turn).not.toBeNull()
    expect(turn!.querySelector('.agent-message[data-role="user"]')).not.toBeNull()
    expect(userActionsRow()).not.toBeNull()
    expect(copyButton()).toBeTruthy()
    expect(resendButton()).toBeTruthy()
    // 操作行在气泡之后（DOM 顺序 = 视觉下方）。
    const bubble = turn!.querySelector('.agent-message')!
    expect(userActionsRow()!.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('复制可反复点击：每次都写剪贴板，图标始终保持复制不变', async () => {
    await renderView({
      messages: [
        userMessage({ id: 'u1', runId: 'run-1' }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    const copy = copyButton()!
    await act(async () => { copy.click() })
    expect(clipboardWrites).toEqual(['帮我整理这段会议纪要'])
    // 无勾号切换：按钮不携带 data-copied 状态，可无限次重复点击。
    expect(copy.hasAttribute('data-copied')).toBe(false)

    await act(async () => { copy.click() })
    expect(clipboardWrites).toEqual(['帮我整理这段会议纪要', '帮我整理这段会议纪要'])
    expect(copy.hasAttribute('data-copied')).toBe(false)
  })

  it('点击复制后操作行仍位于 hover 容器内，无强制显示的 data 属性', async () => {
    await renderView({
      messages: [
        userMessage({ id: 'u1', runId: 'run-1' }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    const copy = copyButton()!
    await act(async () => { copy.click() })
    // 真实浏览器里鼠标点击会让按钮持有 DOM 焦点（这正是旧 :focus-within
    // 规则导致「移开鼠标也不消失」的原因）。组件层面保证：操作行位于
    // hover 容器（.agent-user-turn）内，按钮上没有任何强制显示的 data
    // 属性——显隐完全交给 CSS 的 :hover / :has(:focus-visible)。
    const row = userActionsRow()!
    expect(row.closest('.agent-user-turn')).not.toBeNull()
    expect([...row.attributes].some((attr) => attr.name.startsWith('data-'))).toBe(false)
  })

  it('重新发送把消息原文与 runId 交给 onRetryPrompt', async () => {
    await renderView({
      messages: [
        userMessage({ id: 'u1', runId: 'run-1' }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    await act(async () => { resendButton()!.click() })
    expect(retryPrompt).toHaveBeenCalledTimes(1)
    expect(retryPrompt).toHaveBeenCalledWith('帮我整理这段会议纪要', 'run-1')
  })

  it('带附件占位符的消息禁用重新发送，复制仍可用', async () => {
    await renderView({
      messages: [
        userMessage({ id: 'u1', runId: 'run-1', content: '看看这个\n\n[附件：报告.docx]' }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    expect(resendButton()!.disabled).toBe(true)
    await act(async () => { copyButton()!.click() })
    expect(clipboardWrites).toEqual(['看看这个\n\n[附件：报告.docx]'])
  })

  it('纯批注消息（无气泡）不渲染操作行', async () => {
    await renderView({
      messages: [
        userMessage({
          id: 'u1',
          runId: 'run-1',
          content: '合并后的技术指令',
          noteCards: [{ excerpt: '原文', note: '改一下措辞' }],
          displayContent: '',
        }),
        assistantMessage({ id: 'a1', runId: 'run-1' }),
      ],
      runCompletedAtByRun: { 'run-1': ISO },
    })

    expect(userActionsRow()).toBeNull()
  })
})
