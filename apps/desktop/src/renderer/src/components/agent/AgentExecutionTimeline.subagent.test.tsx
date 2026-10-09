import type { AgentEvent, SubagentInvocationEvent, SubagentInvocationNode } from '@nxcore/agent-contract'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
      formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => (
        new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
      ),
    }),
  }
})

import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import { reduceAgentRunActivity } from './agentRunActivity'

const runId = 'run-1'
const invocationId = 'inv-1'

function invocationNode(overrides: Partial<SubagentInvocationNode> = {}): SubagentInvocationNode {
  return {
    id: invocationId,
    agentDefinitionId: 'researcher',
    agentRevisionId: 'revision-1',
    source: 'primary_agent',
    parentSessionId: 'session-1',
    parentRunId: runId,
    task: '调研 EverRoom 架构',
    input: null,
    status: 'running',
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-09-29T10:00:02.000Z',
    startedAt: '2026-09-29T10:00:02.000Z',
    completedAt: null,
    agentName: 'Researcher',
    ...overrides,
  }
}

function invocationEvent(seq: number, type: SubagentInvocationEvent['type'], payload: unknown = {}): SubagentInvocationEvent {
  return { id: `evt-${seq}`, invocationId, seq, type, payload, occurredAt: new Date(seq * 1_000).toISOString() }
}

const toolEvents: SubagentInvocationEvent[] = [
  invocationEvent(1, 'tool.requested', { toolCallId: 'call-1', name: 'web_search', args: { query: 'EverRoom 架构' } }),
  invocationEvent(2, 'tool.started', { toolCallId: 'call-1' }),
  invocationEvent(3, 'tool.completed', { toolCallId: 'call-1', name: 'web_search', result: { results: [1, 2] } }),
  invocationEvent(4, 'tool.requested', { toolCallId: 'call-2', name: 'read_file', args: { path: '/tmp/arch.md' } }),
  invocationEvent(5, 'tool.completed', { toolCallId: 'call-2', name: 'read_file', result: { bytes: 20 } }),
  invocationEvent(6, 'tool.requested', { toolCallId: 'call-3', name: 'wiki_search', args: { query: '迁移' } }),
]

// 主 run 只放一个已完成工具步，让时间线有 runId 且 hasTools 为真。
const mainRunEvents: AgentEvent[] = [
  { id: 'e1', sessionId: 'session-1', runId, seq: 1, type: 'run.started', occurredAt: '2026-09-29T10:00:00.000Z', payload: {} },
  { id: 'e2', sessionId: 'session-1', runId, seq: 2, type: 'tool.started', occurredAt: '2026-09-29T10:00:01.000Z', payload: { toolCallId: 'main-1', name: 'document_draft', args: { title: '架构文档' } } },
  { id: 'e3', sessionId: 'session-1', runId, seq: 3, type: 'tool.completed', occurredAt: '2026-09-29T10:00:02.000Z', payload: { toolCallId: 'main-1', name: 'document_draft', result: { title: '架构文档' } } },
]

function renderTimeline() {
  return TestRenderer.create(
    <AgentExecutionTimeline
      activity={reduceAgentRunActivity(mainRunEvents)}
      runStartedAt="2026-09-29T10:00:00.000Z"
    />,
  )
}

/** 子代理摘要行「名字」后面的那段小字：运行中是任务预览，终态是耗时。 */
function summarySubText(root: TestRenderer.ReactTestInstance): string | undefined {
  const row = root.findByProps({ 'data-kind': 'subagent' })
  const summary = row.find((node) => node.parent === row && node.props.className === 'agent-tool-command')
  const text = summary.findByProps({ className: 'agent-tool-command-text' })
  const span = text.find((node) => node.parent === text && node.type === 'span')
  return typeof span?.props.children === 'string' ? span.props.children : undefined
}

