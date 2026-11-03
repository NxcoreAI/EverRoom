// @vitest-environment happy-dom
/**
 * 回归（数据驱动）：用真实库导出的中断会话 fixture 驱动完整恢复链路。
 *
 * fixture 来源：用户实际遇到的场景——run 进行 19 分钟、产出 5216 个事件
 * （5030 条 reasoning.delta、35 次工具调用）后被 gateway-restarted 打断。
 * agent_messages 里只有 user 消息（无 message.completed → 无 assistant 落库）。
 *
 * 该测试保证：无论事件量多大，恢复后的 UI 状态里都能取回工具与推理。
 */
import type {
  AgentEvent,
  AgentSession,
  AgentSessionSnapshot,
} from '@nxcore/agent-contract'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentSession } from '../src/renderer/src/components/agent/useAgentSession'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Fixture {
  snapshot: AgentSessionSnapshot
  events: AgentEvent[]
}

const FIXTURE_PATH = resolve(__dirname, 'fixtures/interrupted-session-real.json')

function fakeGateway(fixture: Fixture) {
  const api = {
    listSessions: vi.fn(async () => [fixture.snapshot.session as AgentSession]),
    createSession: vi.fn(async () => fixture.snapshot.session as AgentSession),
    getSession: vi.fn(async () => fixture.snapshot),
    getEvents: vi.fn(async (_sessionId: string, runId: string) =>
      fixture.events.filter((event) => event.runId === runId)),
    listSessionLinks: vi.fn(async () => []),
    getPermissionMode: vi.fn(async () => ({
      mode: 'ask_before_write' as const,
      available: ['ask_before_write', 'accept_edits', 'auto'] as const,
      channelAgentId: null,
    })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    updateSession: vi.fn(async () => fixture.snapshot.session as AgentSession),
  }
  return { api }
}

type Hook = ReturnType<typeof useAgentSession>

let container: HTMLDivElement
let root: Root
let fixture: Fixture
let gateway: ReturnType<typeof fakeGateway>

beforeEach(() => {
  fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture
  gateway = fakeGateway(fixture)
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent: gateway.api }
  window.localStorage.clear()
  window.localStorage.setItem(
    'nxcore-ce:agent-session:v2',
    JSON.stringify({ sessionId: fixture.snapshot.session.id }),
  )
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

describe('中断会话恢复（真实数据重放）', () => {
  it('5216 个事件的中断会话：推理、工具调用、终态全部还原', async () => {
    const runId = fixture.snapshot.messages[0]!.runId
    let current: Hook | null = null
    function Probe() {
      current = useAgentSession('Agent', null, [], {})
      return <div />
    }
    await act(async () => {
      root.render(<Probe />)
    })
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const hook = current!
    expect(hook.scopeReady).toBe(true)

    // assistant 占位消息存在（渲染挂载点）。
    expect(hook.messages.some((message) => (
      message.runId === runId && message.role === 'assistant'
    ))).toBe(true)

    // 35 次工具调用还原（去重后 5 种工具名：bash/web_search/read 等）。
    const toolNames = new Set((hook.toolCallsByRun[runId] ?? []).map((tool) => tool.name))
    expect(toolNames.size).toBeGreaterThanOrEqual(5)
    expect((hook.toolCallsByRun[runId] ?? []).length).toBeGreaterThanOrEqual(30)

    // 5030 条推理 delta 合并有内容。
    expect((hook.reasoningByRun[runId] ?? '').length).toBeGreaterThan(100)

    // 终态时间还原（卡片静止，不转圈）。
    expect(hook.runCompletedAtByRun[runId]).toBeTruthy()
    expect(hook.interruptedRunIds.has(runId)).toBe(true)
  })
})
