import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'

import {
  ARCHIVE_SOURCE_NAMES,
  DebugArchiveSource,
  archiveSourceId,
  archiveSourceLabel,
  discoverArchiveSources,
  parseIndex,
  resolveArchivePath,
} from '../debug/host/archive-source'
import {
  isProcessAlive,
  parseArchiveEventsQuery,
  parseArchiveSnapshotQuery,
} from '../vite.agent-debug.config.mts'

let sequence = 0

function makeRun(overrides: Partial<AgentDebugRun> = {}): AgentDebugRun {
  sequence += 1
  return {
    runId: `run-${sequence}`,
    agentId: 'main',
    agentName: 'Main Agent',
    agentKind: 'builtin',
    runtimeId: 'pi:main',
    sessionId: null,
    pageLabel: null,
    task: '示例任务',
    status: 'completed',
    startedAt: '2026-10-23T02:00:00.000Z',
    completedAt: '2026-10-23T02:01:00.000Z',
    eventCount: 0,
    droppedEvents: 0,
    toolCallCount: 0,
    reasoningChars: 0,
    lastEventAt: '2026-10-23T02:00:59.000Z',
    errorMessage: null,
    ...overrides,
  }
}

function makeEvent(seq: number, overrides: Partial<AgentDebugEvent> = {}): AgentDebugEvent {
  return {
    seq,
    type: 'message.delta',
    occurredAt: `2026-10-23T02:00:0${seq}.000Z`,
    payload: { delta: `chunk-${seq}` },
    ...overrides,
  }
}

function dayDirOf(startedAt: string): string {
  const date = new Date(startedAt)
  const year = date.getUTCFullYear().toString().padStart(4, '0')
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = date.getUTCDate().toString().padStart(2, '0')
  return `${year}${month}${day}`
}

interface ArchiveFixture {
  run: AgentDebugRun
  events?: AgentDebugEvent[]
}

interface MaterializeOptions {
  /** `valid`（默认）写 index.json；`missing` 不写；`corrupt` 写坏 JSON；`raw` 写 customIndex。 */
  index?: 'valid' | 'missing' | 'corrupt' | 'raw'
  customIndex?: string
}

/**
 * 在临时目录里造一个真实形状的归档（index.json + runs/<YYYYMMDD>/*.ndjson），
 * 返回 index.json 里应出现的条目形状（便于断言）。
 */
function materializeArchive(
  dir: string,
  fixtures: ArchiveFixture[],
  options: MaterializeOptions = {},
): Array<{ run: AgentDebugRun; file: string; bytes: number }> {
  mkdirSync(dir, { recursive: true })
  const entries: Array<{ run: AgentDebugRun; file: string; bytes: number }> = []
  for (const fixture of fixtures) {
    const { run, events = [] } = fixture
    const relativeFile = `runs/${dayDirOf(run.startedAt)}/${run.runId}.ndjson`
    const absoluteFile = join(dir, relativeFile)
    mkdirSync(dirname(absoluteFile), { recursive: true })
    const lines = [
      JSON.stringify({ kind: 'run', run }),
      ...events.map((event) => JSON.stringify({ kind: 'event', event })),
    ]
    const content = `${lines.join('\n')}\n`
    writeFileSync(absoluteFile, content)
    entries.push({ run, file: relativeFile, bytes: Buffer.byteLength(content) })
  }

  const mode = options.index ?? 'valid'
  if (mode === 'missing') return entries
  if (mode === 'corrupt') {
    writeFileSync(join(dir, 'index.json'), '{not json')
    return entries
  }
  if (mode === 'raw') {
    writeFileSync(join(dir, 'index.json'), options.customIndex ?? '')
    return entries
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, runs: entries }))
  return entries
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-debug-archive-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseIndex（纯函数）', () => {
  it('接受合法索引并保留 run / file / bytes', () => {
    const run = makeRun()
    const entries = parseIndex(JSON.stringify({ version: 1, runs: [{ run, file: 'runs/20261023/run-1.ndjson', bytes: 42 }] }))
    expect(entries).toHaveLength(1)
    expect(entries?.[0]?.run.runId).toBe(run.runId)
    expect(entries?.[0]?.file).toBe('runs/20261023/run-1.ndjson')
    expect(entries?.[0]?.bytes).toBe(42)
  })

  it('JSON 损坏 / version 不符 / 条目残缺时返回 null（触发内存重建）', () => {
    expect(parseIndex('{not json')).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 2, runs: [] }))).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 1, runs: 'oops' }))).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 1, runs: [{ run: { runId: '' }, file: 'x' }] }))).toBeNull()
    expect(parseIndex(JSON.stringify({ version: 1, runs: [{ run: makeRun(), file: '' }] }))).toBeNull()
  })
})

