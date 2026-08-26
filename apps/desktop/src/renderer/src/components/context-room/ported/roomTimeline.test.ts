import { describe, expect, it } from 'vitest'

import type { RoomDocument } from '@nxcore/agent-contract'

import type { KnowledgeRoomContextDto } from '../../../../../shared/knowledge'
import { deriveRoomTimeline, formatTimelineTime, parseTimelineDate } from './roomTimeline'
import type { ContextRoomTimelineItem } from './types'

const NOW = new Date('2026-08-26T10:00:00')

function documentFixture(overrides: Partial<RoomDocument> = {}): RoomDocument {
  return {
    id: 'doc-1',
    roomId: 'room-test',
    title: '评审纪要',
    contentJson: { type: 'doc', content: [] },
    contentSchemaVersion: 1,
    version: 1,
    status: 'active',
    activeTransactionId: null,
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-20T11:00:00.000Z',
    ...overrides,
  }
}

function contextFixture(meetings: KnowledgeRoomContextDto['meetings'] = []): Pick<KnowledgeRoomContextDto, 'meetings'> {
  return { meetings }
}

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

  it('keeps the legacy 今天/昨天/MM-DD heuristics', () => {
    expect(parseTimelineDate('今天 11:20', NOW)).toEqual(new Date(2026, 7, 26))
    expect(parseTimelineDate('昨天 18:30', NOW)).toEqual(new Date(2026, 7, 25))
    expect(parseTimelineDate('07-09', NOW)).toEqual(new Date(2026, 6, 9))
    expect(parseTimelineDate('待定', NOW)).toBeNull()
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

describe('deriveRoomTimeline', () => {
  it('derives document and meeting events with generated flags', () => {
    const timeline = deriveRoomTimeline(
      { timeline: [] },
      contextFixture([{ title: '复盘会', when: '2026-08-21 10:30', participants: ['林薇'], sourceTitle: '评审纪要' }]),
      [documentFixture(), documentFixture({ id: 'doc-2', title: '发布方案', version: 3, createdAt: '2026-08-18T08:00:00.000Z', updatedAt: '2026-08-25T09:00:00.000Z' })],
    )

    expect(timeline.map((item) => item.title)).toEqual([
      '《发布方案》更新至第 3 版',
      '会议《复盘会》',
      '《评审纪要》已收录于 Room',
    ])
    expect(timeline.every((item) => item.generated)).toBe(true)
  })

  it('skips drafts, deleted documents and unparseable meeting times', () => {
    const timeline = deriveRoomTimeline(
      { timeline: [] },
      contextFixture([{ title: '待定会议', when: '待定', participants: [], sourceTitle: '纪要' }]),
      [documentFixture({ status: 'draft' }), documentFixture({ id: 'doc-x', deletedAt: '2026-08-20T00:00:00.000Z' })],
    )

    expect(timeline).toEqual([])
  })

  it('preserves manual entries and drops generated duplicates of them', () => {
    const manual: ContextRoomTimelineItem = { time: '今天 09:00', title: '手工事件', description: '用户记录', kind: 'warn' }
    const duplicated: ContextRoomTimelineItem = { ...manual, generated: true }

    const timeline = deriveRoomTimeline({ timeline: [manual, duplicated] }, contextFixture(), [])

    expect(timeline).toEqual([manual])
  })

  it('sorts by parsed time descending and caps the derived tail', () => {
    const documents = Array.from({ length: 60 }, (_, index) => documentFixture({
      id: `doc-${index}`,
      title: `文档${index}`,
      createdAt: `2026-08-${String((index % 20) + 1).padStart(2, '0')}T08:00:00.000Z`,
      updatedAt: `2026-08-${String((index % 20) + 1).padStart(2, '0')}T08:00:00.000Z`,
    }))
    const timeline = deriveRoomTimeline({ timeline: [] }, contextFixture(), documents)

    expect(timeline).toHaveLength(50)
    const times = timeline.map((item) => parseTimelineDate(item.time, NOW)!.getTime())
    expect([...times].sort((left, right) => right - left)).toEqual(times)
  })
})
