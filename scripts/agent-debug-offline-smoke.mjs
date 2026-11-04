#!/usr/bin/env node
// Agent 调试台「离线归档来源」冒烟脚本：不启动 Gateway / EverRoom，验证 Vite dev server
// 直接读 <dataDir>/agent-debug/<source>/ 并返回与 Gateway 相同形状的数据。
//
// 用法：
//   node scripts/agent-debug-offline-smoke.mjs                 # 合成归档 fixture（默认）
//   node scripts/agent-debug-offline-smoke.mjs --archive <dir> # 用真实归档目录（index.json + runs/）
//   node scripts/agent-debug-offline-smoke.mjs --keep          # 保留临时 dataDir（便于排查）
//   node scripts/agent-debug-offline-smoke.mjs --port 5399     # 指定 dev server 端口（默认随机空闲端口）
//
// 脚本自己起 Vite（apps/desktop，AGENT_DEBUG_PORT + NXCORE_DATA_DIR 指向临时目录），
// 断言 sources / snapshot / events 的离线语义，结束后 kill dev server 并清理临时目录。
// 退出码非 0 表示有断言失败。全程只读设备上的归档，不写任何仓库文件。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const VITE_BIN = join(REPO_ROOT, 'apps/desktop/node_modules/vite/bin/vite.js')
const VITE_CONFIG = 'vite.agent-debug.config.mts'
const STALE_TOKEN = 'offline-smoke-stale-token'
const STALE_BASE_URL = 'http://127.0.0.1:1'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const ARCHIVE_ARG = argValue('archive', null)
const KEEP = args.includes('--keep')
const REQUESTED_PORT = Number(argValue('port', '0'))

let failures = 0
async function checkAsync(label, fn) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeNdjson(file, run, events) {
  const content = [
    JSON.stringify({ kind: 'run', run }),
    ...events.map((event) => JSON.stringify({ kind: 'event', event })),
  ].join('\n') + '\n'
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return Buffer.byteLength(content, 'utf8')
}

function makeEvent(seq, type, payload, occurredAt) {
  return { seq, type, occurredAt, payload }
}

/**
 * 造一个最小归档目录：<dataDir>/agent-debug/main/{index.json,runs/20261026/*.ndjson}。
 * 返回 index 里的 run 列表（与真实归档同形状），供断言复用。
 */
export function buildSyntheticArchive(dataDir) {
  const archiveDir = join(dataDir, 'agent-debug', 'main')
  const dayDir = join(archiveDir, 'runs', '20261026')

  const mainRun = {
    runId: 'smoke-run-main-completed',
    agentId: 'main',
    agentName: 'Main Agent',
    agentKind: 'builtin',
    runtimeId: 'pi:main',
    sessionId: 'smoke-session-a',
    pageLabel: 'Home',
    task: '帮我整理锥光品牌介绍并生成大纲',
    status: 'completed',
    startedAt: '2026-10-26T10:00:00.000Z',
    completedAt: '2026-10-26T10:01:00.000Z',
    eventCount: 8,
    droppedEvents: 0,
    toolCallCount: 1,
    reasoningChars: 14,
    lastEventAt: '2026-10-26T10:00:50.000Z',
    errorMessage: null,
  }
  const mainEvents = [
    makeEvent(1, 'run.started', { runId: mainRun.runId }, '2026-10-26T10:00:00.000Z'),
    makeEvent(2, 'reasoning.delta', { delta: '先确认资料范围，再整理大纲。' }, '2026-10-26T10:00:05.000Z'),
    makeEvent(3, 'tool.started', {
      toolCallId: 'call-1',
      name: 'web_search',
      args: { query: '锥光 CYPLORE 品牌' },
    }, '2026-10-26T10:00:10.000Z'),
    makeEvent(4, 'tool.completed', {
      toolCallId: 'call-1',
      name: 'web_search',
      result: { content: [{ type: 'text', text: '锥光是一家智能骑行科技品牌。' }] },
    }, '2026-10-26T10:00:20.000Z'),
    makeEvent(5, 'message.delta', { delta: '我来整理锥光品牌介绍。' }, '2026-10-26T10:00:30.000Z'),
    makeEvent(6, 'message.completed', { content: '我来整理锥光品牌介绍。' }, '2026-10-26T10:00:40.000Z'),
    makeEvent(7, 'context.usage', { tokens: 12_000, contextWindow: 64_000, percent: 18.75 }, '2026-10-26T10:00:45.000Z'),
    makeEvent(8, 'run.completed', { status: 'completed' }, '2026-10-26T10:00:50.000Z'),
  ]

  const layoutRun = {
    runId: 'smoke-run-layouter-failed',
    agentId: 'slides-layouter',
    agentName: 'Slides Layouter',
    agentKind: 'developer',
    runtimeId: 'pi',
    sessionId: 'smoke-session-b',
    pageLabel: 'Subagent: Slides Layouter',
    task: '单页布局',
    status: 'failed',
    startedAt: '2026-10-26T09:00:00.000Z',
    completedAt: '2026-10-26T09:00:30.000Z',
    eventCount: 3,
    droppedEvents: 0,
    toolCallCount: 0,
    reasoningChars: 8,
    lastEventAt: '2026-10-26T09:00:30.000Z',
    errorMessage: '503: AI relay session is not active',
    slidePageIndex: 3,
    slidePageCount: 12,
  }
  const layoutEvents = [
    makeEvent(1, 'run.started', { runId: layoutRun.runId }, '2026-10-26T09:00:00.000Z'),
    makeEvent(2, 'reasoning.delta', { delta: '正在布局第 3 页' }, '2026-10-26T09:00:10.000Z'),
    makeEvent(3, 'run.failed', { message: '503: AI relay session is not active' }, '2026-10-26T09:00:30.000Z'),
  ]

  const entries = []
  for (const [run, events] of [[mainRun, mainEvents], [layoutRun, layoutEvents]]) {
    const file = `runs/20261026/${run.runId}.ndjson`
    const bytes = writeNdjson(join(archiveDir, file), run, events)
    entries.push({ run, file, bytes })
  }
  writeFileSync(
    join(archiveDir, 'index.json'),
    `${JSON.stringify({ version: 1, runs: entries })}\n`,
    'utf8',
  )
  return [mainRun, layoutRun]
}