describe('DebugArchiveSource.listRuns / getRun', () => {
  it('按 startedAt 倒序、截断 limit，并补 origin:"archive" / sessionTitle:null', () => {
    const dir = join(makeTempDir(), 'main')
    const older = makeRun({ runId: 'run-older', startedAt: '2026-10-22T01:00:00.000Z' })
    const newer = makeRun({ runId: 'run-newer', startedAt: '2026-10-23T01:00:00.000Z' })
    const middle = makeRun({ runId: 'run-middle', startedAt: '2026-10-22T12:00:00.000Z' })
    materializeArchive(dir, [{ run: older }, { run: newer }, { run: middle }])

    const source = new DebugArchiveSource(dir)
    const runs = source.listRuns(10)
    expect(runs.map((run) => run.runId)).toEqual(['run-newer', 'run-middle', 'run-older'])
    expect(runs.every((run) => run.origin === 'archive')).toBe(true)
    expect(runs.every((run) => run.sessionTitle === null)).toBe(true)
    expect(source.listRuns(2).map((run) => run.runId)).toEqual(['run-newer', 'run-middle'])
    expect(source.listRuns(0)).toEqual([])
  })

  it('getRun 命中返回 archive 副本，未知 run 返回 null', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-hit' })
    materializeArchive(dir, [{ run }])
    const source = new DebugArchiveSource(dir)
    expect(source.getRun('run-hit')).toMatchObject({ runId: 'run-hit', origin: 'archive', sessionTitle: null })
    expect(source.getRun('run-missing')).toBeNull()
  })
})

