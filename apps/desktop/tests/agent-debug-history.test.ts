import { describe, expect, it } from 'vitest'

import type { AgentDebugArchiveInfo, AgentDebugRun } from '@nxcore/agent-contract'

import { formatMonthDayTime } from '../src/renderer/src/agent-debug/format'
import {
  ALL_SESSIONS,
  archiveSummaryOf,
  buildSessionOptions,
  emptyRunsText,
  filterRunsByOrigin,
  filterRunsBySession,
  findSessionOption,
  groupRunsBySession,
  isArchivedRun,
  latestArchivedRunId,
  originOf,
  RANGE_MODES,
  sessionKeyOf,
  sessionLabelOf,
  sessionPrimaryOf,
  sessionShortId,
  snapshotQueryFor,
  snapshotSearchParams,
  sortRunsByActivity,
} from '../src/renderer/src/agent-debug/history'

let sequence = 0

function makeRun(partial: Partial<AgentDebugRun> = {}): AgentDebugRun {
  sequence += 1
  return {
    runId: `run-${sequence}`,
    agentId: 'main',
    agentName: 'Main',
    agentKind: 'builtin',
    runtimeId: 'pi:main',
    sessionId: null,
    pageLabel: null,
    task: '示例任务',
    status: 'completed',
    startedAt: '2026-10-23T02:00:00.000Z',
    completedAt: '2026-10-23T02:01:00.000Z',
    eventCount: 3,
    droppedEvents: 0,
    toolCallCount: 1,
    reasoningChars: 10,
    lastEventAt: '2026-10-23T02:00:59.000Z',
    errorMessage: null,
    ...partial,
  }
}

function makeArchiveInfo(partial: Partial<AgentDebugArchiveInfo> = {}): AgentDebugArchiveInfo {
  return {
    enabled: true,
    retentionDays: 7,
    runCount: 128,
    bytes: 2048,
    oldestStartedAt: '2026-10-20T00:00:00.000Z',
    ...partial,
  }
}

/** 用本地时区构造 ISO，保证 formatMonthDayTime 断言与运行环境时区无关。 */
function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

describe('originOf / isArchivedRun / filterRunsByOrigin', () => {
  it('把缺失 origin 的旧数据当作 live', () => {
    expect(originOf({})).toBe('live')
    expect(originOf({ origin: 'live' })).toBe('live')
    expect(originOf({ origin: 'archive' })).toBe('archive')
    expect(isArchivedRun({})).toBe(false)
    expect(isArchivedRun({ origin: 'archive' })).toBe(true)
  })

  it('全部范围返回原样的副本', () => {
    const runs = [makeRun(), makeRun({ origin: 'archive' })]
    const filtered = filterRunsByOrigin(runs, 'all')
    expect(filtered).toEqual(runs)
    expect(filtered).not.toBe(runs)
  })

  it('本次 / 历史范围按 origin 拆分，旧数据算本次', () => {
    const live = makeRun({ origin: 'live' })
    const legacy = makeRun()
    const archived = makeRun({ origin: 'archive' })
    expect(filterRunsByOrigin([live, legacy, archived], 'live').map((run) => run.runId))
      .toEqual([live.runId, legacy.runId])
    expect(filterRunsByOrigin([live, legacy, archived], 'archive').map((run) => run.runId))
      .toEqual([archived.runId])
  })
})

describe('sessionKeyOf / sessionLabelOf', () => {
  it('sessionId 去空白，无会话为空字符串', () => {
    expect(sessionKeyOf({ sessionId: '  session-1  ' })).toBe('session-1')
    expect(sessionKeyOf({ sessionId: null })).toBe('')
    expect(sessionKeyOf({ sessionId: '   ' })).toBe('')
  })

  it('标签优先 sessionTitle，其次 pageLabel，再退回 sessionId 前 8 位', () => {
    expect(sessionLabelOf({
      sessionId: 'session-1',
      sessionTitle: '周会纪要整理',
      pageLabel: 'Home',
    })).toBe('周会纪要整理')
    expect(sessionLabelOf({ sessionId: 'session-1', sessionTitle: null, pageLabel: 'Home' })).toBe('Home')
    expect(sessionLabelOf({
      sessionId: 'abcdef0123456789',
      sessionTitle: null,
      pageLabel: null,
    })).toBe('abcdef01')
    expect(sessionLabelOf({ sessionId: null, sessionTitle: null, pageLabel: null })).toBe('无会话')
    // 纯空白标题不能当作有效标题
    expect(sessionLabelOf({ sessionId: 'abcdef0123456789', sessionTitle: '  ', pageLabel: null }))
      .toBe('abcdef01')
  })
})

