/**
 * 链路剖析看板派生层单测：用**真实归档事件**（脱敏后放进 fixtures）验证 buildTrace 的口径。
 * 这里断言的是「可解释性」约束（时间不重叠、数字能对上事件条数、失败能归类），
 * 不是易变的绝对数值——真实数据会随时间变化，fixture 是固定快照。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { AgentDebugEvent, AgentDebugRun } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { buildTrace } from '../src/renderer/src/agent-dashboard/insight/buildTrace'
import { findPrice } from '../src/renderer/src/agent-dashboard/insight/pricing'
import { breakdownShares, THRESHOLDS, buildAnomalies } from '../src/renderer/src/agent-dashboard/insight/analyze'
import { classifyToolError } from '../src/renderer/src/agent-dashboard/insight/toolErrors'
import { extractRetrieval, isRetrievalTool } from '../src/renderer/src/agent-dashboard/insight/retrieval'
import { assignLanes, clusterByGap, maxConcurrency, unionLength } from '../src/renderer/src/agent-dashboard/insight/timeMath'

interface LoadedArchive {
  run: AgentDebugRun
  events: AgentDebugEvent[]
  rawLines: number
}

function loadFixture(name: string): LoadedArchive {
  const path = resolve(__dirname, 'fixtures/agent-dashboard', name)
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0)
  let run: AgentDebugRun | null = null
  const events: AgentDebugEvent[] = []
  for (const line of lines) {
    const parsed = JSON.parse(line) as { kind: string; run?: AgentDebugRun; event?: AgentDebugEvent }
    if (parsed.kind === 'run' && parsed.run) run = parsed.run
    if (parsed.kind === 'event' && parsed.event) events.push(parsed.event)
  }
  if (!run) throw new Error(`fixture 缺少 run 头：${name}`)
  return { run, events, rawLines: lines.length }
}

const price = findPrice('claude-sonnet-4.5')

describe('buildTrace · 真实归档', () => {
  const fixture = loadFixture('run-with-tools.ndjson')
  const insight = buildTrace(fixture.run, fixture.events, { price })

  it('回合数对齐 context.usage 事件条数', () => {
    const usageEvents = fixture.events.filter((event) => event.type === 'context.usage')
    expect(insight.rounds).toHaveLength(usageEvents.length)
    expect(insight.totals.rounds).toBe(usageEvents.length)
  })

  it('工具调用数对齐 tool.started 事件条数，且每个都有耗时', () => {
    const started = fixture.events.filter((event) => event.type === 'tool.started')
    expect(insight.tools).toHaveLength(started.length)
    for (const tool of insight.tools) {
      expect(tool.durationMs).toBeGreaterThanOrEqual(0)
      expect(tool.endMs).toBeGreaterThanOrEqual(tool.startMs)
      expect(tool.name.length).toBeGreaterThan(0)
    }
  })

  it('wall time 等于 startedAt → completedAt，且拆解四段不越界', () => {
    const expected = Date.parse(fixture.run.completedAt ?? '') - Date.parse(fixture.run.startedAt)
    expect(insight.wallMs).toBe(expected)
    const { breakdown } = insight
    expect(breakdown.toolMs + breakdown.llmMs).toBeLessThanOrEqual(breakdown.wallMs + 1)
    expect(breakdown.gapMs).toBeGreaterThanOrEqual(0)
    expect(breakdown.ttftMs).toBeGreaterThanOrEqual(0)
    expect(breakdown.modelWaitMs).toBeGreaterThanOrEqual(0)
    expect(breakdown.toolMs + breakdown.llmMs + breakdown.modelWaitMs + breakdown.gapMs)
      .toBeLessThanOrEqual(breakdown.wallMs + 1)
    const shares = breakdownShares(breakdown)
    expect(shares.tool + shares.llm + shares.wait + shares.gap).toBeCloseTo(1, 6)
  })

  it('token 与成本来自 runUsage 累计口径（首回合直接取累计值）', () => {
    const firstUsage = fixture.events.find((event) => event.type === 'context.usage')
    const payload = (firstUsage?.payload ?? {}) as { runUsage?: { input?: number; output?: number } }
    expect(insight.rounds[0].usageCumulative?.input).toBe(payload.runUsage?.input)
    expect(insight.totals.usageComplete).toBe(true)
    expect(insight.totals.usage.input).toBeGreaterThan(0)
    expect(insight.totals.costUsd).toBeGreaterThan(0)
    const roundCosts = insight.rounds.reduce((total, round) => total + (round.costUsd ?? 0), 0)
    expect(roundCosts).toBeCloseTo(insight.totals.costUsd ?? 0, 10)
  })

  it('非流式运行不伪造 TTFT：单发 delta 的回合 streamed=false 且 ttft=null', () => {
    const total = insight.totals.streamedRounds + insight.totals.singleShotRounds
    expect(total).toBe(insight.rounds.length)
    for (const round of insight.rounds) {
      if (round.streamed) continue
      expect(round.ttftMs).toBeNull()
    }
    // 该 fixture 的 runtime 是单发 delta，模型延迟体现在 modelWait 而不是 TTFT。
    if (insight.totals.singleShotRounds > 0) {
      expect(breakdownWaitTotal(insight)).toBeGreaterThan(0)
    }
  })

  it('上下文采样百分比 = tokens / contextWindow', () => {
    for (const sample of insight.contextSeries) {
      if (sample.tokens === null || sample.percent === null) continue
      expect(sample.percent).toBeCloseTo((sample.tokens / sample.contextWindow) * 100, 2)
    }
  })

  it('甘特行都落在 [0, wall] 内，且带下钻锚点', () => {
    for (const row of insight.rows) {
      expect(row.startMs).toBeGreaterThanOrEqual(0)
      expect(row.endMs).toBeLessThanOrEqual(insight.wallMs + 1)
      if (row.kind === 'tool') expect(row.toolCallId).not.toBeNull()
    }
    expect(insight.rows.length).toBeGreaterThan(insight.tools.length - 1)
  })

  it('检索类工具被识别成 RAG 召回记录', () => {
    const retrievalTools = fixture.events.filter((event) => {
      const payload = (event.payload ?? {}) as { name?: string }
      return event.type === 'tool.started' && isRetrievalTool(payload.name)
    })
    expect(insight.retrievals).toHaveLength(retrievalTools.length)
    expect(insight.retrievals.length).toBeGreaterThan(0)
    for (const retrieval of insight.retrievals) {
      expect(retrieval.query.length).toBeGreaterThan(0)
      // 真数据里既有 0 命中的检索（runtime 回「没有匹配」提示），也有 5 条命中的；
      // 0 命中时不许把提示句当召回片段。
      if ((retrieval.hitCount ?? 0) > 0) expect(retrieval.chunks.length).toBeGreaterThan(0)
      else expect(retrieval.chunks).toHaveLength(0)
    }
  })

  it('派生模型可直接喂给异常清单（无异常时不报错）', () => {
    const anomalies = buildAnomalies({
      tools: insight.tools,
      rounds: insight.rounds,
      contextSeries: insight.contextSeries,
      peakContextPercent: insight.totals.peakContextPercent,
    })
    expect(Array.isArray(anomalies)).toBe(true)
  })
})

describe('buildTrace · 含失败的 run', () => {
  const fixture = loadFixture('run-with-failures.ndjson')
  const insight = buildTrace(fixture.run, fixture.events, { price })

  it('失败工具带归类与错误摘要', () => {
    const failed = insight.tools.filter((tool) => tool.status === 'failed' || tool.status === 'timeout')
    expect(failed.length).toBeGreaterThan(0)
    for (const tool of failed) {
      expect(tool.severity).toBe('error')
      expect(tool.errorClass).not.toBeNull()
      expect(tool.error).toBeTruthy()
    }
    expect(insight.totals.toolFailures).toBe(failed.length)
  })

  it('失败后重试被识别成「重试风暴」异常（而非同名同参死循环）', () => {
    const retried = insight.tools.filter((tool) => tool.name === 'subagent_submit_result')
    expect(retried.length).toBeGreaterThan(1)
    const retryAnomalies = insight.anomalies.filter((anomaly) => anomaly.kind === 'retry')
    expect(retryAnomalies.length).toBeGreaterThan(0)
    expect(retryAnomalies[0].title).toContain('重试')
  })

  it('工具耗时占比与工具总耗时一致', () => {
    const total = insight.toolStats.reduce((sum, stat) => sum + stat.totalMs, 0)
    expect(total).toBeCloseTo(insight.breakdown.toolMs + overlapOf(insight), -3)
    const shares = insight.toolStats.reduce((sum, stat) => sum + (stat.timeShare ?? 0), 0)
    if (total > 0) expect(shares).toBeCloseTo(1, 6)
  })
})

function breakdownWaitTotal(insight: ReturnType<typeof buildTrace>): number {
  return insight.rounds.reduce((total, round) => total + round.modelWaitMs, 0)
}

/** 并行工具时长求和会大于时间占用的并集，这里用并集差作为容差。 */
function overlapOf(insight: ReturnType<typeof buildTrace>): number {
  const sum = insight.tools.reduce((total, tool) => total + tool.durationMs, 0)
  return Math.max(0, sum - insight.breakdown.toolMs)
}

