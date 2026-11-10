import { describe, expect, it } from 'vitest'

import type { AgentDebugEvent } from '@nxcore/agent-contract'

import {
  createEmptyRunTimeline,
  extractSubmitResult,
  mergeRunEvents,
  reduceRunTimeline,
  type DebugMessageBlock,
  type DebugReasoningBlock,
  type DebugSystemBlock,
  type DebugToolBlock,
} from '../src/renderer/src/agent-debug/reducer'

let clock = Date.parse('2026-10-23T10:00:00.000Z')

function ev(
  seq: number,
  type: AgentDebugEvent['type'],
  payload: unknown = {},
  occurredAt?: string,
): AgentDebugEvent {
  clock += 500
  return {
    seq,
    type,
    payload,
    occurredAt: occurredAt ?? new Date(clock).toISOString(),
  }
}

function toolBlocks(events: AgentDebugEvent[]): DebugToolBlock[] {
  return reduceRunTimeline(events).blocks.filter((block): block is DebugToolBlock => block.kind === 'tool')
}

function systemBlocks(events: AgentDebugEvent[]): DebugSystemBlock[] {
  return reduceRunTimeline(events).blocks.filter((block): block is DebugSystemBlock => block.kind === 'system')
}

describe('mergeRunEvents', () => {
  it('appends new seqs in ascending order regardless of arrival order', () => {
    const existing = [ev(1, 'run.started'), ev(2, 'message.delta', { delta: 'a' })]
    const merged = mergeRunEvents(existing, [ev(4, 'run.completed'), ev(3, 'tool.started', { toolCallId: 't1', name: 'search' })])
    expect(merged.map((event) => event.seq)).toEqual([1, 2, 3, 4])
  })

  it('upserts (replaces) an existing seq instead of appending a duplicate', () => {
    // Gateway 会合并相邻 delta 且 seq 不变：同 seq 事件在后续轮询里 payload 更长。
    const first = mergeRunEvents([], [ev(1, 'reasoning.delta', { delta: '想' })])
    const second = mergeRunEvents(first, [ev(1, 'reasoning.delta', { delta: '想清楚' })])
    expect(second).toHaveLength(1)
    expect(second[0]!.payload).toEqual({ delta: '想清楚' })
    const model = reduceRunTimeline(second)
    expect(model.blocks).toHaveLength(1)
    expect((model.blocks[0] as DebugReasoningBlock).text).toBe('想清楚')
  })

  it('keeps the incoming event when the same seq is replayed with more content', () => {
    const merged = mergeRunEvents(
      [ev(1, 'reasoning.delta', { delta: 'a' }), ev(2, 'tool.started', { toolCallId: 't1', name: 'x' })],
      [ev(1, 'reasoning.delta', { delta: 'abc' })],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]!.payload).toEqual({ delta: 'abc' })
  })
})

