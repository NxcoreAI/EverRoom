// @vitest-environment happy-dom
/**
 * 回归：异常中断的 run 在回到会话时必须还原过程（工具调用 + 推理），
 * 而不是只剩一条孤零零的用户消息。
 *
 * 场景（用户实测遇到）：run 进行中网关被外部杀掉 → 网关重启时
 * `initialize()` 把 run 标记为 interrupted、保留全部事件（含 5000+ 条
 * reasoning.delta、tool.*），但 `message.completed` 从未发生 →
 * `agent_messages` 里只有 user 消息。快照里 `activeRun: null`。
 *
 * 恢复链路 useAgentSession.hydrateSnapshot 旧实现只为
 * `snapshot.activeRun` 重建 assistant 占位消息；渲染层（AgentChatView）
 * 完全由 messages 驱动、按 runId 挂 toolCallsByRun / reasoningByRun。
 * 于是中断 run 的事件被拉取、被 reduce，却没有渲染挂载点——表现为
 * 「回到对话什么都没留下：没有工具调用记录，没有推理过程」。
 *
 * 这里用与网关同语义的假网关驱动真实 hook，断言恢复结果。
 */
import type {
  AgentEvent,
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentSession } from '../src/renderer/src/components/agent/useAgentSession'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISO = '2026-11-03T12:16:25.000Z'
const SESSION_ID = 'session-interrupted'
const RUN_ID = 'run-interrupted'

function makeSession(): AgentSession {
  return {
    id: SESSION_ID,
    pageLabel: 'Agent',
    workspaceId: null,
    roomId: null,
    runtimeId: 'rt-main',
    title: '帮我用在飞书找找于我相关的信息，然后整理成一个pdf',
    status: 'interrupted',
    createdAt: ISO,
    updatedAt: ISO,
  }
}

function makeUserMessage(): AgentMessage {
  return {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    role: 'user',
    content: '帮我用在飞书找找于我相关的信息，然后整理成一个pdf',
    createdAt: ISO,
  }
}

/**
 * 与真实中断会话同形状的事件序列（真实库导出样本的最小化）。
 * runId/时间戳可参数化，用于构造「多轮中断」场景。
 */
function makeEvents(runId = RUN_ID, startedAt = ISO): AgentEvent[] {
  return [
    { id: `ev-1-${runId}`, sessionId: SESSION_ID, runId, seq: 1, type: 'run.accepted', occurredAt: startedAt, payload: {} },
    { id: `ev-2-${runId}`, sessionId: SESSION_ID, runId, seq: 2, type: 'run.started', occurredAt: startedAt, payload: {} },
    {
      id: `ev-3-${runId}`, sessionId: SESSION_ID, runId, seq: 3, type: 'reasoning.delta', occurredAt: startedAt,
      payload: { delta: '先搜索飞书联系人' },
    },
    {
      id: `ev-4-${runId}`, sessionId: SESSION_ID, runId, seq: 4, type: 'tool.started', occurredAt: startedAt,
      payload: { toolCallId: 'call-1', name: 'search', args: { query: '谢国新' } },
    },
    {
      id: `ev-5-${runId}`, sessionId: SESSION_ID, runId, seq: 5, type: 'tool.completed', occurredAt: startedAt,
      payload: { toolCallId: 'call-1', name: 'search', content: [{ type: 'text', text: '命中 3 条' }] },
    },
    {
      id: `ev-6-${runId}`, sessionId: SESSION_ID, runId, seq: 6, type: 'reasoning.delta', occurredAt: startedAt,
      payload: { delta: '再整理成 PDF' },
    },
    // 关键：没有 message.completed —— run 在输出正文前被 gateway-restarted 打断。
    { id: `ev-7-${runId}`, sessionId: SESSION_ID, runId, seq: 7, type: 'message.started', occurredAt: startedAt, payload: {} },
    {
      id: `ev-8-${runId}`, sessionId: SESSION_ID, runId, seq: 8, type: 'run.interrupted', occurredAt: startedAt,
      payload: { reason: 'gateway-restarted' },
    },
  ]
}

function fakeGateway() {
  const session = makeSession()
  const messages = [makeUserMessage()]
  const events = makeEvents()

  const snapshotOf = (messageList: AgentMessage[] = messages): AgentSessionSnapshot => ({
    session,
    participants: [],
    activeRun: null,
    messages: [...messageList],
    lastEventSeq: events.length,
  })

  const api = {
    listSessions: vi.fn(async () => [session]),
    createSession: vi.fn(async () => session),
    getSession: vi.fn(async () => snapshotOf()),
    getEvents: vi.fn(async (_sessionId: string, runId: string) =>
      events.filter((event) => event.runId === runId)),
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    updateSession: vi.fn(async () => session),
  }

  return { api, snapshotOf, session }
}

