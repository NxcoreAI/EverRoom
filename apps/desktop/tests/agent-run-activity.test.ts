import { describe, expect, it } from 'vitest'

import {
  agentToolLabel,
  agentToolResultSummary,
  agentToolSubject,
  buildTimelineRows,
  type AgentActivityStep,
  type DisplayAgentToolCall,
} from '../src/renderer/src/components/agent/agentRunActivity'

function tool(overrides: Partial<DisplayAgentToolCall> = {}): DisplayAgentToolCall {
  return {
    id: 't1',
    runId: 'r1',
    name: 'sheets_agent_edit',
    args: {},
    status: 'completed',
    startedAt: '2026-11-05T10:00:00.000Z',
    completedAt: '2026-11-05T10:00:01.000Z',
    ...overrides,
  }
}

function step(index: number, value: DisplayAgentToolCall): AgentActivityStep {
  return {
    id: `s${index}`,
    sequence: index,
    tool: value,
    beforeText: '',
    afterText: '',
    reasoningBefore: '',
  }
}

describe('时间线工具行文案', () => {
  it('办公套件工具不再直接显示原始工具名', () => {
    expect(agentToolLabel(tool({ name: 'sheets_agent_edit' }), true)).toBe('已编辑表格')
    expect(agentToolLabel(tool({ name: 'word_agent_ops' }), false)).toBe('编辑文档')
  })

  it('从 calls 派生具体对象：单条显示操作+区域，多条显示条数与首个操作', () => {
    const single = tool({
      args: { calls: [{ id: 'a', name: 'read_range', input: { range: 'A1:N21', sheetId: 'sheet-1' } }] },
    })
    expect(agentToolSubject(single)).toBe('read_range A1:N21')

    const many = tool({
      args: {
        calls: [
          { id: 'a', name: 'set_cell', input: { address: 'B3' } },
          { id: 'b', name: 'set_cell', input: { address: 'C3' } },
        ],
      },
    })
    expect(agentToolSubject(many)).toBe('2 处操作 · set_cell B3')
  })

  it('编辑结果说「N 处操作已完成」，而不是「获得 1 条结果」', () => {
    const result = {
      ok: true,
      results: [
        { id: 'a', name: 'set_cell', ok: true },
        { id: 'b', name: 'set_cell', ok: true },
        { id: 'c', name: 'format_range', ok: true },
      ],
    }
    expect(agentToolResultSummary(result)).toBe('3 处操作已完成')
  })

  it('部分失败时如实说明失败条数', () => {
    const result = {
      ok: false,
      results: [{ ok: true }, { ok: false }, { ok: true }],
    }
    expect(agentToolResultSummary(result)).toBe('3 处操作未全部成功')
  })
})

describe('时间线折叠', () => {
  it('同一工具连续 5 次折叠成一行，明细仍可展开', () => {
    const steps = Array.from({ length: 5 }, (_, index) => step(index, tool({
      id: `t${index}`,
      args: { calls: [{ id: `c${index}`, name: 'set_cell', input: { address: `B${index + 3}` } }] },
      startedAt: `2026-11-05T10:0${index}:00.000Z`,
    })))
    const rows = buildTimelineRows(steps, [], 'r1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'repeat', count: 5 })
  })

  it('不同工具交替出现时不折叠', () => {
    const rows = buildTimelineRows([
      step(0, tool({ id: 't0', name: 'sheets_agent_read' })),
      step(1, tool({ id: 't1', name: 'sheets_agent_edit' })),
      step(2, tool({ id: 't2', name: 'sheets_agent_read' })),
      step(3, tool({ id: 't3', name: 'sheets_agent_edit' })),
    ], [], 'r1')
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.kind === 'tool')).toBe(true)
  })

  it('三次以内的重复保持原样（不值得折叠）', () => {
    const rows = buildTimelineRows([0, 1, 2].map((index) => step(index, tool({ id: `t${index}` }))), [], 'r1')
    expect(rows).toHaveLength(3)
  })
})
