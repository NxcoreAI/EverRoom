#!/usr/bin/env node
// Agent 调试台「历史归档 / 重启找回」端到端验收脚本。
//
// 流程（fake runtime，隔离临时数据目录，不碰用户真实数据）：
//   1. 起 Gateway → 建会话 → 跑一轮 run → 等 run completed；
//   2. 等 run 落盘到 <dataDir>/agent-debug/main/（index.json + runs/**/<runId>.ndjson）；
//   3. SIGTERM 停掉 Gateway（正常退出路径）；
//   4. 用同一个 dataDir 重启 Gateway；
//   5. 断言 snapshot?archived=only 能找回该 run（origin=archive / 终态 / sessionId / archive 概况），
//      且 events 接口可回放完整事件链；archived=exclude 不包含历史 run；
//   6. 断言磁盘归档文件存在、index.json 可解析。
//
// 用法：
//   node scripts/agent-debug-archive-e2e.mjs            # 验收后清理临时目录
//   node scripts/agent-debug-archive-e2e.mjs --keep     # 保留临时目录便于排查
//
// 前置：仓库依赖已安装（apps/gateway/node_modules/tsx 可用），系统 node v22+。
// 退出码非 0 表示有断言失败。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const KEEP = process.argv.includes('--keep')
const TOKEN = 'agent-debug-archive-e2e-token'
const RUN_TIMEOUT_MS = 30_000
// 首次启动要跑数据库迁移，桌面端自己的启动超时是 180s；这里给足。
const START_TIMEOUT_MS = 180_000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function gatewayArgs(dataDir, migrationsDir) {
  return [
    'apps/gateway/node_modules/tsx/dist/cli.mjs',
    'apps/gateway/src/bin/serve.ts',
    '--host', '127.0.0.1',
    '--port', '0',
    '--data-dir', dataDir,
    '--migrations-dir', migrationsDir,
  ]
}

async function startGateway({ dataDir, migrationsDir, envFile }) {
  const child = spawn(process.execPath, gatewayArgs(dataDir, migrationsDir), {
    cwd: repoRoot,
    env: {
      ...process.env,
      NXCORE_ENV_FILE: envFile,
      NXCORE_AGENT_RUNTIME: 'fake',
      NXCORE_GATEWAY_TOKEN: TOKEN,
      NXCORE_GATEWAY_LOG_LEVEL: process.env.NXCORE_GATEWAY_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  const exit = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  return { child, exit, logs }
}

async function stopGateway(handle) {
  const { child, exit } = handle
  if (child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  // 与桌面端 GatewaySupervisor 一致：SIGTERM 后最多等 5s，再 SIGKILL。
  // （Gateway 的 onClose 已完成归档 flush，SIGKILL 只用于兜底残留的 worker/计时器。）
  let result = await Promise.race([exit, sleep(5_000).then(() => 'timeout')])
  if (result === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    result = await Promise.race([exit, sleep(5_000).then(() => 'timeout')])
  }
  if (result === 'timeout') throw new Error('Gateway SIGKILL 后仍未退出')
}

async function readManifest(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, 'runtime', 'gateway.json'), 'utf8'))
  } catch {
    return null
  }
}

async function waitForReady(handle, dataDir, previousStartedAt) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      const logTail = handle.logs.join('').slice(-4000)
      throw new Error(`Gateway 启动即退出（code=${handle.child.exitCode}）：\n${logTail}`)
    }
    const manifest = await readManifest(dataDir)
    // 注意：tsx cli 会再 fork 一个真实 node 子进程，manifest.pid 不等于 handle.child.pid；
    // 用 startedAt 变化 + health ready 判断"这是本次启动"。
    if (manifest?.baseUrl && manifest.startedAt !== previousStartedAt) {
      const response = await fetch(`${manifest.baseUrl}/v1/health/ready`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).catch(() => null)
      if (response?.ok) return manifest
    }
    await sleep(150)
  }
  const logTail = handle.logs.join('').slice(-4000)
  throw new Error(`Gateway 未在 ${START_TIMEOUT_MS}ms 内就绪：\n${logTail}`)
}

