import { describe, expect, it } from 'vitest'

import type { AgentDebugRun } from '@nxcore/agent-contract'

import {
  anchorScrollAdjustment,
  BROWSE_TOP_THRESHOLD_PX,
  freezeOrder,
  freezeSessionGroups,
  isBrowsingScroll,
  pickRowAnchor,
  sessionGroupOrderOf,
  type RowGeometry,
} from '../src/renderer/src/agent-debug/browseOrder'
import type { SessionGroup, SessionOption } from '../src/renderer/src/agent-debug/history'

function makeRun(runId: string, sessionId: string | null = null): AgentDebugRun {
  return {
    runId,
    agentId: 'main',
    agentName: 'Main',
    agentKind: 'builtin',
    runtimeId: 'pi:main',
    sessionId,
    pageLabel: null,
    task: `任务 ${runId}`,
    status: 'completed',
    startedAt: '2026-10-24T00:00:00.000Z',
    completedAt: '2026-10-24T00:01:00.000Z',
    eventCount: 1,
    droppedEvents: 0,
    toolCallCount: 0,
    reasoningChars: 0,
    lastEventAt: null,
    errorMessage: null,
  }
}

function makeGroup(
  key: string,
  runIds: readonly string[],
  overrides: Partial<SessionOption> = {},
): SessionGroup {
  const runs = runIds.map((runId) => makeRun(runId, key || null))
  return {
    option: {
      key,
      label: `会话 ${key}`,
      title: `会话 ${key}`,
      primary: `会话 ${key}`,
      shortId: key.slice(0, 8),
      count: runs.length,
      startedAt: null,
      lastAt: null,
      running: false,
      ...overrides,
    },
    runs,
  }
}

function idsOf(groups: readonly SessionGroup[]): Array<[string, string[]]> {
  return groups.map((group) => [group.option.key, group.runs.map((run) => run.runId)])
}

describe('isBrowsingScroll', () => {
  it('把顶部阈值以内视为「在顶部」', () => {
    expect(isBrowsingScroll(0)).toBe(false)
    expect(isBrowsingScroll(BROWSE_TOP_THRESHOLD_PX)).toBe(false)
    expect(isBrowsingScroll(BROWSE_TOP_THRESHOLD_PX + 0.5)).toBe(true)
    expect(isBrowsingScroll(400)).toBe(true)
  })

  it('NaN / 负数按在顶部处理', () => {
    expect(isBrowsingScroll(Number.NaN)).toBe(false)
    expect(isBrowsingScroll(-20)).toBe(false)
  })
})

