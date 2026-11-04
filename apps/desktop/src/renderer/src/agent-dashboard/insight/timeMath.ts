/** 时间轴算术：区间并集、按停顿聚类、并发泳道分配。纯函数，便于单测。 */
import type { TimeSpan } from './types'

function clampSpan(span: TimeSpan): TimeSpan | null {
  const startMs = Number.isFinite(span.startMs) ? span.startMs : 0
  const endMs = Number.isFinite(span.endMs) ? span.endMs : startMs
  if (endMs < startMs) return { startMs: endMs, endMs: startMs }
  return { startMs, endMs }
}

/** 区间合并（相邻/重叠都合并），输入顺序无关。 */
export function unionSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const sorted = spans
    .map(clampSpan)
    .filter((span): span is TimeSpan => span !== null)
    .sort((left, right) => left.startMs - right.startMs)
  const merged: TimeSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs)
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/** 区间并集总长度（并行区间只算一次）。 */
export function unionLength(spans: readonly TimeSpan[]): number {
  return unionSpans(spans).reduce((total, span) => total + (span.endMs - span.startMs), 0)
}

/**
 * 时间点聚类：相邻时间点间隔 > gapMs 就断开。用于把一串 delta 事件切成「真生成片段」，
 * 工具执行/入队期间没有 delta，自然被切开，不会把停顿算成生成时间。
 */
export interface Cluster {
  startMs: number
  endMs: number
  count: number
  /** 该簇在输入数组里的下标范围（含）。 */
  fromIndex: number
  toIndex: number
}

export function clusterByGap(times: readonly number[], gapMs: number): Cluster[] {
  const clusters: Cluster[] = []
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index]
    if (!Number.isFinite(time)) continue
    const last = clusters[clusters.length - 1]
    if (last && time - last.endMs <= gapMs) {
      last.endMs = Math.max(last.endMs, time)
      last.count += 1
      last.toIndex = index
      continue
    }
    clusters.push({ startMs: time, endMs: time, count: 1, fromIndex: index, toIndex: index })
  }
  return clusters
}

/**
 * 并发泳道分配：按开始时间贪心占用最早空出的泳道。
 * 返回与输入等长的泳道号数组（0 起），同时可用于计算「同时有几个工具在跑」。
 */
export function assignLanes(spans: ReadonlyArray<{ startMs: number; endMs: number }>): number[] {
  const order = spans
    .map((span, index) => ({ index, startMs: span.startMs, endMs: Math.max(span.startMs, span.endMs) }))
    .sort((left, right) => left.startMs - right.startMs || left.index - right.index)
  const laneFreeAt: number[] = []
  const lanes = new Array<number>(spans.length).fill(0)
  for (const item of order) {
    let lane = laneFreeAt.findIndex((freeAt) => freeAt <= item.startMs)
    if (lane === -1) {
      laneFreeAt.push(item.endMs)
      lane = laneFreeAt.length - 1
    } else {
      laneFreeAt[lane] = item.endMs
    }
    lanes[item.index] = lane
  }
  return lanes
}

/** 最大并发度（同一瞬间最多几个区间重叠）。 */
export function maxConcurrency(spans: readonly TimeSpan[]): number {
  const events: Array<{ at: number; delta: number }> = []
  for (const span of spans) {
    const startMs = Math.min(span.startMs, span.endMs)
    const endMs = Math.max(span.startMs, span.endMs)
    if (endMs === startMs) continue
    events.push({ at: startMs, delta: 1 }, { at: endMs, delta: -1 })
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta)
  let current = 0
  let peak = 0
  for (const event of events) {
    current += event.delta
    peak = Math.max(peak, current)
  }
  return peak
}