type Hook = ReturnType<typeof useAgentSession>

function harness() {
  let current: Hook | null = null
  function Probe() {
    current = useAgentSession('Agent', {})
    return <div data-testid="probe" />
  }
  return {
    Probe,
    get hook(): Hook {
      if (!current) throw new Error('probe not mounted')
      return current
    },
  }
}

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

let container: HTMLDivElement
let root: Root
let gateway: ReturnType<typeof fakeGateway>

beforeEach(() => {
  gateway = fakeGateway()
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway.api }
  window.localStorage.clear()
  window.localStorage.setItem('nxcore-ce:agent-session:v2', JSON.stringify({ sessionId: SESSION_ID }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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

describe('中断会话恢复', () => {
  it('回到中断的会话时，run 的工具调用与推理过程必须被还原', async () => {
    const probe = harness()
    await act(async () => {
      root.render(<probe.Probe />)
    })
    await flush()

    const hook = probe.hook
    // 前置 sanity：快照恢复完成，事件确实被拉取过。
    expect(hook.scopeReady).toBe(true)
    expect(gateway.api.getEvents).toHaveBeenCalled()

    // ★ 核心断言 1：不能只剩一条 user 消息——必须为中断的 run 重建
    // assistant 占位消息（渲染层以 messages 为唯一驱动）。
    const assistantMessages = hook.messages.filter((message) => (
      message.runId === RUN_ID && message.role === 'assistant'
    ))
    expect(assistantMessages.length).toBeGreaterThan(0)

    // ★ 核心断言 2：中断 run 的推理被还原（reasoningByRun 有内容）。
    expect(hook.reasoningByRun[RUN_ID] ?? '').toContain('先搜索飞书联系人')

    // ★ 核心断言 3：中断 run 的工具调用被还原。
    const tools = hook.toolCallsByRun[RUN_ID] ?? []
    expect(tools.some((tool) => tool.name === 'search')).toBe(true)

    // ★ 核心断言 4：run 终态时间被还原（卡片不再显示「生成中」）。
    expect(hook.runCompletedAtByRun[RUN_ID]).toBeTruthy()
  })

  it('多个中断 run 恢复后必须保持「一问一答」交替排版', async () => {
    // 场景（用户实测）：run 中断 → 用户再发消息 → 又中断 → 反复多次。
    // 所有 run 都没走到 message.completed，assistant 全靠占位消息重建。
    // 旧实现把占位消息追加到列表末尾：重进会话看到「user×N 连排、
    // agent 卡片×N 连排」，像自己连发了几条消息、agent 连跑了几次。
    const later = (minutes: number) => new Date(Date.parse(ISO) + minutes * 60_000).toISOString()
    const runs = ['run-a', 'run-b', 'run-c'].map((runId, index) => ({
      runId,
      startedAt: later(index * 10),
      userText: [`第一条：整理 PDF`, `第二条：请继续工作`, `第三条：再继续`][index],
    }))
    const allEvents = runs.flatMap(({ runId, startedAt }) => makeEvents(runId, startedAt))
    const userMessages: AgentMessage[] = runs.map(({ runId, startedAt, userText }) => ({
      id: `msg-user-${runId}`,
      sessionId: SESSION_ID,
      runId,
      role: 'user',
      content: userText,
      createdAt: startedAt,
    }))
    gateway.api.getEvents.mockImplementation(async (_sessionId: string, runId: string) =>
      allEvents.filter((event) => event.runId === runId))
    gateway.api.getSession.mockImplementation(async () => gateway.snapshotOf(userMessages))

    const probe = harness()
    await act(async () => {
      root.render(<probe.Probe />)
    })
    await flush()

    const messages = probe.hook.messages
    // 占位消息全部重建（3 个 run 各一条 assistant）。
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(3)
    // ★ 交替排版：每条 user 消息的下一条（同 run 视角）必须是 assistant，
    // 不允许两条 user 消息相邻出现。
    for (let index = 0; index < messages.length - 1; index += 1) {
      if (messages[index].role !== 'user') continue
      expect(
        messages[index + 1].role,
        `user "${messages[index].content}" 后面紧跟的必须是 assistant 占位，实际是 ${messages[index + 1].role}`,
      ).toBe('assistant')
    }
    // 顺序总检：user/assistant 严格交替且一一配对到各自 run。
    expect(messages.map((message) => `${message.role}:${message.runId}`)).toEqual([
      'user:run-a', 'assistant:run-a',
      'user:run-b', 'assistant:run-b',
      'user:run-c', 'assistant:run-c',
    ])
  })
})