describe('sessionShortId / sessionPrimaryOf', () => {
  it('短 id 取前 8 位，无会话为空', () => {
    expect(sessionShortId('abcdef0123456789')).toBe('abcdef01')
    expect(sessionShortId('  abc  ')).toBe('abc')
    expect(sessionShortId(null)).toBe('')
    expect(sessionShortId('   ')).toBe('')
  })

  it('主名优先标题，其次任务摘要，再 pageLabel / 短 id / 无会话', () => {
    expect(sessionPrimaryOf({
      sessionId: 's1',
      sessionTitle: '周会纪要整理',
      pageLabel: 'Home',
      task: '帮我整理周会',
    })).toBe('周会纪要整理')
    expect(sessionPrimaryOf({
      sessionId: 's1',
      sessionTitle: null,
      pageLabel: 'Home',
      task: '帮我整理周会',
    })).toBe('帮我整理周会')
    expect(sessionPrimaryOf({
      sessionId: 's1',
      sessionTitle: null,
      pageLabel: 'Home',
      task: '',
    })).toBe('Home')
    expect(sessionPrimaryOf({
      sessionId: 'abcdef0123456789',
      sessionTitle: null,
      pageLabel: null,
      task: '',
    })).toBe('abcdef01')
    expect(sessionPrimaryOf({
      sessionId: null,
      sessionTitle: null,
      pageLabel: null,
      task: '',
    })).toBe('无会话')
  })
})

describe('buildSessionOptions', () => {
  it('没有 run 时只有「全部会话」', () => {
    const options = buildSessionOptions([])
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ key: ALL_SESSIONS, label: '全部会话', count: 0, shortId: '' })
  })

  it('按首次出现顺序去重计数，「无会话」最后；标签带首次时间与短 id', () => {
    const runs = [
      makeRun({
        sessionId: 's1',
        sessionTitle: '会话一',
        startedAt: localIso(2026, 10, 23, 2, 0),
        origin: 'archive',
      }),
      makeRun({
        sessionId: 's2',
        sessionTitle: '会话二',
        startedAt: localIso(2026, 10, 23, 3, 0),
      }),
      makeRun({
        sessionId: 's1',
        sessionTitle: '会话一',
        startedAt: localIso(2026, 10, 23, 2, 5),
        origin: 'archive',
      }),
      makeRun({
        sessionId: null,
        startedAt: localIso(2026, 10, 23, 2, 0),
      }),
      makeRun({
        sessionId: 's3',
        pageLabel: 'Home',
        task: '还没生成标题的会话',
        startedAt: localIso(2026, 10, 23, 4, 0),
      }),
    ]
    const options = buildSessionOptions(runs)
    expect(options.map((option) => option.key)).toEqual([ALL_SESSIONS, 's1', 's2', 's3', ''])
    expect(options.map((option) => option.label)).toEqual([
      '全部会话',
      '会话一 · 10-23 02:00 · #s1',
      '会话二 · 10-23 03:00 · #s2',
      '还没生成标题的会话 · 10-23 04:00 · #s3',
      '无会话 · 10-23 02:00',
    ])
    expect(options[1]).toMatchObject({ primary: '会话一', shortId: 's1', count: 2 })
    expect(options[4]).toMatchObject({ primary: '无会话', shortId: '', count: 1 })
  })

  it('标题相同的两个会话靠时间与短 id 区分（不再出现两个一模一样的选项）', () => {
    const runs = [
      makeRun({
        sessionId: 'aaaa1111-0000-0000-0000-000000000000',
        sessionTitle: '周报整理',
        startedAt: localIso(2026, 10, 23, 9, 0),
      }),
      makeRun({
        sessionId: 'bbbb2222-0000-0000-0000-000000000000',
        sessionTitle: '周报整理',
        startedAt: localIso(2026, 10, 23, 15, 30),
      }),
    ]
    const labels = buildSessionOptions(runs).slice(1).map((option) => option.label)
    expect(labels[0]).toBe('周报整理 · 10-23 09:00 · #aaaa1111')
    expect(labels[1]).toBe('周报整理 · 10-23 15:30 · #bbbb2222')
    expect(new Set(labels).size).toBe(2)
  })

  it('首条 run 无标题时用后续 run 的标题补全主名', () => {
    const runs = [
      makeRun({ sessionId: 'session-1', pageLabel: 'Home', sessionTitle: null, task: '临时任务' }),
      makeRun({ sessionId: 'session-1', pageLabel: null, sessionTitle: '长期记忆整理', origin: 'archive' }),
    ]
    const options = buildSessionOptions(runs)
    expect(options[1]).toMatchObject({ key: 'session-1', primary: '长期记忆整理', count: 2 })
  })

  it('title 属性包含完整 sessionId / 时间范围 / run 数，供 hover 辨认', () => {
    const sessionId = 'abcdef0123456789'
    const runs = [
      makeRun({ sessionId, sessionTitle: '周会纪要', startedAt: localIso(2026, 10, 23, 2, 0) }),
      makeRun({ sessionId, sessionTitle: '周会纪要', startedAt: localIso(2026, 10, 23, 2, 30), origin: 'archive' }),
    ]
    const option = buildSessionOptions(runs)[1]!
    expect(option.title).toContain(sessionId)
    expect(option.title).toContain('2 个 run')
    expect(option.title).toContain('2026-10-23T')
  })
})