describe('reduceRunTimeline', () => {
  it('returns an empty model for no events', () => {
    expect(reduceRunTimeline([])).toEqual(createEmptyRunTimeline())
  })

  it('accumulates reasoning deltas into one block and closes it at a tool call', () => {
    const events = [
      ev(1, 'run.started'),
      ev(2, 'reasoning.delta', { delta: '先看' }),
      ev(3, 'reasoning.delta', { delta: '页面结构。' }),
      ev(4, 'tool.started', { toolCallId: 't1', name: 'file_read', args: { path: 'a.md' } }),
    ]
    const model = reduceRunTimeline(events)
    const reasoning = model.blocks.filter((block): block is DebugReasoningBlock => block.kind === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]!.text).toBe('先看页面结构。')
    expect(reasoning[0]!.open).toBe(false)
    expect(reasoning[0]!.seqs).toEqual([2, 3])
    // 只保留一条「Run 开始」系统行 + 一条工具卡
    expect(model.blocks.map((block) => block.kind)).toEqual(['system', 'reasoning', 'tool'])
  })

  it('keeps separate reasoning blocks when interrupted by a tool call', () => {
    const events = [
      ev(1, 'reasoning.delta', { delta: '第一步' }),
      ev(2, 'tool.started', { toolCallId: 't1', name: 'search' }),
      ev(3, 'reasoning.delta', { delta: '第二步' }),
    ]
    const model = reduceRunTimeline(events)
    const reasoning = model.blocks.filter((block): block is DebugReasoningBlock => block.kind === 'reasoning')
    expect(reasoning.map((block) => block.text)).toEqual(['第一步', '第二步'])
    expect(reasoning[0]!.open).toBe(false)
    expect(reasoning[1]!.open).toBe(true)
  })

  it('merges the tool lifecycle into a single card with args, partial result, result and duration', () => {
    const events = [
      ev(1, 'tool.requested', { toolCallId: 't1', name: 'web_search', args: { query: 'everroom' } }),
      ev(2, 'tool.started', { toolCallId: 't1', name: 'web_search', args: { query: 'everroom' } }),
      ev(3, 'tool.updated', { toolCallId: 't1', name: 'web_search', partialResult: { hits: 1 } }),
      ev(4, 'tool.completed', { toolCallId: 't1', name: 'web_search', result: { hits: 3 } }),
    ]
    const tools = toolBlocks(events)
    expect(tools).toHaveLength(1)
    const [tool] = tools
    expect(tool!.status).toBe('completed')
    expect(tool!.name).toBe('web_search')
    expect(tool!.args).toEqual({ query: 'everroom' })
    expect(tool!.partialResult).toEqual({ hits: 1 })
    expect(tool!.result).toEqual({ hits: 3 })
    expect(tool!.startedAt).toBe(events[0]!.occurredAt)
    expect(tool!.completedAt).toBe(events[3]!.occurredAt)
    expect(tool!.seqs).toEqual([1, 2, 3, 4])
  })

  it('marks a failed tool with its error message and keeps title updates', () => {
    const events = [
      ev(1, 'tool.started', { toolCallId: 't1', name: 'bash', title: '运行命令' }),
      ev(2, 'tool.failed', { toolCallId: 't1', name: 'bash', message: 'exit code 1' }),
      ev(3, 'tool.updated', { toolCallId: 't1', name: 'bash', partialResult: 'late' }),
    ]
    const [tool] = toolBlocks(events)
    expect(tool!.status).toBe('error')
    expect(tool!.title).toBe('运行命令')
    expect(tool!.error).toBe('exit code 1')
    // 终态之后迟到的 update 不覆盖状态
    expect(tool!.status).toBe('error')
  })

  it('accumulates assistant message deltas and finalizes with message.completed content', () => {
    const events = [
      ev(1, 'message.started', { role: 'assistant' }),
      ev(2, 'message.delta', { delta: '你好' }),
      ev(3, 'message.delta', { delta: '，世界' }),
      // 服务端合并后的累计事件（seq 不变）二次到达：只替换，不重复追加。
      ev(3, 'message.delta', { delta: '你好，世界！' }),
      ev(4, 'message.completed', { content: '你好，世界！' }),
      ev(5, 'run.completed'),
    ]
    const model = reduceRunTimeline(events)
    const messages = model.blocks.filter((block): block is DebugMessageBlock => block.kind === 'message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe('你好，世界！')
    expect(messages[0]!.completed).toBe(true)
    expect(messages[0]!.open).toBe(false)
    expect(model.output.finalText).toBe('你好，世界！')
    expect(model.output.messageCompleted).toBe(true)
    expect(model.blocks[model.blocks.length - 1]!.kind).toBe('system')
  })

  it('falls back to accumulated message text when message.completed has no content', () => {
    const events = [
      ev(1, 'message.delta', { delta: '流式' }),
      ev(2, 'message.delta', { delta: '输出' }),
      ev(3, 'message.completed', { role: 'assistant' }),
    ]
    const model = reduceRunTimeline(events)
    const messages = model.blocks.filter((block): block is DebugMessageBlock => block.kind === 'message')
    expect(messages[0]!.text).toBe('流式输出')
    expect(model.output.finalText).toBe('流式输出')
  })

  it('records run lifecycle, context usage/compaction and approvals as system rows', () => {
    const events = [
      ev(1, 'run.started'),
      ev(2, 'context.usage', { tokens: 8200, contextWindow: 32000, percent: 25.6 }),
      ev(3, 'approval.requested', { approvalId: 'ap1', kind: 'shell', toolName: 'bash', command: 'rm -rf build' }),
      ev(4, 'approval.resolved', { approvalId: 'ap1', approved: true }),
      ev(5, 'context.compaction', { active: true, reason: 'threshold' }),
      ev(6, 'context.compaction', { active: false, reason: 'threshold' }),
      ev(7, 'run.failed', { message: '模型超时' }),
    ]
    const model = reduceRunTimeline(events)
    expect(model.contextUsage).toEqual({ tokens: 8200, contextWindow: 32000, percent: 25.6 })
    expect(model.contextCompaction).toEqual({ active: false, reason: 'threshold' })

    const approvals = systemBlocks(events).filter((block) => block.approval !== null)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.label).toBe('审批通过')
    expect(approvals[0]!.approval).toMatchObject({
      approvalId: 'ap1',
      status: 'approved',
      toolName: 'bash',
      command: 'rm -rf build',
    })
    expect(approvals[0]!.seqs).toEqual([3, 4])

    expect(model.output.errorMessage).toBe('模型超时')
    const labels = systemBlocks(events).map((block) => block.label)
    expect(labels).toContain('Run 开始')
    expect(labels).toContain('上下文用量')
    expect(labels).toContain('上下文压缩中')
    expect(labels).toContain('Run 失败')
  })

  it('extracts subagent_submit_result from tool.completed result envelope', () => {
    const structured = { plan: { slides: 3 }, sources: ['doc-1'] }
    const events = [
      ev(1, 'tool.started', {
        toolCallId: 'submit-1',
        name: 'subagent_submit_result',
        args: structured,
      }),
      ev(2, 'tool.completed', {
        toolCallId: 'submit-1',
        name: 'subagent_submit_result',
        // 真实 Gateway 的提交工具 result 是 ack 包壳，结构化结果在 args。
        result: { content: JSON.stringify({ accepted: true, invocationId: 'inv-1' }), details: { accepted: true } },
      }),
    ]
    const model = reduceRunTimeline(events)
    expect(model.output.submitResult).not.toBeNull()
    expect(model.output.submitResult!.source).toBe('args')
    expect(model.output.submitResult!.value).toEqual(structured)
  })

  it('extracts a structured object placed directly in tool.completed result', () => {
    const structured = { kind: 'slides', pages: [{ title: '封面' }] }
    const events = [
      ev(1, 'tool.started', { toolCallId: 'submit-1', name: 'subagent_submit_result', args: {} }),
      ev(2, 'tool.completed', { toolCallId: 'submit-1', name: 'subagent_submit_result', result: structured }),
    ]
    const result = reduceRunTimeline(events).output.submitResult
    expect(result).toMatchObject({ source: 'result', value: structured })
  })

  it('extracts structured JSON from result.content when it is not just an ack', () => {
    const events = [
      ev(1, 'tool.completed', {
        toolCallId: 'submit-1',
        name: 'subagent_submit_result',
        result: { content: JSON.stringify({ outline: [{ id: 'a' }] }), details: { accepted: true } },
      }),
    ]
    const result = reduceRunTimeline(events).output.submitResult
    expect(result).toMatchObject({ source: 'result.content', value: { outline: [{ id: 'a' }] } })
  })

  it('extractSubmitResult returns null when there is nothing to extract', () => {
    const model = reduceRunTimeline([ev(1, 'run.started'), ev(2, 'run.completed')])
    expect(model.output.submitResult).toBeNull()
  })

  it('exposes an open streaming flag for the last delta only', () => {
    const events = [
      ev(1, 'reasoning.delta', { delta: '思考中' }),
      ev(2, 'message.delta', { delta: '生成中' }),
    ]
    const model = reduceRunTimeline(events)
    const reasoning = model.blocks.find((block): block is DebugReasoningBlock => block.kind === 'reasoning')
    const message = model.blocks.find((block): block is DebugMessageBlock => block.kind === 'message')
    expect(reasoning!.open).toBe(false)
    expect(message!.open).toBe(true)
  })

  it('counts lastSeq and eventCount', () => {
    const events = [ev(3, 'run.started'), ev(9, 'run.completed')]
    const model = reduceRunTimeline(events)
    expect(model.lastSeq).toBe(9)
    expect(model.eventCount).toBe(2)
  })
})
