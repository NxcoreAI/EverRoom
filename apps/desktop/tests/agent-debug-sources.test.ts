import { describe, expect, it } from 'vitest'

import type { DebugSource } from '../src/renderer/src/agent-debug/api'
import {
  ARCHIVE_CONNECTION_LABEL,
  isArchiveSource,
  orderDebugSources,
  pickSourceId,
  sourceConnectionLabel,
  sourceConnectionTitle,
  sourceLabel,
  sourceTitle,
} from '../src/renderer/src/agent-debug/sources'

let sequence = 0

function makeLive(partial: Partial<DebugSource> = {}): DebugSource {
  sequence += 1
  return {
    id: `live-${sequence}`,
    label: `网关 ${sequence}`,
    baseUrl: `http://127.0.0.1:${5000 + sequence}`,
    version: '1.0.0',
    backend: 'live',
    available: true,
    archiveDir: null,
    runCount: 0,
    latestStartedAt: null,
    ...partial,
  }
}

function makeArchive(partial: Partial<DebugSource> = {}): DebugSource {
  sequence += 1
  return makeLive({
    id: `archive-${sequence}`,
    label: `历史归档 · main-${sequence}`,
    baseUrl: '',
    version: '',
    backend: 'archive',
    available: true,
    archiveDir: `/data/agent-debug/main-${sequence}`,
    runCount: 586,
    latestStartedAt: '2026-10-26T10:00:00.000Z',
    ...partial,
  })
}

describe('isArchiveSource', () => {
  it('只把 backend=archive 当作归档来源，缺省 / null 都算 live', () => {
    expect(isArchiveSource({ backend: 'archive' })).toBe(true)
    expect(isArchiveSource({ backend: 'live' })).toBe(false)
    expect(isArchiveSource(null)).toBe(false)
    expect(isArchiveSource(undefined)).toBe(false)
  })
})

describe('sourceLabel', () => {
  it('live：标签 + v版本；不可用时追加「 · 离线」', () => {
    const source = makeLive({ label: '主网关', version: '1.2.3' })
    expect(sourceLabel(source)).toBe('主网关 · v1.2.3')
    expect(sourceLabel({ ...source, version: '' })).toBe('主网关')
    expect(sourceLabel({ ...source, available: false })).toBe('主网关 · v1.2.3 · 离线')
  })

  it('archive：历史归档标签 + 「 · 只读」，不再重复前缀、不追加离线', () => {
    const source = makeArchive({ label: '历史归档 · 主网关', version: '' })
    expect(sourceLabel(source)).toBe('历史归档 · 主网关 · 只读')
    // host 若只给目录名，页面补「历史归档 · 」前缀。
    expect(sourceLabel({ ...source, label: 'main' })).toBe('历史归档 · main · 只读')
    // archive 恒可用；即使 host 误标 available=false 也不显示「离线」。
    expect(sourceLabel({ ...source, available: false })).toBe('历史归档 · 主网关 · 只读')
  })
})

describe('sourceTitle', () => {
  it('live 给代理目标，离线来源额外说明不可用原因', () => {
    const source = makeLive({ baseUrl: 'http://127.0.0.1:5310' })
    expect(sourceTitle(source)).toBe('代理目标 http://127.0.0.1:5310')
    expect(sourceTitle({ ...source, available: false })).toContain('当前不可用')
  })

  it('archive 给归档目录 / run 条数 / 最新时间', () => {
    const title = sourceTitle(makeArchive({ archiveDir: '/tmp/data/agent-debug/main' }))
    expect(title).toContain('归档目录 /tmp/data/agent-debug/main')
    expect(title).toContain('共 586 条历史 run')
    expect(title).toContain('2026-10-26T10:00:00.000Z')
  })

  it('archive 缺目录/最新时间时降级为占位文案', () => {
    const title = sourceTitle(makeArchive({ archiveDir: null, latestStartedAt: null }))
    expect(title).toContain('未知目录')
    expect(title).not.toContain('最新')
  })
})

