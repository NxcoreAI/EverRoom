#!/usr/bin/env node
// Agent 调试页端到端冒烟脚本（真实 fake-runtime 网关）。
//
// 前置：用隔离数据目录起一个 fake runtime 网关，例如
//   NXCORE_AGENT_RUNTIME=fake NXCORE_GATEWAY_TOKEN=agent-debug-e2e-token \
//   NXCORE_ENV_FILE=$PWD/.tmp-pnpm/e2e-empty.env \
//   node apps/gateway/node_modules/tsx/dist/cli.mjs apps/gateway/src/bin/serve.ts \
//     --host 127.0.0.1 --port 3411 --data-dir $PWD/.tmp-pnpm/e2e-data \
//     --migrations-dir $PWD/apps/gateway/drizzle
//
// 用法：
//   node scripts/agent-debug-smoke.mjs --base http://127.0.0.1:3411 --token agent-debug-e2e-token
//
// 覆盖：鉴权/参数边界、并发多 run、snapshot 增长与终态、events 事件类型与 seq 递增、
// delta 合并语义、afterSeq 增量与尾部重放（upsert 前提）。退出码非 0 表示有断言失败。

import assert from 'node:assert/strict'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const BASE = (argValue('base', process.env.AGENT_DEBUG_BASE ?? 'http://127.0.0.1:3411')).replace(/\/+$/, '')
const TOKEN = argValue('token', process.env.AGENT_DEBUG_TOKEN ?? 'agent-debug-e2e-token')

let failures = 0
function check(label, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) throw new Error('check 不支持异步断言，请用 checkAsync')
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

async function request(path, { token = TOKEN, headers = {}, raw = false } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  })
  let body = null
  if (!raw) {
    try {
      body = await response.json()
    } catch {
      body = null
    }
  }
  return { status: response.status, body, response }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function createSession(pageLabel) {
  const response = await fetch(`${BASE}/v1/agent/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pageLabel }),
  })
  const body = await response.json()
  assert.equal(response.status, 201, `createSession(${pageLabel}) 期望 201，实际 ${response.status}`)
  return body.id
}

async function startRun(sessionId, prompt, idempotencyKey) {
  const response = await fetch(`${BASE}/v1/agent/sessions/${sessionId}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, displayPrompt: prompt, idempotencyKey }),
  })
  const body = await response.json()
  assert.equal(response.status, 202, `startRun 期望 202，实际 ${response.status}: ${JSON.stringify(body)}`)
  return body.id
}

async function snapshot(runs = 150) {
  const { status, body } = await request(`/v1/agent-debug/snapshot?runs=${runs}`)
  assert.equal(status, 200, `snapshot 期望 200，实际 ${status}`)
  return body
}

