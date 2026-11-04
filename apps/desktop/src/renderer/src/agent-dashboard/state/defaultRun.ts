/**
 * 默认选中的 run：优先「有内容」的 run，其次最新。
 *
 * 归档里大量 run 是早期失败/被打断的空壳（只有 5 条事件、0 次工具），
 * 如果只取列表第一条，用户第一眼会看到一个空面板，误以为看板坏了。
 * 规则：运行中 → 最近 30 分钟内且工具数 > 0 的最新 run → 事件最多的 run → 最新 run。
 */
import type { AgentDebugRun } from '@nxcore/agent-contract'

export function pickDefaultRun(
  runs: readonly AgentDebugRun[],
  now = Date.now(),
  recentWindowMs = 30 * 60_000,
): AgentDebugRun | null {
  if (runs.length === 0) return null

  const running = runs.find((run) => run.status === 'running')
  if (running) return running

  const startedAt = (run: AgentDebugRun): number => {
    const time = Date.parse(run.startedAt)
    return Number.isFinite(time) ? time : 0
  }
  const sorted = [...runs].sort((left, right) => startedAt(right) - startedAt(left))

  const recentInformative = sorted.find(
    (run) => run.toolCallCount > 0 && now - startedAt(run) <= recentWindowMs,
  )
  if (recentInformative) return recentInformative

  // 分数相同（比如全是空壳 run）时取更新的那条，避免「随机」选到最旧的。
  const richest = [...runs].sort(
    (left, right) => scoreOf(right) - scoreOf(left) || startedAt(right) - startedAt(left),
  )[0]
  if (richest && scoreOf(richest) > 0) return richest

  return sorted[0]
}

/** 信息量打分：工具调用最能反映链路，其次是事件条数。 */
function scoreOf(run: AgentDebugRun): number {
  return run.toolCallCount * 10 + run.eventCount
}