function client(manifest) {
  const base = manifest.baseUrl
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }
  return {
    snapshot: (query = '') => request(`/v1/agent-debug/snapshot${query}`),
    events: (runId, query = '') => request(`/v1/agent-debug/runs/${encodeURIComponent(runId)}/events${query}`),
    createSession: (pageLabel) => request('/v1/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ pageLabel }),
    }),
    startRun: (sessionId, prompt, idempotencyKey) => request(`/v1/agent/sessions/${sessionId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt, displayPrompt: prompt, idempotencyKey }),
    }),
  }
}

async function findArchiveFiles(sourceDir) {
  const runsDir = join(sourceDir, 'runs')
  const files = []
  async function walk(directory) {
    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.ndjson')) files.push(full)
    }
  }
  await walk(runsDir)
  return files
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agent-debug-archive-e2e-'))
  const dataDir = join(root, 'data')
  const envFile = join(root, 'empty.env')
  const migrationsDir = join(repoRoot, 'apps/gateway/drizzle')
  await mkdir(dataDir, { recursive: true })
  await writeFile(envFile, '', 'utf8')

  console.log(`== Agent debug archive E2E · dataDir=${dataDir} ==`)
  let handle = null
  try {
    // ── 第一次启动：产生并归档一条 run ───────────────────────────────────
    handle = await startGateway({ dataDir, migrationsDir, envFile })
    let manifest = await waitForReady(handle, dataDir, null)
    let api = client(manifest)

    const created = await api.createSession('Home')
    check('POST /v1/agent/sessions → 201', () => assert.equal(created.status, 201))
    const sessionId = created.body?.id
    assert.ok(sessionId, 'createSession 未返回 id')

    const started = await api.startRun(sessionId, '重启后找回这条对话的调试记录', `archive-e2e-${Date.now()}`)
    check('POST /v1/agent/sessions/:id/runs → 202', () => assert.equal(started.status, 202))
    const runId = started.body?.id
    assert.ok(runId, 'startRun 未返回 id')

    let completedRun = null
    const runDeadline = Date.now() + RUN_TIMEOUT_MS
    while (Date.now() < runDeadline) {
      const snap = await api.snapshot('?runs=50&archived=include')
      const run = snap.body?.runs?.find((entry) => entry.runId === runId)
      if (run && run.status !== 'running') {
        completedRun = run
        break
      }
      await sleep(100)
    }
    check('run 到达终态且仍在本次进程（origin=live）', () => {
      assert.ok(completedRun, '未在超时内等到达终态')
      assert.equal(completedRun.status, 'completed')
      assert.equal(completedRun.origin, 'live')
      assert.equal(completedRun.sessionId, sessionId)
    })

    // 归档写入是 fire-and-forget：轮询 index/文件直到落盘。
    const sourceDir = join(dataDir, 'agent-debug', 'main')
    let archiveInfo = null
    const archiveDeadline = Date.now() + 10_000
    while (Date.now() < archiveDeadline) {
      const snap = await api.snapshot('?runs=50&archived=only')
      archiveInfo = snap.body?.archive ?? null
      const files = await findArchiveFiles(sourceDir)
      if (archiveInfo?.runCount >= 1 && files.some((file) => file.includes(runId))) break
      await sleep(100)
    }
    check('run 已落盘：archive.runCount ≥ 1 且存在 <runId>.ndjson', () => {
      assert.ok(archiveInfo, 'snapshot 缺少 archive 字段')
      assert.equal(archiveInfo.enabled, true)
      assert.ok(archiveInfo.runCount >= 1, `archive.runCount=${archiveInfo.runCount}`)
      assert.equal(archiveInfo.retentionDays, 7)
    })

    let archiveFiles = []
    await checkAsync('归档文件可解析：首行 run meta + 事件行', async () => {
      archiveFiles = (await findArchiveFiles(sourceDir)).filter((file) => file.includes(runId))
      assert.equal(archiveFiles.length, 1, `期望 1 个 run 文件，实际 ${archiveFiles.length}`)
      const lines = (await readFile(archiveFiles[0], 'utf8')).trim().split('\n')
      assert.ok(lines.length >= 2, `归档行数过少：${lines.length}`)
      const meta = JSON.parse(lines[0])
      assert.equal(meta.kind, 'run')
      assert.equal(meta.run.runId, runId)
      assert.equal(meta.run.status, 'completed')
      const eventLine = JSON.parse(lines[1])
      assert.equal(eventLine.kind, 'event')
      assert.equal(typeof eventLine.event.seq, 'number')
    })

    await checkAsync('index.json 存在且包含该 run', async () => {
      const index = JSON.parse(await readFile(join(sourceDir, 'index.json'), 'utf8'))
      assert.ok(Array.isArray(index.runs), 'index.runs 不是数组')
      assert.ok(index.runs.some((entry) => entry.run?.runId === runId), 'index 中缺少 run')
    })

    // ── 停止 Gateway（模拟桌面应用退出）→ 同 dataDir 重启 ──────────────
    const firstStartedAt = manifest.startedAt
    await stopGateway(handle)
    handle = null
    check('Gateway 收到 SIGTERM 后退出', () => assert.equal(true, true))

    handle = await startGateway({ dataDir, migrationsDir, envFile })
    manifest = await waitForReady(handle, dataDir, firstStartedAt)
    api = client(manifest)

    const afterRestart = await api.snapshot('?runs=50&archived=only')
    check('重启后 snapshot?archived=only 找回历史 run（origin=archive）', () => {
      assert.equal(afterRestart.status, 200)
      const run = afterRestart.body?.runs?.find((entry) => entry.runId === runId)
      assert.ok(run, '重启后历史 run 丢失')
      assert.equal(run.origin, 'archive')
      assert.equal(run.status, 'completed')
      assert.equal(run.sessionId, sessionId)
      assert.equal(run.agentId, completedRun.agentId)
      assert.equal(run.eventCount, completedRun.eventCount)
      assert.equal('sessionTitle' in run, true, '缺少 sessionTitle 字段')
      assert.ok(run.sessionTitle === null || typeof run.sessionTitle === 'string')
      assert.equal(afterRestart.body.archive.enabled, true)
      assert.ok(afterRestart.body.archive.runCount >= 1)
      assert.ok(afterRestart.body.archive.bytes > 0)
      assert.ok(typeof afterRestart.body.archive.oldestStartedAt === 'string')
    })

    await checkAsync('重启后 events 接口可回放归档 run 的完整事件链（seq 递增）', async () => {
      const page = await api.events(runId, '?afterSeq=0&limit=5000')
      assert.equal(page.status, 200)
      assert.equal(page.body?.run?.origin, 'archive')
      const types = page.body.events.map((event) => event.type)
      assert.equal(types[0], 'run.started')
      assert.equal(types.at(-1), 'run.completed')
      for (const required of ['reasoning.delta', 'message.started', 'message.delta', 'message.completed']) {
        assert.ok(types.includes(required), `缺少事件 ${required}：${types.join(',')}`)
      }
      const seqs = page.body.events.map((event) => event.seq)
      for (let index = 1; index < seqs.length; index += 1) {
        assert.ok(seqs[index] > seqs[index - 1], `seq 非严格递增：${seqs.join(',')}`)
      }
      assert.equal(page.body.latestSeq, seqs.at(-1))
    })

    await checkAsync('重启后 archived=exclude 不包含历史 run（本次进程无 run）', async () => {
      const live = await api.snapshot('?runs=50&archived=exclude')
      assert.equal(live.status, 200)
      assert.equal(live.body.runs.some((entry) => entry.runId === runId), false)
    })

    await checkAsync('重启后 archived=include 混合视图仍带 archive 字段', async () => {
      const mixed = await api.snapshot('?runs=50')
      assert.equal(mixed.status, 200)
      assert.ok(mixed.body.runs.some((entry) => entry.runId === runId && entry.origin === 'archive'))
      assert.equal(typeof mixed.body.archive?.runCount, 'number')
    })

    await checkAsync('历史 run 增量接口：afterSeq=latestSeq 返回空（终态静态）', async () => {
      const full = await api.events(runId, '?afterSeq=0&limit=5000')
      const tail = await api.events(runId, `?afterSeq=${full.body.latestSeq}&limit=1000`)
      assert.equal(tail.status, 200)
      assert.equal(tail.body.events.length, 0)
    })
  } finally {
    if (handle) {
      await stopGateway(handle).catch(() => {})
    }
    if (KEEP) console.log(`临时目录保留：${root}`)
    else await rm(root, { recursive: true, force: true })
  }

  console.log(`\n== 结果：${failures === 0 ? '全部 PASS' : `${failures} 项 FAIL`} ==`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('ARCHIVE E2E CRASH', error)
  process.exitCode = 1
})