describe('groupRunsBySession / sortRunsByActivity', () => {
  it('组内运行中优先、其次最近活动；组按「含运行中 → 最近活动」排序，无会话最后', () => {
    const runs = [
      makeRun({
        sessionId: 's-old',
        sessionTitle: '旧会话',
        startedAt: localIso(2026, 10, 23, 1, 0),
        lastEventAt: localIso(2026, 10, 23, 1, 5),
      }),
      makeRun({
        sessionId: 's-new',
        sessionTitle: '新会话',
        startedAt: localIso(2026, 10, 23, 5, 0),
        lastEventAt: localIso(2026, 10, 23, 5, 30),
      }),
      makeRun({
        sessionId: 's-old',
        sessionTitle: '旧会话',
        startedAt: localIso(2026, 10, 23, 1, 10),
        lastEventAt: localIso(2026, 10, 23, 1, 20),
        origin: 'archive',
      }),
      makeRun({
        sessionId: null,
        startedAt: localIso(2026, 10, 23, 6, 0),
        status: 'running',
      }),
    ]
    const groups = groupRunsBySession(runs)
    // 含运行中的「无会话」组排最前，其余按最近活动：s-new > s-old。
    expect(groups.map((group) => group.option.key)).toEqual(['', 's-new', 's-old'])
    expect(groups[0]!.runs).toHaveLength(1)
    expect(groups[2]!.runs.map((run) => run.startedAt)).toEqual([
      localIso(2026, 10, 23, 1, 10),
      localIso(2026, 10, 23, 1, 0),
    ])
  })

  it('sortRunsByActivity 把 running 放最前，其余按 lastEventAt 倒序', () => {
    const running = makeRun({ status: 'running', lastEventAt: localIso(2026, 10, 23, 0, 10) })
    const old = makeRun({ lastEventAt: localIso(2026, 10, 23, 1, 0) })
    const recent = makeRun({ lastEventAt: localIso(2026, 10, 23, 2, 0) })
    expect(sortRunsByActivity([old, recent, running]).map((run) => run.runId))
      .toEqual([running.runId, recent.runId, old.runId])
  })

  it('findSessionOption 查不到时返回 null', () => {
    const options = buildSessionOptions([makeRun({ sessionId: 's1', sessionTitle: '会话一' })])
    expect(findSessionOption(options, 's1')?.primary).toBe('会话一')
    expect(findSessionOption(options, 'missing')).toBeNull()
    expect(findSessionOption(options, ALL_SESSIONS)?.key).toBe(ALL_SESSIONS)
  })
})

describe('filterRunsBySession', () => {
  const runs = [
    makeRun({ sessionId: 's1' }),
    makeRun({ sessionId: 's2' }),
    makeRun({ sessionId: null }),
  ]

  it('全部会话 / null / undefined 表示不过滤', () => {
    expect(filterRunsBySession(runs, ALL_SESSIONS)).toEqual(runs)
    expect(filterRunsBySession(runs, null)).toEqual(runs)
    expect(filterRunsBySession(runs, undefined)).toEqual(runs)
  })

  it('按 sessionId 过滤，空字符串只留「无会话」', () => {
    expect(filterRunsBySession(runs, 's1').map((run) => run.sessionId)).toEqual(['s1'])
    expect(filterRunsBySession(runs, '')).toHaveLength(1)
    expect(filterRunsBySession(runs, '')[0]!.sessionId).toBeNull()
    expect(filterRunsBySession(runs, 'missing')).toEqual([])
  })
})

describe('snapshotQueryFor / snapshotSearchParams', () => {
  it('范围三态映射到 runs 与 archived', () => {
    expect(snapshotQueryFor('all')).toEqual({ runs: 150, archived: 'include' })
    expect(snapshotQueryFor('live')).toEqual({ runs: 150, archived: 'exclude' })
    expect(snapshotQueryFor('archive')).toEqual({ runs: 300, archived: 'only' })
  })

  it('查询串稳定、缺省补全', () => {
    expect(snapshotSearchParams()).toBe('runs=150&archived=include')
    expect(snapshotSearchParams({ runs: 300, archived: 'only' })).toBe('runs=300&archived=only')
    expect(snapshotSearchParams({ archived: 'exclude' })).toBe('runs=150&archived=exclude')
  })

  it('三态按钮的文案顺序为 全部 / 本次 / 历史', () => {
    expect(RANGE_MODES.map((mode) => mode.label)).toEqual(['全部', '本次', '历史'])
  })
})