describe('AgentExecutionTimeline subagent tool flow', () => {
  let listRunSubagentInvocations: ReturnType<typeof vi.fn>
  let listSubagentInvocationEvents: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function stubContextRooms() {
    listRunSubagentInvocations = vi.fn()
    listSubagentInvocationEvents = vi.fn()
    vi.stubGlobal('window', {
      nxcore: { contextRooms: { listRunSubagentInvocations, listSubagentInvocationEvents } },
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    })
  }

  it('运行中自动展开嵌套工具流，终态自动收起', async () => {
    stubContextRooms()
    listRunSubagentInvocations.mockImplementation(async (rootRunId: string) =>
      rootRunId === runId ? [invocationNode()] : [])
    listSubagentInvocationEvents.mockResolvedValue(toolEvents)

    const renderer = renderTimeline()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // 运行中：子代理行自动展开，嵌套出 3 个工具行，摘要行带任务预览。
    const row = renderer.root.findByProps({ 'data-kind': 'subagent' })
    expect(row.props.open).toBe(true)
    expect(summarySubText(renderer.root)).toBe('调研 EverRoom 架构')
    const nested = renderer.root.findByProps({ className: 'agent-subagent-tools' })
    expect(nested.children).toHaveLength(3)

    // 转终态：自动收起，摘要行缩成「名字 + 耗时」，任务全文点开看、预览退到悬停提示。
    listRunSubagentInvocations.mockResolvedValue([invocationNode({
      status: 'completed',
      completedAt: '2026-09-29T10:01:00.000Z',
    })])
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    const collapsed = renderer.root.findByProps({ 'data-kind': 'subagent' })
    expect(collapsed.props.open).toBe(false)
    expect(summarySubText(renderer.root)).toBe('58 秒')
    expect(renderer.root.findAllByProps({ className: 'agent-subagent-tools' })).toHaveLength(0)
  })

  it('历史调用默认收起，点开后只拉一次事件', async () => {
    stubContextRooms()
    listRunSubagentInvocations.mockImplementation(async (rootRunId: string) =>
      rootRunId === runId
        ? [invocationNode({ status: 'completed', completedAt: '2026-09-29T10:01:00.000Z' })]
        : [])
    listSubagentInvocationEvents.mockResolvedValue(toolEvents)

    const renderer = renderTimeline()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(renderer.root.findByProps({ 'data-kind': 'subagent' }).props.open).toBe(false)
    expect(renderer.root.findAllByProps({ className: 'agent-subagent-tools' })).toHaveLength(0)

    const row = renderer.root.findByProps({ 'data-kind': 'subagent' })
    act(() => row.props.onToggle({ currentTarget: { open: true } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(renderer.root.findByProps({ 'data-kind': 'subagent' }).props.open).toBe(true)
    expect(renderer.root.findByProps({ className: 'agent-subagent-tools' }).children).toHaveLength(3)
    // 终态调用不轮询：展开后多等几秒，事件请求仍只有最初一次。
    expect(listSubagentInvocationEvents).toHaveBeenCalledTimes(1)
  })

  it('用户手动收起后，终态不再被自动展开逻辑改写', async () => {
    stubContextRooms()
    listRunSubagentInvocations.mockImplementation(async (rootRunId: string) =>
      rootRunId === runId ? [invocationNode()] : [])
    listSubagentInvocationEvents.mockResolvedValue(toolEvents)

    const renderer = renderTimeline()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(renderer.root.findByProps({ 'data-kind': 'subagent' }).props.open).toBe(true)

    // 运行中手动收起 → 用户意图优先；随后转终态也保持收起。
    const row = renderer.root.findByProps({ 'data-kind': 'subagent' })
    act(() => row.props.onToggle({ currentTarget: { open: false } }))
    listRunSubagentInvocations.mockResolvedValue([invocationNode({
      status: 'completed',
      completedAt: '2026-09-29T10:01:00.000Z',
    })])
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    expect(renderer.root.findByProps({ 'data-kind': 'subagent' }).props.open).toBe(false)
  })
  it('子代理再派子代理：外层平铺一条「A → B」行，A 面板内不重复嵌套', async () => {
    stubContextRooms()
    const childId = 'inv-2'
    const childNode = invocationNode({
      id: childId,
      agentDefinitionId: 'builder',
      agentRevisionId: 'revision-2',
      agentName: 'Builder',
      parentRunId: invocationId,
      task: '按结论编排',
      createdAt: '2026-09-29T10:00:10.000Z',
      startedAt: '2026-09-29T10:00:10.000Z',
    })
    listRunSubagentInvocations.mockImplementation(async (rootRunId: string) => {
      if (rootRunId === runId) return [invocationNode(), childNode]
      if (rootRunId === invocationId) return [childNode]
      return []
    })
    listSubagentInvocationEvents.mockImplementation(async (id: string) => {
      if (id === invocationId) {
        return [...toolEvents, invocationEvent(7, 'tool.completed', {
          toolCallId: 'call-9',
          name: 'agent_dispatch',
          result: { content: JSON.stringify({ invocationId: childId }), details: { id: childId } },
        })]
      }
      return id === childId ? toolEvents.slice(0, 3) : []
    })

    const renderer = renderTimeline()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const rows = renderer.root.findAllByProps({ 'data-kind': 'subagent' })
    expect(rows).toHaveLength(2)
    // 外层行带父链标签「A → B」。
    const summary = rows[1]!.find((node) => node.parent === rows[1] && node.props.className === 'agent-tool-command')
    const text = summary.find((node) => node.parent === summary && node.props.className === 'agent-tool-command-text')
    const label = text.find((node) => node.parent === text && node.type === 'strong')
    expect(label.props.children).toBe('Researcher → Builder')
    // A 的面板里只有自己的工具流：调度工具行已去重，不再嵌套子代理行。
    expect(rows[0]!.findAllByProps({ 'data-kind': 'subagent' }).filter((node) => node !== rows[0])).toHaveLength(0)
    expect(rows[0]!.findByProps({ className: 'agent-subagent-tools' }).children).toHaveLength(3)
  })

})