describe('DebugArchiveSource.readEvents', () => {
  it('返回 seq > afterSeq 的升序事件、按 limit 截断，latestSeq 取文件内最大 seq', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-events' })
    const events = [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)]
    materializeArchive(dir, [{ run, events }])
    const source = new DebugArchiveSource(dir)

    expect(source.readEvents('run-events')).toEqual({ events, latestSeq: 4 })
    expect(source.readEvents('run-events', 2)).toEqual({ events: [events[2], events[3]], latestSeq: 4 })
    expect(source.readEvents('run-events', 0, 2)).toEqual({ events: [events[0], events[1]], latestSeq: 4 })
    expect(source.readEvents('run-events', 4)).toEqual({ events: [], latestSeq: 4 })
    expect(source.readEvents('run-events', 4, 10).latestSeq).toBe(4)
    expect(source.readEvents('run-missing')).toBeNull()
  })

  it('坏行（半行 / 非 JSON）跳过，不影响其余事件与 latestSeq', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-bad-lines' })
    materializeArchive(dir, [{ run, events: [makeEvent(1), makeEvent(3)] }])
    const file = join(dir, `runs/${dayDirOf(run.startedAt)}/run-bad-lines.ndjson`)
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    // 在两条合法事件之间插入半行与一条 kind 不对的 JSON。
    writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n{"kind":"event","event":\n{"kind":"unknown"}\n${lines.slice(2).join('\n')}\n`)

    const source = new DebugArchiveSource(dir)
    const page = source.readEvents('run-bad-lines')
    expect(page?.events.map((event) => event.seq)).toEqual([1, 3])
    expect(page?.latestSeq).toBe(3)
  })

  it('索引指向不存在的文件时返回 null（不抛异常）', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-ghost' })
    materializeArchive(dir, [], {
      index: 'raw',
      customIndex: JSON.stringify({ version: 1, runs: [{ run, file: 'runs/20261023/run-ghost.ndjson', bytes: 1 }] }),
    })
    const source = new DebugArchiveSource(dir)
    expect(source.readEvents('run-ghost')).toBeNull()
  })
})

describe('索引缺失 / 损坏时内存重建（绝不写盘）', () => {
  it('index.json 缺失时扫描 runs/**/*.ndjson 首行重建，且不创建 index.json', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-rebuilt', startedAt: '2026-10-24T03:00:00.000Z' })
    materializeArchive(dir, [{ run }], { index: 'missing' })

    const source = new DebugArchiveSource(dir)
    expect(source.listRuns(10).map((item) => item.runId)).toEqual(['run-rebuilt'])
    expect(() => readFileSync(join(dir, 'index.json'))).toThrow()
  })

  it('index.json 损坏时重建且不改写原文件', () => {
    const dir = join(makeTempDir(), 'main')
    const run = makeRun({ runId: 'run-corrupt-index' })
    materializeArchive(dir, [{ run }], { index: 'corrupt' })
    const before = readFileSync(join(dir, 'index.json'), 'utf8')

    const source = new DebugArchiveSource(dir)
    expect(source.listRuns(10).map((item) => item.runId)).toEqual(['run-corrupt-index'])
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(before)
  })

  it('空目录返回空快照（enabled:true、runCount:0）', () => {
    const dir = join(makeTempDir(), 'empty-source')
    mkdirSync(dir, { recursive: true })
    const source = new DebugArchiveSource(dir)
    expect(source.listRuns(10)).toEqual([])
    expect(source.info()).toMatchObject({ enabled: true, retentionDays: 0, runCount: 0, bytes: 0, oldestStartedAt: null })
    expect(source.latestStartedAt()).toBeNull()
  })
})

describe('索引缓存', () => {
  it('index.json mtime 变化后重新解析（拿到新 run）', () => {
    const dir = join(makeTempDir(), 'main')
    const first = makeRun({ runId: 'run-first' })
    materializeArchive(dir, [{ run: first }])
    const source = new DebugArchiveSource(dir)
    expect(source.listRuns(10).map((run) => run.runId)).toEqual(['run-first'])

    const second = makeRun({ runId: 'run-second', startedAt: '2026-10-24T01:00:00.000Z' })
    materializeArchive(dir, [{ run: first }, { run: second }])
    // 显式把 mtime 推后，避免同毫秒写入导致缓存不失效。
    const bumped = new Date(Date.now() + 10_000)
    utimesSync(join(dir, 'index.json'), bumped, bumped)

    expect(source.listRuns(10).map((run) => run.runId)).toEqual(['run-second', 'run-first'])
    expect(source.info().runCount).toBe(2)
  })
})

describe('路径安全', () => {
  it('resolveArchivePath 拒绝目录穿越与绝对路径', () => {
    expect(resolveArchivePath('/tmp/archive', 'runs/20261023/a.ndjson')).toBe(join('/tmp/archive', 'runs/20261023/a.ndjson'))
    expect(resolveArchivePath('/tmp/archive', '../escape.ndjson')).toBeNull()
    expect(resolveArchivePath('/tmp/archive', '/etc/passwd')).toBeNull()
    expect(resolveArchivePath('/tmp/archive', 'runs/../../escape.ndjson')).toBeNull()
  })

  it('索引条目路径穿越时 readEvents 拒绝读取', () => {
    const root = makeTempDir()
    const dir = join(root, 'main')
    mkdirSync(dir, { recursive: true })
    const run = makeRun({ runId: 'run-escape' })
    // 归档目录外放一个合法的 ndjson，索引指向它。
    writeFileSync(join(root, 'escape.ndjson'), `${JSON.stringify({ kind: 'event', event: makeEvent(1) })}\n`)
    materializeArchive(dir, [], {
      index: 'raw',
      customIndex: JSON.stringify({ version: 1, runs: [{ run, file: '../escape.ndjson', bytes: 10 }] }),
    })
    const source = new DebugArchiveSource(dir)
    expect(source.getRun('run-escape')).not.toBeNull()
    expect(source.readEvents('run-escape')).toBeNull()
  })
})

describe('agents 聚合与 snapshot', () => {
  it('按 agentId 去重、名称/类型取最新 run、失败/中断态为 error', () => {
    const dir = join(makeTempDir(), 'main')
    const mainOlder = makeRun({
      runId: 'run-main-older',
      agentId: 'main',
      agentName: 'Main Agent',
      status: 'completed',
      startedAt: '2026-10-23T01:00:00.000Z',
      completedAt: '2026-10-23T01:01:00.000Z',
    })
    const mainLatest = makeRun({
      runId: 'run-main-latest',
      agentId: 'main',
      agentName: 'Main Agent v2',
      status: 'failed',
      startedAt: '2026-10-23T03:00:00.000Z',
      completedAt: '2026-10-23T03:01:00.000Z',
    })
    const layoutRun = makeRun({
      runId: 'run-layout',
      agentId: 'slides-layouter',
      agentName: 'Slides Layouter',
      agentKind: 'developer',
      status: 'completed',
      startedAt: '2026-10-23T02:00:00.000Z',
      completedAt: '2026-10-23T02:05:00.000Z',
    })
    materializeArchive(dir, [{ run: mainOlder }, { run: mainLatest }, { run: layoutRun }])

    const agents = new DebugArchiveSource(dir).agents()
    expect(agents.map((agent) => agent.id)).toEqual(['main', 'slides-layouter'])
    expect(agents[0]).toMatchObject({
      id: 'main',
      name: 'Main Agent v2',
      kind: 'builtin',
      description: '',
      state: 'error',
      activeRunCount: 0,
      lastRunAt: '2026-10-23T03:01:00.000Z',
    })
    expect(agents[1]).toMatchObject({ id: 'slides-layouter', kind: 'developer', state: 'idle', activeRunCount: 0 })
  })

  it('snapshot 的 archived 三态：include/only 返回归档 run，exclude 为空', () => {
    const dir = join(makeTempDir(), 'main')
    const older = makeRun({ runId: 'run-older', startedAt: '2026-10-22T01:00:00.000Z' })
    const newer = makeRun({ runId: 'run-newer', startedAt: '2026-10-23T01:00:00.000Z' })
    materializeArchive(dir, [{ run: older }, { run: newer }])
    const source = new DebugArchiveSource(dir)

    const included = source.snapshot(1, 'include')
    expect(included.runs.map((run) => run.runId)).toEqual(['run-newer'])
    expect(included.droppedRuns).toBe(0)
    expect(included.archive).toMatchObject({
      enabled: true,
      retentionDays: 0,
      runCount: 2,
      oldestStartedAt: '2026-10-22T01:00:00.000Z',
    })
    expect(included.archive && included.archive.bytes).toBeGreaterThan(0)
    expect(included.agents).toHaveLength(1)
    expect(Number.isNaN(Date.parse(included.generatedAt))).toBe(false)

    expect(source.snapshot(10, 'only').runs.map((run) => run.runId)).toEqual(['run-newer', 'run-older'])
    const excluded = source.snapshot(10, 'exclude')
    expect(excluded.runs).toEqual([])
    expect(excluded.archive?.runCount).toBe(2)
  })
})

describe('discoverArchiveSources', () => {
  it('只把有 index.json 或 runs/ 的目录当成归档来源，label/id/runCount 正确', () => {
    const dataDir = makeTempDir()
    const archiveRoot = join(dataDir, 'agent-debug')
    const mainRun = makeRun({ runId: 'run-main', startedAt: '2026-10-23T01:00:00.000Z' })
    const cursorRun = makeRun({ runId: 'run-cursor', startedAt: '2026-10-24T01:00:00.000Z' })
    materializeArchive(join(archiveRoot, 'main'), [{ run: mainRun }])
    // 只有 runs/、没有 index.json 也算一个来源（读取器会内存重建）。
    materializeArchive(join(archiveRoot, 'cursor-completion'), [{ run: cursorRun }], { index: 'missing' })
    mkdirSync(join(archiveRoot, 'empty-dir'), { recursive: true })
    writeFileSync(join(archiveRoot, 'not-a-dir.txt'), 'x')

    const factoryCalls: string[] = []
    const discovered = discoverArchiveSources(dataDir, '历史归档', (dir) => {
      factoryCalls.push(dir)
      return new DebugArchiveSource(dir)
    })

    // label 用中文语义名：cursor-completion → 补全服务、main → 主网关。
    expect(discovered.map((entry) => entry.label)).toEqual(['历史归档 · 补全服务', '历史归档 · 主网关'])
    expect(discovered.map((entry) => entry.dir)).toEqual([
      join(archiveRoot, 'cursor-completion'),
      join(archiveRoot, 'main'),
    ])
    expect(discovered.find((entry) => basename(entry.dir) === 'main')?.label).toContain('主网关')
    expect(discovered.find((entry) => basename(entry.dir) === 'cursor-completion')?.label).toContain('补全服务')
    expect(discovered[0]?.id).toBe(archiveSourceId(join(archiveRoot, 'cursor-completion')))
    expect(discovered[0]?.id).toMatch(/^archive-[0-9a-f]{12}$/)
    expect(discovered[0]?.runCount).toBe(1)
    expect(discovered[0]?.latestStartedAt).toBe('2026-10-24T01:00:00.000Z')
    expect(discovered[1]?.latestStartedAt).toBe('2026-10-23T01:00:00.000Z')
    // 每个来源只创建一次读取器，且返回的实例就是工厂给的实例。
    expect(factoryCalls).toHaveLength(2)
    expect(discovered[0]?.source.dir).toBe(discovered[0]?.dir)
  })

  it('dataDir 不存在时返回空数组', () => {
    expect(discoverArchiveSources(join(makeTempDir(), 'missing-data-dir'), '历史归档')).toEqual([])
  })

  it('descriptor 返回 sources 响应需要的全部字段（baseUrl/version 为空串）', () => {
    const dir = join(makeTempDir(), 'main')
    materializeArchive(dir, [{ run: makeRun({ runId: 'run-descriptor', startedAt: '2026-10-23T01:00:00.000Z' }) }])
    const descriptor = new DebugArchiveSource(dir).descriptor('历史归档 · main')
    expect(descriptor).toMatchObject({
      id: archiveSourceId(dir),
      label: '历史归档 · main',
      baseUrl: '',
      version: '',
      backend: 'archive',
      available: true,
      archiveDir: dir,
      runCount: 1,
      latestStartedAt: '2026-10-23T01:00:00.000Z',
    })
  })
})

describe('archive 来源 label 映射（sources 展示）', () => {
  it('main → 主网关、cursor-completion → 补全服务、其它目录名原样', () => {
    expect(ARCHIVE_SOURCE_NAMES).toMatchObject({ main: '主网关', 'cursor-completion': '补全服务' })
    expect(archiveSourceLabel('/data/agent-debug/main')).toBe('历史归档 · 主网关')
    expect(archiveSourceLabel('/data/agent-debug/cursor-completion')).toBe('历史归档 · 补全服务')
    expect(archiveSourceLabel('/data/agent-debug/slides-agent')).toBe('历史归档 · slides-agent')
  })

  it('discover 后 main 目录 label 含「主网关」，descriptor 原样带出', () => {
    const dataDir = makeTempDir()
    const archiveRoot = join(dataDir, 'agent-debug')
    materializeArchive(join(archiveRoot, 'main'), [
      { run: makeRun({ runId: 'run-main-label', startedAt: '2026-10-23T01:00:00.000Z' }) },
    ])
    const discovered = discoverArchiveSources(dataDir)
    const mainEntry = discovered.find((entry) => basename(entry.dir) === 'main')
    expect(mainEntry?.label).toBe('历史归档 · 主网关')
    expect(mainEntry?.source.descriptor(mainEntry.label)).toMatchObject({
      label: '历史归档 · 主网关',
      backend: 'archive',
      baseUrl: '',
      version: '',
      available: true,
    })
  })
})

describe('isProcessAlive（live 来源 available 探测）', () => {
  it('当前进程 alive → true；已退出进程 → false', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(typeof exited.pid).toBe('number')
    expect(isProcessAlive(exited.pid as number)).toBe(false)
  })

  it('非法 pid（0 / 负数 / 非整数）→ false', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })
})

describe('archive 端点查询参数校验（400 语义，与 Gateway typebox 一致）', () => {
  const snapshot = (query: string) => parseArchiveSnapshotQuery(new URLSearchParams(query))
  const events = (query: string) => parseArchiveEventsQuery(new URLSearchParams(query))

  it('archived= 空串 / 非法值 → ok:false（400）；合法值解析', () => {
    expect(snapshot('archived=').ok).toBe(false)
    expect(snapshot('archived=bogus').ok).toBe(false)
    expect(snapshot('archived=only')).toEqual({ ok: true, value: { runs: 150, archived: 'only' } })
  })

  it('runs=abc / 0 / 301 → ok:false（400）；合法值解析', () => {
    expect(snapshot('runs=abc').ok).toBe(false)
    expect(snapshot('runs=0').ok).toBe(false)
    expect(snapshot('runs=301').ok).toBe(false)
    expect(snapshot('runs=1')).toEqual({ ok: true, value: { runs: 1, archived: 'include' } })
    expect(snapshot('runs=5&archived=exclude')).toEqual({ ok: true, value: { runs: 5, archived: 'exclude' } })
  })

  it('events limit=0 / 5001、afterSeq=-1 → ok:false（400）；合法值解析', () => {
    expect(events('limit=0').ok).toBe(false)
    expect(events('limit=5001').ok).toBe(false)
    expect(events('afterSeq=-1').ok).toBe(false)
    expect(events('afterSeq=abc').ok).toBe(false)
    expect(events('afterSeq=5&limit=3')).toEqual({ ok: true, value: { afterSeq: 5, limit: 3 } })
    expect(events('')).toEqual({ ok: true, value: { afterSeq: 0, limit: 1000 } })
  })
})