describe('freezeOrder', () => {
  const idOf = (item: { id: string }): string => item.id

  it('没有基准顺序时返回数据源顺序', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const frozen = freezeOrder([], items, idOf)
    expect(frozen.map(idOf)).toEqual(['a', 'b'])
    expect(frozen).not.toBe(items)
  })

  it('已存在的行保持冻结顺序，即使数据源顺序变了', () => {
    const frozen = freezeOrder(['b', 'a'], [{ id: 'a' }, { id: 'b' }], idOf)
    expect(frozen.map(idOf)).toEqual(['b', 'a'])
  })

  it('新行按数据源顺序插到最前', () => {
    const frozen = freezeOrder(['b', 'a'], [{ id: 'a' }, { id: 'c' }, { id: 'd' }, { id: 'b' }], idOf)
    expect(frozen.map(idOf)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('消失的行丢弃，重复的旧 id 只保留一次', () => {
    const frozen = freezeOrder(['gone', 'b', 'b', 'a'], [{ id: 'a' }, { id: 'b' }], idOf)
    expect(frozen.map(idOf)).toEqual(['b', 'a'])
  })

  it('行内容取最新数据、位置保持冻结（原地更新）', () => {
    const frozen = freezeOrder(
      ['b', 'a'],
      [{ id: 'a', count: 2 }, { id: 'b', count: 3 }],
      idOf,
    )
    expect(frozen.map((item) => [item.id, item.count])).toEqual([['b', 3], ['a', 2]])
  })
})

describe('sessionGroupOrderOf', () => {
  it('记录组顺序与每组 run 顺序', () => {
    const order = sessionGroupOrderOf([makeGroup('s1', ['r1', 'r2']), makeGroup('', ['r3'])])
    expect(order).toEqual({
      groups: ['s1', ''],
      runs: { s1: ['r1', 'r2'], '': ['r3'] },
    })
  })
})

describe('freezeSessionGroups', () => {
  it('没有基准顺序时原样返回', () => {
    const groups = [makeGroup('s1', ['r1']), makeGroup('s2', ['r2'])]
    expect(idsOf(freezeSessionGroups(null, groups))).toEqual([['s1', ['r1']], ['s2', ['r2']]])
  })

  it('冻结组顺序与组内 run 顺序，新组 / 新 run 插到最前', () => {
    const previous = {
      groups: ['s2', 's1'],
      runs: { s2: ['r2b', 'r2a'], s1: ['r1'] },
    }
    const live = [
      makeGroup('s1', ['r1', 'r1new']),
      makeGroup('s3', ['r3']),
      makeGroup('s2', ['r2a', 'r2new', 'r2b']),
    ]
    expect(idsOf(freezeSessionGroups(previous, live))).toEqual([
      ['s3', ['r3']],
      ['s2', ['r2new', 'r2b', 'r2a']],
      ['s1', ['r1new', 'r1']],
    ])
  })

  it('消失的组 / run 直接丢弃', () => {
    const previous = {
      groups: ['gone', 's1', 's2'],
      runs: { gone: ['g1'], s1: ['r1gone', 'r1'], s2: ['r2'] },
    }
    expect(idsOf(freezeSessionGroups(previous, [
      makeGroup('s2', ['r2']),
      makeGroup('s1', ['r1']),
    ]))).toEqual([['s1', ['r1']], ['s2', ['r2']]])
  })

  it('组属性取最新数据（计数 / 运行中状态随刷新更新）', () => {
    const previous = { groups: ['s1'], runs: { s1: ['r1'] } }
    const live = [makeGroup('s1', ['r1', 'r2'], { count: 2, running: true })]
    const frozen = freezeSessionGroups(previous, live)
    expect(frozen[0]?.option.count).toBe(2)
    expect(frozen[0]?.option.running).toBe(true)
    expect(frozen[0]?.runs.map((run) => run.runId)).toEqual(['r2', 'r1'])
  })

  it('「无会话」组（空字符串 key）同样按冻结顺序处理', () => {
    const previous = { groups: ['', 's1'], runs: { '': ['n1'], s1: ['r1'] } }
    expect(idsOf(freezeSessionGroups(previous, [
      makeGroup('s1', ['r1']),
      makeGroup('', ['n2', 'n1']),
    ]))).toEqual([['', ['n2', 'n1']], ['s1', ['r1']]])
  })
})

describe('pickRowAnchor', () => {
  const row = (id: string, top: number, bottom: number): RowGeometry => ({ id, top, bottom })

  it('跳过完全在视口上方的行', () => {
    const anchor = pickRowAnchor(
      [row('a', -80, -20), row('b', 60, 95), row('c', 100, 140)],
      100,
    )
    expect(anchor).toEqual({ id: 'c', offset: 0 })
  })

  it('首行只露出一部分时也作为锚点（偏移为负）', () => {
    const anchor = pickRowAnchor([row('a', 80, 120), row('b', 120, 150)], 100)
    expect(anchor).toEqual({ id: 'a', offset: -20 })
  })

  it('没有可见行时返回 null', () => {
    expect(pickRowAnchor([row('a', -60, -1)], 100)).toBeNull()
    expect(pickRowAnchor([], 100)).toBeNull()
  })
})

describe('anchorScrollAdjustment', () => {
  it('行被上方内容推下时返回正增量（往下滚）', () => {
    expect(anchorScrollAdjustment(150, 100, 0)).toBe(50)
    expect(anchorScrollAdjustment(120, 100, -20)).toBe(40)
  })

  it('行位置未变时返回 0', () => {
    expect(anchorScrollAdjustment(100, 100, 0)).toBe(0)
    expect(anchorScrollAdjustment(80, 100, -20)).toBe(0)
  })
})
