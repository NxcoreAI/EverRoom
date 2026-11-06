/** 时间轴公共刻度：所有横向图表共用同一比例尺，保证上下对齐可读。 */
import { formatOffset } from '../insight/format'

import './time-scale.css'

/** 相对时间 → 百分比位置（0–100）。 */
export function pctOf(atMs: number, wallMs: number): number {
  if (!Number.isFinite(wallMs) || wallMs <= 0) return 0
  return Math.min(100, Math.max(0, (atMs / wallMs) * 100))
}

/** 区段 → 宽度百分比（至少留 0.35%，让 1ms 的调用也看得见）。 */
export function widthOf(startMs: number, endMs: number, wallMs: number): number {
  const raw = pctOf(endMs, wallMs) - pctOf(startMs, wallMs)
  return Math.max(raw, 0.35)
}

/** 刻度间隔：让整条轴上出现 4–8 个标签，且间隔落在好看的整数上。 */
export function tickStep(wallMs: number): number {
  const target = wallMs / 6
  const steps = [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]
  return steps.find((step) => step >= target) ?? 3_600_000
}

export function ticksOf(wallMs: number): number[] {
  if (!Number.isFinite(wallMs) || wallMs <= 0) return [0]
  const step = tickStep(wallMs)
  const ticks: number[] = []
  for (let at = 0; at <= wallMs; at += step) ticks.push(at)
  return ticks
}

/** 顶部时间刻度尺：与下方所有泳道共享同一 DOM 宽度。 */
export function TimeRuler({ wallMs, compact = false }: { wallMs: number; compact?: boolean }) {
  const ticks = ticksOf(wallMs)
  return (
    <div className={compact ? 'ruler ruler-compact' : 'ruler'} aria-hidden="true">
      {ticks.map((tick) => (
        <div key={tick} className="ruler-tick" style={{ left: `${pctOf(tick, wallMs)}%` }}>
          <span className="ruler-label num">{formatOffset(tick)}</span>
        </div>
      ))}
    </div>
  )
}
