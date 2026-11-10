import { describe, expect, it } from 'vitest'

import type { AgentDebugRun } from '@nxcore/agent-contract'

import {
  activeSlidePagesByAgent,
  formatSlidePageSummary,
  slidePageBadge,
  slidePageOf,
  slidePagesTitle,
  slidePageTitle,
} from '../src/renderer/src/agent-debug/slidePage'

let sequence = 0

function makeRun(partial: Partial<AgentDebugRun> = {}): AgentDebugRun {
  sequence += 1
  return {
    runId: `run-${sequence}`,
    agentId: 'slides-layouter',
    agentName: 'Slides Layouter',
    agentKind: 'developer',
    runtimeId: 'pi:subagent:slides-layouter',
    sessionId: 'session-1',
    pageLabel: 'Subagent: Slides Layouter',
    task: '单页布局',
    status: 'running',
    startedAt: '2026-10-26T00:00:00.000Z',
    completedAt: null,
    eventCount: 3,
    droppedEvents: 0,
    toolCallCount: 1,
    reasoningChars: 10,
    lastEventAt: '2026-10-26T00:00:01.000Z',
    errorMessage: null,
    ...partial,
  }
}

describe('slidePageOf / slidePageBadge / slidePageTitle', () => {
  it('带页序与总页数时给出 P3/12 徽标', () => {
    const run = makeRun({ slidePageIndex: 3, slidePageCount: 12 })
    expect(slidePageOf(run)).toEqual({ page: 3, count: 12 })
    expect(slidePageBadge(run)).toBe('P3/12')
    expect(slidePageTitle(run)).toBe('第 3 页（共 12 页）')
  })

  it('只有页序时显示 P3，不显示总数', () => {
    const run = makeRun({ slidePageIndex: 3 })
    expect(slidePageOf(run)).toEqual({ page: 3, count: null })
    expect(slidePageBadge(run)).toBe('P3')
    expect(slidePageTitle(run)).toBe('第 3 页')
  })

  it('非逐页 run / 非法页序返回 null', () => {
    expect(slidePageOf(makeRun())).toBeNull()
    expect(slidePageBadge(makeRun())).toBeNull()
    expect(slidePageTitle(makeRun())).toBeNull()
    expect(slidePageOf(makeRun({ slidePageIndex: 0 }))).toBeNull()
    expect(slidePageOf(makeRun({ slidePageIndex: -2 }))).toBeNull()
    expect(slidePageOf(makeRun({ slidePageIndex: 1.5 }))).toBeNull()
  })

  it('总页数小于页序这类脏数据只丢弃总页数，保留页序', () => {
    const run = makeRun({ slidePageIndex: 3, slidePageCount: 2 })
    expect(slidePageOf(run)).toEqual({ page: 3, count: null })
    expect(slidePageBadge(run)).toBe('P3')
  })
})

describe('activeSlidePagesByAgent', () => {
  it('只聚合运行中 run 的页，升序去重，按 Agent 分组', () => {
    const runs = [
      makeRun({ slidePageIndex: 5, slidePageCount: 8 }),
      makeRun({ slidePageIndex: 2, slidePageCount: 8 }),
      makeRun({ slidePageIndex: 2, slidePageCount: 8 }),
      makeRun({ slidePageIndex: 7, slidePageCount: 8, status: 'completed' }),
      makeRun({ slidePageIndex: 3, slidePageCount: 8, agentId: 'slides-editor' }),
      makeRun({ agentId: 'main', task: '普通 run' }),
    ]
    const pages = activeSlidePagesByAgent(runs)
    expect(pages.get('slides-layouter')).toEqual([2, 5])
    expect(pages.get('slides-editor')).toEqual([3])
    expect(pages.has('main')).toBe(false)
  })

  it('没有运行中的逐页 run 时返回空 Map', () => {
    const pages = activeSlidePagesByAgent([
      makeRun({ slidePageIndex: 2, slidePageCount: 8, status: 'completed' }),
      makeRun({ agentId: 'main' }),
    ])
    expect(pages.size).toBe(0)
  })
})

describe('formatSlidePageSummary', () => {
  it('连续页压缩成区间', () => {
    expect(formatSlidePageSummary([5, 1, 2, 3, 4])).toBe('P1–P5')
    expect(formatSlidePageSummary(Array.from({ length: 16 }, (_, index) => index + 1))).toBe('P1–P16')
  })

  it('混合连续段与孤立页', () => {
    expect(formatSlidePageSummary([1, 2, 3, 7, 9, 10])).toBe('P1–P3 P7 P9–P10')
    expect(formatSlidePageSummary([1, 3, 5])).toBe('P1 P3 P5')
  })

  it('段数超过上限时尾部折叠成 +N（N 为剩余页数）', () => {
    expect(formatSlidePageSummary([1, 3, 5, 7, 9, 11, 13])).toBe('P1 P3 P5 P7 +3')
    // 第 5 段是两页的区间：被折叠的是 2 页。
    expect(formatSlidePageSummary([1, 3, 5, 7, 9, 10])).toBe('P1 P3 P5 P7 +2')
  })

  it('空集合 / 非法页号返回空字符串', () => {
    expect(formatSlidePageSummary([])).toBe('')
    expect(formatSlidePageSummary([0, -1, Number.NaN])).toBe('')
  })

  it('不修改输入数组', () => {
    const pages = [5, 1, 3]
    expect(formatSlidePageSummary(pages)).toBe('P1 P3 P5')
    expect(pages).toEqual([5, 1, 3])
  })
})

describe('slidePagesTitle', () => {
  it('列出完整页序', () => {
    expect(slidePagesTitle([3, 1, 2])).toBe('正在处理第 1、2、3 页')
  })

  it('超过上限时用「等 N 页」收尾', () => {
    expect(slidePagesTitle([1, 2, 3, 4], 3)).toBe('正在处理第 1、2、3 等 4 页')
  })

  it('空集合返回空字符串', () => {
    expect(slidePagesTitle([])).toBe('')
  })
})