async function events(runId, afterSeq, limit = 1000) {
  const { status, body } = await request(
    `/v1/agent-debug/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
  )
  return { status, body }
}

function eventTypes(page) {
  return page.events.map((event) => event.type)
}

function deltaOf(page, type) {
  const event = page.events.find((entry) => entry.type === type)
  return event && event.payload && typeof event.payload.delta === 'string' ? event.payload.delta : null
}

async function main() {
  console.log(`== Agent debug E2E smoke · ${BASE} ==`)

  // ── A3 边界：鉴权 / 未知 run / 参数上限 ──────────────────────────────────
  const health = await request('/v1/health/ready')
  check('GET /v1/health/ready → 200', () => assert.equal(health.status, 200))

  const noTokenSnapshot = await request('/v1/agent-debug/snapshot', { token: null })
  check('GET /v1/agent-debug/snapshot 无 token → 401', () => {
    assert.equal(noTokenSnapshot.status, 401)
  })
  const noTokenEvents = await request('/v1/agent-debug/runs/whatever/events', { token: null })
  check('GET /v1/agent-debug/runs/:id/events 无 token → 401', () => {
    assert.equal(noTokenEvents.status, 401)
  })
  const unknownRun = await events('run-does-not-exist-' + Date.now(), 0)
  check('未知 run → 404', () => assert.equal(unknownRun.status, 404))
  const badRuns = await request('/v1/agent-debug/snapshot?runs=1000')
  check('snapshot runs=1000 → 400（上限 300）', () => assert.equal(badRuns.status, 400))
  const badLimitRun = await events('x', 0, 5001)
  check('events limit=5001 → 400（上限 5000）', () => assert.equal(badLimitRun.status, 400))

  // ── A2 并发两个会话各起一轮 run ────────────────────────────────────────
  const sessionA = await createSession('Home')
  const sessionB = await createSession('Room')
  check('POST /v1/agent/sessions ×2 → 201 且 id 不同', () => assert.notEqual(sessionA, sessionB))

  const runA = await startRun(sessionA, '帮我看看今天的安排', `e2e-smoke-a-${Date.now()}`)
  const runB = await startRun(sessionB, '总结这个房间的重点', `e2e-smoke-b-${Date.now()}`)
  check('POST /v1/agent/sessions/:id/runs ×2 → 202（并发 run）', () => assert.notEqual(runA, runB))

  // running 状态与计数增长：100ms 一轮采样，抓运行中的快照。
  const runningSamples = []
  let sawBothRunning = false
  let midRunPageA = null
  let mainAgentSample = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const snap = await snapshot(50)
    const runARecord = snap.runs.find((run) => run.runId === runA)
    const runBRecord = snap.runs.find((run) => run.runId === runB)
    if (runARecord && runBRecord) {
      const mainAgent = snap.agents.find((agent) => agent.id === 'main')
      if (mainAgent && runARecord.agentId === 'main' && runARecord.agentKind === 'builtin') {
        mainAgentSample = mainAgent
      }
      runningSamples.push({
        at: snap.generatedAt,
        a: { status: runARecord.status, eventCount: runARecord.eventCount, reasoningChars: runARecord.reasoningChars },
        b: { status: runBRecord.status, eventCount: runBRecord.eventCount, reasoningChars: runBRecord.reasoningChars },
      })
      if (runARecord.status === 'running' && runBRecord.status === 'running') {
        sawBothRunning = true
        if (!midRunPageA && runARecord.eventCount >= 3) {
          const first = await events(runA, 0)
          if (first.status === 200) {
            midRunPageA = { page: first.body, firstLatestSeq: first.body.latestSeq }
            const replay = await events(runA, first.body.latestSeq)
            midRunPageA.replay = replay.body
            midRunPageA.replayStatus = replay.status
          }
        }
      }
    }
    if (runARecord?.status !== 'running' && runBRecord?.status !== 'running') break
    await sleep(100)
  }
  check('snapshot 同时出现两个 run，agentId=main、agentKind=builtin', () => {
    assert.ok(runningSamples.length > 0, '没有采到含 run 的快照')
    assert.ok(mainAgentSample, 'agents 中没有 main（builtin）')
    assert.equal(mainAgentSample.kind, 'builtin')
  })
  check('两个 run 曾同时处于 running（并发）', () => assert.equal(sawBothRunning, true))
  check('running 期间 eventCount / reasoningChars 增长', () => {
    const values = runningSamples.map((sample) => sample.a.eventCount)
    assert.ok(values.length >= 2, `采样次数不足：${values.length}`)
    assert.ok(Math.max(...values) > Math.min(...values), `eventCount 未增长：${JSON.stringify(values)}`)
    assert.ok(runningSamples.some((sample) => sample.a.reasoningChars > 0), 'reasoningChars 未增长')
  })

  // 抓运行中状态做 afterSeq 重放断言（若 run 太短没抓到，退而用新 run 验证）。
  if (!midRunPageA || midRunPageA.replay === undefined) {
    const sessionC = await createSession('Home')
    const runC = await startRun(sessionC, '短 run 增量重放', `e2e-smoke-c-${Date.now()}`)
    const cDeadline = Date.now() + 10_000
    while (Date.now() < cDeadline) {
      const first = await events(runC, 0)
      if (first.status === 200 && first.body.events.length >= 3) {
        midRunPageA = { page: first.body, firstLatestSeq: first.body.latestSeq }
        const replay = await events(runC, first.body.latestSeq)
        midRunPageA.replay = replay.body
        midRunPageA.replayStatus = replay.status
        break
      }
      await sleep(50)
    }
  }

  check('运行中 events 尾部重放：afterSeq=latestSeq 最多回一条 seq<=latestSeq 的尾部 delta', () => {
    assert.ok(midRunPageA?.replay, '没有拿到运行中重放样本')
    assert.equal(midRunPageA.replayStatus, 200)
    const replayEvents = midRunPageA.replay.events
    assert.ok(replayEvents.length <= 1, `尾部重放应最多 1 条，实际 ${replayEvents.length}`)
    if (replayEvents.length === 1) {
      assert.ok(replayEvents[0].seq <= midRunPageA.firstLatestSeq, '尾部重放事件的 seq 应 <= latestSeq')
      assert.ok(['reasoning.delta', 'message.delta'].includes(replayEvents[0].type), '尾部重放应是可合并 delta')
      const sameSeqInFirstPage = midRunPageA.page.events.some(
        (event) => event.seq === replayEvents[0].seq && event.type === replayEvents[0].type,
      )
      assert.equal(sameSeqInFirstPage, true, '尾部重放事件应已在首拉事件页里（同 seq，按 seq upsert）')
    }
    assert.ok(midRunPageA.replay.latestSeq >= midRunPageA.firstLatestSeq)
  })

  // 等两个 run 终态。
  let finalSnapshot = null
  const finishDeadline = Date.now() + 20_000
  while (Date.now() < finishDeadline) {
    finalSnapshot = await snapshot(50)
    const a = finalSnapshot.runs.find((run) => run.runId === runA)
    const b = finalSnapshot.runs.find((run) => run.runId === runB)
    if (a?.status === 'completed' && b?.status === 'completed') break
    await sleep(150)
  }
  const finalA = finalSnapshot.runs.find((run) => run.runId === runA)
  const finalB = finalSnapshot.runs.find((run) => run.runId === runB)
  check('两个 run 均到达 completed（含 completedAt）', () => {
    assert.equal(finalA.status, 'completed')
    assert.equal(finalB.status, 'completed')
    assert.ok(finalA.completedAt && finalB.completedAt, 'completedAt 缺失')
    assert.equal(finalA.agentId, 'main')
    assert.equal(finalA.agentKind, 'builtin')
    assert.equal(finalA.sessionId, sessionA)
    assert.equal(finalB.sessionId, sessionB)
    assert.ok(finalA.eventCount > 0 && finalA.reasoningChars > 0)
  })

  // ── 事件内容 / seq 递增 / 合并语义 ─────────────────────────────────────
  const full = await events(runA, 0, 5000)
  check('events?afterSeq=0 返回 run.started → message → run.completed 全链路', () => {
    assert.equal(full.status, 200)
    const types = eventTypes(full.body)
    assert.equal(types[0], 'run.started', `首个事件应为 run.started，实际 ${types[0]}`)
    assert.equal(types.at(-1), 'run.completed', `末个事件应为 run.completed，实际 ${types.at(-1)}`)
    for (const required of ['reasoning.delta', 'message.started', 'message.delta', 'message.completed']) {
      assert.ok(types.includes(required), `缺少事件 ${required}：${types.join(',')}`)
    }
  })
  check('seq 严格递增且 latestSeq = 最后一条事件 seq', () => {
    const seqs = full.body.events.map((event) => event.seq)
    assert.ok(seqs.length > 0)
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index] > seqs[index - 1], `seq 非严格递增：${seqs.join(',')}`)
    }
    assert.equal(full.body.latestSeq, seqs.at(-1))
    assert.equal(full.body.run.runId, runA)
  })
  check('reasoning.delta 合并为整段（非逐 token）', () => {
    const delta = deltaOf(full.body, 'reasoning.delta')
    assert.equal(delta, '正在整理当前页面上下文。')
    const reasoningEvents = full.body.events.filter((event) => event.type === 'reasoning.delta')
    assert.equal(reasoningEvents.length, 1, `reasoning.delta 应合并为 1 条，实际 ${reasoningEvents.length}`)
  })
  check('message.delta 合并为整段且等于 message.completed.content', () => {
    const delta = deltaOf(full.body, 'message.delta')
    const completed = full.body.events.find((event) => event.type === 'message.completed')
    assert.ok(delta && completed, '缺少 message.delta / message.completed')
    assert.equal(delta, completed.payload.content)
    assert.equal(full.body.run.reasoningChars, '正在整理当前页面上下文。'.length)
  })
  await checkAsync('终态后 afterSeq=latestSeq 增量拉取为空', async () => {
    const tail = await events(runA, full.body.latestSeq, 1000)
    assert.equal(tail.status, 200)
    assert.equal(tail.body.events.length, 0, `应为空，实际 ${tail.body.events.length} 条`)
    assert.equal(tail.body.latestSeq, full.body.latestSeq)
  })
  await checkAsync('afterSeq 严格增量：返回事件 seq 全部 > afterSeq', async () => {
    const middle = full.body.events[Math.floor(full.body.events.length / 2)].seq
    const page = await events(runA, middle, 1000)
    assert.equal(page.status, 200)
    assert.ok(page.body.events.length > 0)
    assert.ok(page.body.events.every((event) => event.seq > middle))
  })
  await checkAsync('limit 截断不影响 latestSeq（客户端按页尾 seq 推进游标）', async () => {
    const page = await events(runA, 0, 1)
    assert.equal(page.status, 200)
    assert.equal(page.body.events.length, 1)
    assert.equal(page.body.latestSeq, full.body.latestSeq)
  })
  check('快照 agents 含 main（builtin）且终态后 activeRunCount=0', () => {
    const main = finalSnapshot.agents.find((agent) => agent.id === 'main')
    assert.ok(main, 'agents 中没有 main')
    assert.equal(main.kind, 'builtin')
    assert.equal(main.activeRunCount, 0)
    assert.equal(main.state, 'idle')
  })
  check('snapshot runs 数与终态一致（droppedRuns=0）', () => {
    assert.equal(finalSnapshot.droppedRuns, 0)
    assert.ok(finalSnapshot.runs.length >= 2)
    assert.ok(finalSnapshot.runs.every((run) => typeof run.eventCount === 'number'))
  })

  // ── 历史归档：概况 / origin / archived 三态 / sessionTitle 补全 ───────────
  check('snapshot 带 archive 概况且本次进程 run 标 origin=live', () => {
    assert.ok(finalSnapshot.archive && typeof finalSnapshot.archive === 'object', '缺少 archive 字段')
    assert.equal(typeof finalSnapshot.archive.enabled, 'boolean')
    assert.ok(finalSnapshot.archive.retentionDays >= 0)
    assert.ok(finalSnapshot.archive.runCount >= 0)
    assert.ok(finalSnapshot.archive.bytes >= 0)
    if (finalSnapshot.archive.enabled) {
      assert.ok(finalSnapshot.archive.retentionDays >= 1)
    }
    assert.equal(finalA.origin, 'live')
    assert.equal(finalB.origin, 'live')
    assert.ok('sessionTitle' in finalA, 'run 缺少 sessionTitle 字段')
    assert.ok(finalA.sessionTitle === null || typeof finalA.sessionTitle === 'string')
  })
  if (finalSnapshot.archive?.enabled) {
    await checkAsync('snapshot?archived=exclude 只返回本次进程 run（origin=live）', async () => {
      const exclude = await request('/v1/agent-debug/snapshot?runs=50&archived=exclude')
      assert.equal(exclude.status, 200)
      assert.ok(exclude.body.runs.every((run) => run.origin === 'live'))
      assert.ok(exclude.body.runs.some((run) => run.runId === runA))
    })
    await checkAsync('snapshot?archived=only 只返回归档历史 run（origin=archive）', async () => {
      const only = await request('/v1/agent-debug/snapshot?runs=300&archived=only')
      assert.equal(only.status, 200)
      assert.ok(only.body.runs.every((run) => run.origin === 'archive'))
      // 注意：本次进程已落盘的 run 会同时出现在归档索引里（only 视图以 archive 来源代表它），
      // 因此这里只断言来源，不断言「不含 runA」——include 视图的 live 优先级由下一条覆盖。
    })
    await checkAsync('snapshot?archived=include 混合视图仍带 archive 字段与 live run', async () => {
      const mixed = await request('/v1/agent-debug/snapshot?runs=50')
      assert.equal(mixed.status, 200)
      assert.ok(mixed.body.runs.some((run) => run.runId === runA && run.origin === 'live'))
      assert.equal(mixed.body.archive.enabled, true)
    })
  }
  await checkAsync('snapshot archived 非法取值 → 400', async () => {
    const invalid = await request('/v1/agent-debug/snapshot?archived=bogus')
    assert.equal(invalid.status, 400)
  })

  console.log(`\n== 结果：${failures === 0 ? '全部 PASS' : `${failures} 项 FAIL`} ==`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('SMOKE CRASH', error)
  process.exitCode = 1
})
