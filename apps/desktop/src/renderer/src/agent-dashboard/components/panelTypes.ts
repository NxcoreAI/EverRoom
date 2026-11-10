/** 面板共享 props：所有分析面板只读派生模型 + 回放光标 + 下钻选中，不自己取数。 */
import type { TraceInsight } from '../insight/types'

export interface PanelProps {
  /** 已派生好的 run 级洞察（buildTrace 的输出）。 */
  insight: TraceInsight
  /**
   * 回放光标（相对 run 开始的毫秒）；null 表示「不在回放」。
   * 面板应当**弱化**光标之后的步骤，而不是重算聚合值。
   */
  cursorMs: number | null
  /** 当前下钻的步骤 id（`tool:xxx` / `llm:3:0` / null）。 */
  selectedStepId: string | null
  /** 点击步骤 → 打开下钻抽屉（传 null 关闭）。 */
  onSelectStep: (stepId: string | null) => void
}

/** 判断某个时间点是否已经「发生」（回放过滤的统一入口）。 */
export function hasHappened(atMs: number, cursorMs: number | null): boolean {
  return cursorMs === null || atMs <= cursorMs
}

/** 是否仍在光标之后（面板用它决定是否降透明度）。 */
export function isFuture(atMs: number, cursorMs: number | null): boolean {
  return cursorMs !== null && atMs > cursorMs
}
