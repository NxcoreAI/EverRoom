import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '@nxcore/agent-contract'

import {
  createAgentRunActivityAccumulator,
  foldAgentRunActivityEvents,
  snapshotAgentRunActivity,
} from './agentRunActivity'

let seq = 0

function event(type: AgentEvent['type'], payload: Record<string, unknown> = {}, occurredAt = '2026-10-30T08:00:00.000Z'): AgentEvent {
  seq += 1
  return { id: `evt-${seq}`, sessionId: 'session-1', runId: 'run-1', seq, type, occurredAt, payload }
}

function toolRequested(toolCallId: string, name: string): AgentEvent {
  return event('tool.requested', { toolCallId, name, args: {} })
}

describe('reasoning segmentation by tool decisions', () => {
  it('splits reasoning at each tool call: segment goes to the step it precedes', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, [
      event('reasoning.delta', { delta: '先查一下文档。' }),
      toolRequested('tool-1', 'document_read'),
      event('tool.requested', { toolCallId: 'tool-1', name: 'document_read', args: { title: '周报' } }),
      event('reasoning.delta', { delta: '读完再总结。' }),
      toolRequested('tool-2', 'wiki_search'),
      event('reasoning.delta', { delta: '最后组织语言作答。' }),
      event('message.delta', { delta: '这是最终回答。' }),
    ])

    const snapshot = snapshotAgentRunActivity(acc)
    expect(snapshot.steps).toHaveLength(2)
    // 第一段思考归入它导致的第一个工具调用。
    expect(snapshot.steps[0]!.reasoningBefore).toBe('先查一下文档。')
    // 工具之间的思考归入下一个工具。
    expect(snapshot.steps[1]!.reasoningBefore).toBe('读完再总结。')
    // 最后一次工具之后的思考留在 tail（答案前的尾段）。
    expect(snapshot.tailReasoning).toBe('最后组织语言作答。')
  })

  it('exposes the in-flight reasoning as liveReasoning while the run is active', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, [
      event('reasoning.delta', { delta: '封段思考。' }),
      toolRequested('tool-1', 'document_read'),
      event('reasoning.delta', { delta: '正在流动的思考…' }),
    ])

    const active = snapshotAgentRunActivity(acc)
    // run 活跃：未封段思考以 liveReasoning 透出（时间线尾部 shimmer 行）。
    expect(active.liveReasoning).toBe('正在流动的思考…')

    foldAgentRunActivityEvents(acc, [event('run.completed', {})])
    const completed = snapshotAgentRunActivity(acc)
    // run 结束：live 行消失，同一段思考归入 tail。
    expect(completed.liveReasoning).toBe('')
    expect(completed.tailReasoning).toBe('正在流动的思考…')
  })

  it('keeps all reasoning as tail when the run has no tool calls', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, [
      event('reasoning.delta', { delta: '直接回答，' }),
      event('reasoning.delta', { delta: '不需要工具。' }),
      event('message.delta', { delta: '答案。' }),
    ])

    const snapshot = snapshotAgentRunActivity(acc)
    expect(snapshot.hasTools).toBe(false)
    expect(snapshot.steps).toHaveLength(0)
    expect(snapshot.tailReasoning).toBe('直接回答，不需要工具。')
  })

  it('discards in-flight reasoning segment when the runtime restarts the message (#199 retry)', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, [
      event('reasoning.delta', { delta: '第一波思考，将被丢弃。' }),
      // pi 自动重试：丢弃上一波输出，从头重新生成。
      event('message.started', {}),
      event('reasoning.delta', { delta: '重启后的思考。' }),
      toolRequested('tool-1', 'document_read'),
    ])

    const snapshot = snapshotAgentRunActivity(acc)
    expect(snapshot.steps[0]!.reasoningBefore).toBe('重启后的思考。')
    expect(snapshot.tailReasoning).toBe('')
  })

  it('keeps already-sealed segments untouched on message restart', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvents(acc, [
      event('reasoning.delta', { delta: '封好段的思考。' }),
      toolRequested('tool-1', 'document_read'),
      event('message.started', {}),
      event('reasoning.delta', { delta: '新尾段。' }),
    ])

    const snapshot = snapshotAgentRunActivity(acc)
    // 重启只清未封段的 pending，已归入 step 的段不动。
    expect(snapshot.steps[0]!.reasoningBefore).toBe('封好段的思考。')
    expect(snapshot.tailReasoning).toBe('新尾段。')
  })
})