describe('orderDebugSources', () => {
  it('可用 live（发现顺序）→ archive（发现顺序）→ 不可用 live', () => {
    const liveA = makeLive({ label: 'A' })
    const liveB = makeLive({ label: 'B', available: false })
    const liveC = makeLive({ label: 'C' })
    const archive1 = makeArchive({ label: '历史归档 · main' })
    const archive2 = makeArchive({ label: '历史归档 · cursor-completion' })
    const ordered = orderDebugSources([archive1, liveA, liveB, archive2, liveC])
    expect(ordered.map((source) => source.id)).toEqual([
      liveA.id,
      liveC.id,
      archive1.id,
      archive2.id,
      liveB.id,
    ])
  })

  it('不修改入参，空列表返回空数组', () => {
    const sources = [makeLive({ available: false }), makeArchive()]
    const before = sources.map((source) => source.id)
    orderDebugSources(sources)
    expect(sources.map((source) => source.id)).toEqual(before)
    expect(orderDebugSources([])).toEqual([])
  })
})

describe('pickSourceId', () => {
  it('初始：优先第一个可用 live，其次 archive，最后第一个来源', () => {
    const live = makeLive()
    const archive = makeArchive()
    // host 顺序是 live 在前，这里故意打乱验证页面自己排序。
    expect(pickSourceId([archive, live], null)).toBe(live.id)
    expect(pickSourceId([makeLive({ available: false }), archive], null)).toBe(archive.id)
    expect(pickSourceId([] as DebugSource[], null)).toBeNull()
  })

  it('当前来源仍可用则保持（即使后面有别的可用来源）', () => {
    const liveA = makeLive()
    const liveB = makeLive()
    expect(pickSourceId([liveA, liveB], liveB.id)).toBe(liveB.id)
    // 用户手动选中 archive 后，live 恢复也不把他弹回去。
    const archive = makeArchive()
    expect(pickSourceId([liveA, archive], archive.id)).toBe(archive.id)
  })

  it('当前 live 变不可用且有可用 archive 时自动切换（EverRoom 退出 → 历史归档）', () => {
    const live = makeLive({ available: false })
    const archive = makeArchive()
    expect(pickSourceId([live, archive], live.id)).toBe(archive.id)
  })

  it('当前来源不在列表里时取排序后的第一个', () => {
    const live = makeLive()
    const archive = makeArchive()
    expect(pickSourceId([archive, live], 'missing-id')).toBe(live.id)
  })

  it('全部不可用时仍选第一个（不可用 live 排最前），列表为空才返回 null', () => {
    const first = makeLive({ available: false, label: '先发现的' })
    const second = makeLive({ available: false, label: '后发现的' })
    expect(pickSourceId([first, second], null)).toBe(first.id)
    expect(pickSourceId([], 'gone')).toBeNull()
  })

  it('没有 live 只有 archive 时默认选中 archive', () => {
    const archive1 = makeArchive()
    const archive2 = makeArchive()
    expect(pickSourceId([archive1, archive2], null)).toBe(archive1.id)
  })
})

describe('sourceConnectionLabel / sourceConnectionTitle', () => {
  it('archive 来源固定显示「历史归档 · 只读」，live 交给轮询状态', () => {
    expect(sourceConnectionLabel(makeArchive())).toBe(ARCHIVE_CONNECTION_LABEL)
    expect(ARCHIVE_CONNECTION_LABEL).toBe('历史归档 · 只读')
    expect(sourceConnectionLabel(makeLive())).toBeNull()
    expect(sourceConnectionLabel(null)).toBeNull()
  })

  it('archive 连接态 title 给归档目录与「无需 EverRoom 运行」', () => {
    const title = sourceConnectionTitle(makeArchive({ archiveDir: '/tmp/data/agent-debug/main' }))
    expect(title).toContain('/tmp/data/agent-debug/main')
    expect(title).toContain('无需 EverRoom 运行')
    expect(sourceConnectionTitle(makeLive())).toBeNull()
    expect(sourceConnectionTitle(null)).toBeNull()
  })
})