/** 读取任意（真实或合成）归档目录的 index，返回 index 里的 run 列表。 */
function readArchiveRuns(archiveDir) {
  const indexPath = join(archiveDir, 'index.json')
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
  assert.equal(parsed.version, 1, 'index.json version 必须为 1')
  assert.ok(Array.isArray(parsed.runs), 'index.json runs 必须是数组')
  return parsed.runs.map((entry) => entry.run)
}

function staleProcessPid() {
  // 起一个立刻退出的子进程，拿它已经终止的 pid，作为 stale manifest 的 pid。
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (!result.pid) throw new Error('无法获取已退出进程的 pid')
  return result.pid
}

function writeStaleManifest(dataDir) {
  const runtimeDir = join(dataDir, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(
    join(runtimeDir, 'gateway.json'),
    `${JSON.stringify({
      pid: staleProcessPid(),
      baseUrl: STALE_BASE_URL,
      token: STALE_TOKEN,
      startedAt: '2026-10-26T08:00:00.000Z',
      version: '0.0.0-offline-smoke',
    }, null, 2)}\n`,
    'utf8',
  )
}

async function findFreePort() {
  if (REQUESTED_PORT > 0) return REQUESTED_PORT
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error('未拿到空闲端口'))))
    })
  })
}

async function waitForServer(baseUrl, child, logTail, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite 提前退出（code=${child.exitCode}）：\n${logTail()}`)
    try {
      const response = await fetch(`${baseUrl}/debug/agent-debug.html`, { cache: 'no-store' })
      if (response.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待 Vite dev server 超时：\n${logTail()}`)
}

