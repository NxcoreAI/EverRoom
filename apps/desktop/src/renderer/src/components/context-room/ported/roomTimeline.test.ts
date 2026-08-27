import { describe, expect, it } from 'vitest'

import { formatTimelineTime, parseTimelineDate } from './roomTimeline'

const NOW = new Date('2026-08-26T10:00:00')

describe('parseTimelineDate', () => {
  it('parses ISO timestamps with and without a timezone marker', () => {
    expect(parseTimelineDate('2026-08-20T11:00:00.000Z', NOW)?.toUTCString())
      .toBe(new Date('2026-08-20T11:00:00.000Z').toUTCString())
    expect(parseTimelineDate('2026-08-21 10:30', NOW)).toEqual(new Date(2026, 7, 21, 10, 30))
    expect(parseTimelineDate('2026-08-21', NOW)).toEqual(new Date(2026, 7, 21))
  })

  it('does not mis-bucket ISO timestamps through the MM-DD fallback', () => {
    // 旧实现会命中 “26-08” 片段，把 2026-08-26 解析成下一年度的 rollover 日期
    const parsed = parseTimelineDate('2026-08-26T23:30:00.000Z', NOW)
    expect(parsed?.getUTCFullYear()).toBe(2026)
    expect(parsed?.getUTCMonth()).toBe(7)
  })

  it('keeps the legacy 今天/昨天/MM-DD heuristics and returns null for empty text', () => {
    expect(parseTimelineDate('今天 11:20', NOW)).toEqual(new Date(2026, 7, 26))
    expect(parseTimelineDate('昨天 18:30', NOW)).toEqual(new Date(2026, 7, 25))
    expect(parseTimelineDate('07-09', NOW)).toEqual(new Date(2026, 6, 9))
    expect(parseTimelineDate('待定', NOW)).toBeNull()
    expect(parseTimelineDate('', NOW)).toBeNull()
  })
})

describe('formatTimelineTime', () => {
  it('localizes ISO timestamps and leaves free-form labels untouched', () => {
    expect(formatTimelineTime('2026-08-21 10:30', 'en-US', NOW)).toContain('10:30')
    expect(formatTimelineTime('今天 11:20', 'zh-CN', NOW)).toBe('今天 11:20')
    // 与当前年份不同的日期需要带年份展示（时区偏移不会把 2025-06-30 推到别的年份）
    expect(formatTimelineTime('2025-06-30T12:00:00.000Z', 'en-US', NOW)).toContain('2025')
  })
})