describe('时间轴纯函数', () => {
  it('并集长度把并行区间只算一次', () => {
    expect(unionLength([{ startMs: 0, endMs: 100 }, { startMs: 50, endMs: 150 }])).toBe(150)
    expect(unionLength([{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 260 }])).toBe(160)
  })

  it('按停顿聚类能把生成与等待切开', () => {
    const clusters = clusterByGap([0, 100, 200, 5_000, 5_100], THRESHOLDS.generationGapMs)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].endMs).toBe(200)
    expect(clusters[1].startMs).toBe(5_000)
  })

  it('并发泳道贪心分配 + 最大并发度', () => {
    const lanes = assignLanes([
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 150 },
      { startMs: 160, endMs: 200 },
    ])
    expect(lanes).toEqual([0, 1, 0])
    expect(maxConcurrency([{ startMs: 0, endMs: 100 }, { startMs: 50, endMs: 150 }])).toBe(2)
  })
})

describe('工具错误归类与检索解析', () => {
  it('参数校验失败优先于其它规则', () => {
    const result = { content: [{ type: 'text', text: 'Validation failed for tool "x":\n - pages.0.role: must have required properties role' }] }
    expect(classifyToolError(result).errorClass).toBe('arg_validation')
  })

  it('超时 / 限流 / 上游 5xx 各自归类', () => {
    expect(classifyToolError({ content: [{ type: 'text', text: 'request timed out after 30000ms' }] }).errorClass).toBe('timeout')
    expect(classifyToolError({ content: [{ type: 'text', text: '429 Too Many Requests' }] }).errorClass).toBe('rate_limit')
    expect(classifyToolError({ content: [{ type: 'text', text: '503: {"message":"AI relay session is not active"}' }] }).errorClass).toBe('upstream')
  })

  it('结构化召回按条目解析，缺失相似度时为 null', () => {
    const extracted = extractRetrieval({
      details: { count: 2, wikis: [{ title: '品牌资料', text: '锥光是骑行科技品牌' }, { name: '会议纪要', snippet: '讨论了定价' }] },
    })
    expect(extracted.hitCount).toBe(2)
    expect(extracted.chunks).toHaveLength(2)
    expect(extracted.chunks[0].source).toBe('品牌资料')
    expect(extracted.chunks[0].score).toBeNull()
  })

  it('0 命中的检索不把「没有匹配」提示当成召回片段', () => {
    const run0 = {
      ...loadFixture('run-with-tools.ndjson').run,
      runId: 'zero-hit',
    }
    const events = [
      { seq: 1, type: 'tool.started', occurredAt: '2026-10-23T20:21:31.531Z', payload: { toolCallId: 'c1', name: 'memory_search', args: { query: '锥光' } } },
      { seq: 2, type: 'tool.completed', occurredAt: '2026-10-23T20:21:31.540Z', payload: { toolCallId: 'c1', name: 'memory_search', result: { content: [{ type: 'text', text: '该 Room 没有匹配的绑定记忆' }], details: { count: 0 } } } },
      { seq: 3, type: 'context.usage', occurredAt: '2026-10-23T20:21:33.967Z', payload: { tokens: 13090, contextWindow: 128000, percent: 10.2, runUsage: { input: 13163, output: 256 } } },
    ] as never
    const insight0 = buildTrace(run0, events, { price })
    expect(insight0.retrievals).toHaveLength(1)
    expect(insight0.retrievals[0].hitCount).toBe(0)
    expect(insight0.retrievals[0].chunks).toHaveLength(0)
    expect(insight0.retrievals[0].fedToContext).toBeNull()
  })

  it('纯文本召回按项目符号切片段', () => {
    const extracted = extractRetrieval({ content: [{ type: 'text', text: '- 片段一\n- 片段二\n- 片段三' }] })
    expect(extracted.chunks).toHaveLength(3)
    expect(extracted.hitCount).toBe(3)
  })
})