describe('latestArchivedRunId', () => {
  it('没有归档 run 时为 null', () => {
    expect(latestArchivedRunId([])).toBeNull()
    expect(latestArchivedRunId([makeRun({ origin: 'live' })])).toBeNull()
  })

  it('取归档里 startedAt 最新的一条（忽略本次 run）', () => {
    const live = makeRun({ origin: 'live', startedAt: '2026-10-23T09:00:00.000Z' })
    const older = makeRun({ origin: 'archive', startedAt: '2026-10-20T09:00:00.000Z' })
    const newest = makeRun({ origin: 'archive', startedAt: '2026-10-22T09:00:00.000Z' })
    expect(latestArchivedRunId([live, older, newest])).toBe(newest.runId)
  })
})

describe('archiveSummaryOf', () => {
  it('归档信息缺失（旧 Gateway / 首次快照未回）返回 null', () => {
    expect(archiveSummaryOf(null)).toBeNull()
    expect(archiveSummaryOf(undefined)).toBeNull()
  })

  it('归档关闭时提示「历史未启用」且不可用', () => {
    const summary = archiveSummaryOf(makeArchiveInfo({ enabled: false, retentionDays: 0, runCount: 0, bytes: 0, oldestStartedAt: null }))
    expect(summary).toEqual({
      enabled: false,
      text: '历史未启用',
      title: '历史归档已关闭（NXCORE_AGENT_DEBUG_ARCHIVE=0），run 结束后不会写入磁盘',
    })
  })

  it('归档开启时给出条数/保留天数，title 带字节与最旧时间', () => {
    const now = Date.parse('2026-10-24T00:00:00.000Z')
    const summary = archiveSummaryOf(makeArchiveInfo(), now)
    expect(summary?.enabled).toBe(true)
    expect(summary?.text).toBe('历史 128 条 · 保留 7 天')
    expect(summary?.title).toContain('归档 2.0 KB')
    expect(summary?.title).toContain('2026-10-20T00:00:00.000Z')
  })

  it('空归档的 title 不出现最旧时间', () => {
    const summary = archiveSummaryOf(makeArchiveInfo({ runCount: 0, bytes: 0, oldestStartedAt: null }))
    expect(summary?.text).toBe('历史 0 条 · 保留 7 天')
    expect(summary?.title).toBe('归档 0 B')
  })

  it('retentionDays<=0（离线读取归档来源）时只报条数并标「只读」，title 仍给字节与最旧时间', () => {
    const summary = archiveSummaryOf(makeArchiveInfo({ retentionDays: 0, runCount: 586 }))
    expect(summary?.enabled).toBe(true)
    expect(summary?.text).toBe('历史 586 条 · 只读')
    expect(summary?.title).toContain('归档 2.0 KB')
    expect(summary?.title).toContain('2026-10-20T00:00:00.000Z')
    expect(summary?.text).not.toContain('保留')
    // 负数（异常配置）同样按未知处理。
    expect(archiveSummaryOf(makeArchiveInfo({ retentionDays: -1 }))?.text).toBe('历史 128 条 · 只读')
  })
})

describe('emptyRunsText', () => {
  it('会话筛选优先，其次区分本次 / 历史 / 全部', () => {
    expect(emptyRunsText({ mode: 'archive', sessionFiltered: true, agentFiltered: false })).toBe('该会话暂无 run')
    expect(emptyRunsText({ mode: 'archive', sessionFiltered: false, agentFiltered: false })).toBe('暂无历史记录')
    expect(emptyRunsText({ mode: 'live', sessionFiltered: false, agentFiltered: false })).toBe('本次暂无 run')
    expect(emptyRunsText({ mode: 'all', sessionFiltered: false, agentFiltered: true })).toBe('该 Agent 暂无 run')
    expect(emptyRunsText({ mode: 'all', sessionFiltered: false, agentFiltered: false })).toBe('暂无 run')
  })
})

describe('formatMonthDayTime', () => {
  it('输出本地时区的 MM-DD HH:mm', () => {
    expect(formatMonthDayTime(new Date(2026, 9, 23, 14, 5).toISOString())).toBe('10-23 14:05')
    expect(formatMonthDayTime(new Date(2026, 0, 2, 3, 4).toISOString())).toBe('01-02 03:04')
  })

  it('缺失或非法时间返回占位符', () => {
    expect(formatMonthDayTime(null)).toBe('—')
    expect(formatMonthDayTime(undefined)).toBe('—')
    expect(formatMonthDayTime('not-a-date')).toBe('—')
  })
})