async function getJson(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-debug-offline-'))
  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`

  let expectedRuns
  if (ARCHIVE_ARG) {
    const sourceArchive = resolve(ARCHIVE_ARG)
    expectedRuns = readArchiveRuns(sourceArchive)
    cpSync(sourceArchive, join(dataDir, 'agent-debug', 'main'), { recursive: true })
  } else {
    expectedRuns = buildSyntheticArchive(dataDir)
  }
  writeStaleManifest(dataDir)

  const sortedExpected = [...expectedRuns].sort(
    (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
  )
  const toolRun = expectedRuns.find((run) => run.toolCallCount > 0) ?? null

  const logs = []
  const child = spawn(process.execPath, [VITE_BIN, '--config', VITE_CONFIG], {
    cwd: join(REPO_ROOT, 'apps/desktop'),
    env: {
      ...process.env,
      NXCORE_DATA_DIR: dataDir,
      AGENT_DEBUG_PORT: String(port),
      EVERROOM_AGENT_DEBUG_MANIFEST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (chunk) => {
    logs.push(String(chunk))
    if (logs.length > 200) logs.splice(0, logs.length - 200)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const logTail = () => logs.join('').slice(-4000)

  try {
    await waitForServer(baseUrl, child, logTail)
    console.log(`\n离线归档冒烟：dataDir=${dataDir} port=${port} mode=${ARCHIVE_ARG ? 'real-archive' : 'synthetic'}\n`)

    const sources = await getJson(`${baseUrl}/@agent-debug/sources`)
    let archiveSource = null
    let staleLiveSource = null

    await checkAsync('sources 返回 200 且包含 archive 来源', () => {
      assert.equal(sources.status, 200)
      assert.ok(Array.isArray(sources.body), 'sources 必须是数组')
      const archives = sources.body.filter((source) => source.backend === 'archive')
      assert.ok(archives.length >= 1, '至少要有 1 个 archive 来源')
      archiveSource = archives.find((source) => String(source.archiveDir ?? '').includes('agent-debug')) ?? archives[0]
      assert.equal(archiveSource.available, true, 'archive 来源必须 available')
      assert.equal(archiveSource.runCount, expectedRuns.length, 'archive 来源 runCount 应与 index 一致')
      assert.ok(String(archiveSource.label).includes('历史归档'), `archive 标签应包含「历史归档」：${archiveSource.label}`)
      assert.equal(archiveSource.baseUrl, '', 'archive 来源 baseUrl 应为空')
    })

    await checkAsync('stale live 来源标记 available=false', () => {
      const lives = sources.body.filter((source) => source.backend === 'live')
      staleLiveSource = lives.find((source) => String(source.label).includes('主网关')) ?? lives[0] ?? null
      assert.ok(staleLiveSource, '应发现 stale manifest 对应的 live 来源')
      assert.equal(staleLiveSource.available, false, 'stale manifest 的 pid 已退出，live 来源应不可用')
    })

    await checkAsync('sources 不泄漏 manifest token', () => {
      assert.ok(!JSON.stringify(sources.body).includes(STALE_TOKEN), 'sources 响应不应包含 token')
    })

    await checkAsync('stale live 来源代理返回 502（离线原因）', async () => {
      const result = await getJson(
        `${baseUrl}/@agent-debug/gateway/${encodeURIComponent(staleLiveSource.id)}/v1/agent-debug/snapshot`,
      )
      assert.equal(result.status, 502)
      assert.equal(result.body?.error, 'gateway_unreachable')
    })

    const archiveBase = `${baseUrl}/@agent-debug/gateway/${encodeURIComponent(archiveSource.id)}`

    await checkAsync('archive snapshot：run 列表/排序/origin/sessionTitle', async () => {
      const result = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=150&archived=include`)
      assert.equal(result.status, 200)
      const body = result.body
      assert.equal(body.runs.length, Math.min(150, expectedRuns.length))
      assert.equal(body.runs[0].runId, sortedExpected[0].runId, '最新 run 应排在最前')
      for (const run of body.runs) {
        assert.equal(run.origin, 'archive')
        assert.equal(run.sessionTitle, null)
      }
      assert.equal(body.droppedRuns, 0)
      assert.equal(body.archive.enabled, true)
      assert.equal(body.archive.retentionDays, 0, '离线读取时 retentionDays 应为未知（0）')
      assert.equal(body.archive.runCount, expectedRuns.length)
      assert.ok(body.archive.bytes > 0, 'archive.bytes 应大于 0')
      assert.ok(body.archive.oldestStartedAt, 'archive.oldestStartedAt 应有值')
    })

    await checkAsync('archive snapshot：agents 由归档 run 推导', async () => {
      const result = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=150`)
      const agents = result.body.agents
      assert.ok(agents.length >= 1, 'agents 不应为空')
      const ids = agents.map((agent) => agent.id)
      for (const run of expectedRuns) assert.ok(ids.includes(run.agentId), `agents 应包含 ${run.agentId}`)
      for (const agent of agents) assert.equal(agent.activeRunCount, 0, '归档 Agent 不应有运行中 run')
    })

    await checkAsync('archive snapshot：archived=only 与 include 一致，exclude 无 run', async () => {
      const only = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=150&archived=only`)
      assert.equal(only.status, 200)
      assert.equal(only.body.runs.length, Math.min(150, expectedRuns.length))
      const exclude = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=150&archived=exclude`)
      assert.equal(exclude.status, 200)
      assert.equal(exclude.body.runs.length, 0, '归档来源没有「本次」run')
      assert.equal(exclude.body.archive.runCount, expectedRuns.length)
    })

    await checkAsync('archive snapshot：runs 参数边界', async () => {
      const limited = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=1`)
      assert.equal(limited.status, 200)
      assert.equal(limited.body.runs.length, 1)
      const invalid = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=301`)
      assert.equal(invalid.status, 400)
      const invalidArchived = await getJson(`${archiveBase}/v1/agent-debug/snapshot?archived=bogus`)
      assert.equal(invalidArchived.status, 400)
    })

    const eventsRun = toolRun ?? sortedExpected[0]
    await checkAsync('archive events：按 seq 升序回放 + latestSeq', async () => {
      const result = await getJson(
        `${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?afterSeq=0&limit=1000`,
      )
      assert.equal(result.status, 200)
      assert.equal(result.body.run.runId, eventsRun.runId)
      assert.equal(result.body.run.origin, 'archive')
      assert.equal(result.body.run.sessionTitle, null)
      assert.ok(result.body.events.length > 0, 'events 不应为空')
      const seqs = result.body.events.map((event) => event.seq)
      for (let index = 1; index < seqs.length; index += 1) assert.ok(seqs[index] > seqs[index - 1], 'seq 必须严格递增')
      assert.equal(result.body.latestSeq, seqs[seqs.length - 1])
      if (eventsRun.toolCallCount > 0) {
        assert.ok(
          result.body.events.some((event) => String(event.type).startsWith('tool.')),
          '带工具调用的 run 应有 tool.* 事件',
        )
      }
    })

    await checkAsync('archive events：afterSeq/limit 增量语义', async () => {
      const first = await getJson(`${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?afterSeq=0&limit=3`)
      assert.equal(first.status, 200)
      assert.equal(first.body.events.length, 3)
      const firstPageLast = first.body.events[first.body.events.length - 1].seq
      const next = await getJson(
        `${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?afterSeq=${firstPageLast}&limit=1000`,
      )
      assert.ok(next.body.events.every((event) => event.seq > firstPageLast), 'afterSeq 之后不应重复返回旧事件')
      const tail = await getJson(
        `${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?afterSeq=${first.body.latestSeq}`,
      )
      assert.equal(tail.body.events.length, 0, 'afterSeq=latestSeq 时终态历史 run 应无事件')
      assert.equal(tail.body.latestSeq, first.body.latestSeq)
    })

    await checkAsync('archive events：边界（400/404/405）', async () => {
      const badLimit = await getJson(`${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?limit=5001`)
      assert.equal(badLimit.status, 400)
      const badAfter = await getJson(`${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?afterSeq=-1`)
      assert.equal(badAfter.status, 400)
      const missing = await getJson(`${archiveBase}/v1/agent-debug/runs/does-not-exist/events`)
      assert.equal(missing.status, 404)
      const unknownPath = await getJson(`${archiveBase}/v1/agent-debug/unknown`)
      assert.equal(unknownPath.status, 404)
      const post = await getJson(`${archiveBase}/v1/agent-debug/snapshot`, { method: 'POST' })
      assert.equal(post.status, 405)
    })

    await checkAsync('archive snapshot/events 不泄漏 token', async () => {
      const snapshot = await getJson(`${archiveBase}/v1/agent-debug/snapshot?runs=50`)
      const events = await getJson(
        `${archiveBase}/v1/agent-debug/runs/${encodeURIComponent(eventsRun.runId)}/events?limit=1000`,
      )
      assert.ok(!JSON.stringify(snapshot.body).includes(STALE_TOKEN))
      assert.ok(!JSON.stringify(events.body).includes(STALE_TOKEN))
    })

    await checkAsync('调试页 HTML 可访问', async () => {
      const response = await fetch(`${baseUrl}/debug/agent-debug.html`, { cache: 'no-store' })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /agent-debug-root/)
    })
  } finally {
    if (!KEEP) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
      ]).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      })
      rmSync(dataDir, { recursive: true, force: true })
    } else {
      child.kill('SIGTERM')
      console.log(`\n保留临时 dataDir：${dataDir}`)
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}（${expectedRuns.length} runs）`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\n离线归档冒烟脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
}
