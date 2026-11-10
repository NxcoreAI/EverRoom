/**
 * 默认选 run 的策略单测：归档里有大量「只有 5 条事件、0 次工具」的空壳 run，
 * 首屏必须落到一条能看出链路问题的 run 上，否则面板看起来像坏了。
 */
import type { AgentDebugRun } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { pickDefaultRun } from '../src/renderer/src/agent-dashboard/state/defaultRun'

function run(partial: Partial<AgentDebugRun> & { runId: string }): AgentDebugRun {
  return {
    agentId: 'main',
    agentName: 'Main',
    agentKind: 'builtin',
    runtimeId: 'pi',
    sessionId: null,
    pageLabel: null,
    task: 'task',
    status: 'completed',
    startedAt: '2026-11-01T00:00:00.000Z',
    completedAt: '2026-11-01T00:00:10.000Z',
    eventCount: 5,
    droppedEvents: 0,
    toolCallCount: 0,
    reasoningChars: 0,
    lastEventAt: null,
    errorMessage: null,
    ...partial,
  } as AgentDebugRun
}

const NOW = Date.parse('2026-11-02T00:00:00.000Z')

describe('pickDefaultRun', () => {
  it('空列表返回 null', () => {
    expect(pickDefaultRun([], NOW)).toBeNull()
  })

  it('运行中的 run 永远优先', () => {
    const picked = pickDefaultRun([
      run({ runId: 'rich', toolCallCount: 9, eventCount: 200 }),
      run({ runId: 'live', status: 'running', startedAt: '2026-11-01T23:00:00.000Z' }),
    ], NOW)
    expect(picked?.runId).toBe('live')
  })

  it('优先最近 30 分钟内且真的调过工具的 run', () => {
    const picked = pickDefaultRun([
      run({ runId: 'empty-recent', startedAt: '2026-11-01T23:59:00.000Z' }),
      run({ runId: 'tool-recent', toolCallCount: 3, startedAt: '2026-11-01T23:30:00.000Z' }),
      run({ runId: 'tool-old', toolCallCount: 20, startedAt: '2026-10-30T00:00:00.000Z' }),
    ], NOW)
    expect(picked?.runId).toBe('tool-recent')
  })

  it('都很旧时退回到事件最多的 run', () => {
    const picked = pickDefaultRun([
      run({ runId: 'small', toolCallCount: 1, eventCount: 12, startedAt: '2026-10-30T00:00:00.000Z' }),
      run({ runId: 'big', toolCallCount: 4, eventCount: 90, startedAt: '2026-10-29T00:00:00.000Z' }),
    ], NOW)
    expect(picked?.runId).toBe('big')
  })

  it('全是空壳 run 时取最新的一条，而不是随机的', () => {
    const picked = pickDefaultRun([
      run({ runId: 'old', startedAt: '2026-10-01T00:00:00.000Z' }),
      run({ runId: 'new', startedAt: '2026-10-30T00:00:00.000Z' }),
    ], NOW)
    expect(picked?.runId).toBe('new')
  })
})
