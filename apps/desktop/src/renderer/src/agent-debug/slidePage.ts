/**
 * 调试台「逐页任务」展示的纯函数（PPT 单页布局等）。
 *
 * slides-layouter 的每个并发 run 处理一页，run 元数据里带 `slidePageIndex`（1 起）与
 * `slidePageCount`（总页数）。这里把「页归属」变成可展示的文本：
 * - Run 行的 `P3/12` 徽标（{@link slidePageBadge}）；
 * - Agent 行按 Agent 聚合运行中页序（{@link activeSlidePagesByAgent}），连续段压缩成
 *   `P1–P16` / `P1–P3 P7 +2`（{@link formatSlidePageSummary}），这样 PPT 生成时
 *   从 Agent 列表就能看出「这个布局 agent 正在负责哪几页」。
 *
 * 不依赖 React / DOM，便于单测。
 */
import type { AgentDebugRun } from '@nxcore/agent-contract'

export interface SlidePageRef {
  /** 页序，1 起。 */
  page: number
  /** 总页数；未知为 null。 */
  count: number | null
}

/** 从 run 提取逐页任务的页序；非逐页 / 非法数据返回 null。 */
export function slidePageOf(
  run: Pick<AgentDebugRun, 'slidePageIndex' | 'slidePageCount'>,
): SlidePageRef | null {
  const page = run.slidePageIndex
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null
  const count = run.slidePageCount
  const total = typeof count === 'number' && Number.isInteger(count) && count >= page ? count : null
  return { page, count: total }
}

/** Run 行徽标：`P3` / `P3/12`；非逐页 run 返回 null。 */
export function slidePageBadge(
  run: Pick<AgentDebugRun, 'slidePageIndex' | 'slidePageCount'>,
): string | null {
  const ref = slidePageOf(run)
  if (!ref) return null
  return ref.count === null ? `P${ref.page}` : `P${ref.page}/${ref.count}`
}

/** Run 行 / 详情 hover 文案：`第 3 页（共 12 页）`。 */
export function slidePageTitle(
  run: Pick<AgentDebugRun, 'slidePageIndex' | 'slidePageCount'>,
): string | null {
  const ref = slidePageOf(run)
  if (!ref) return null
  return ref.count === null ? `第 ${ref.page} 页` : `第 ${ref.page} 页（共 ${ref.count} 页）`
}

/**
 * 按 Agent 聚合「运行中」逐页 run 的页序（升序去重）。
 * 非运行中 run、没有页序字段的 run 都被忽略；没有页的 Agent 不出现在 Map 里。
 */
export function activeSlidePagesByAgent(runs: readonly AgentDebugRun[]): Map<string, number[]> {
  const pagesByAgent = new Map<string, Set<number>>()
  for (const run of runs) {
    if (run.status !== 'running') continue
    const ref = slidePageOf(run)
    if (!ref) continue
    const pages = pagesByAgent.get(run.agentId)
    if (pages) pages.add(ref.page)
    else pagesByAgent.set(run.agentId, new Set([ref.page]))
  }
  const sorted = new Map<string, number[]>()
  for (const [agentId, pages] of pagesByAgent) {
    sorted.set(agentId, [...pages].sort((left, right) => left - right))
  }
  return sorted
}

/** 连续页号压缩后的片段：单页 `P7`、连续段 `P1–P5`。 */
interface PageSegment {
  label: string
  /** 该片段包含的页数（折叠时用于算 `+N`）。 */
  size: number
}

function splitPageSegments(pages: readonly number[]): PageSegment[] {
  const unique = [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page > 0)
    .sort((left, right) => left - right)
  const segments: PageSegment[] = []
  let start: number | null = null
  let previous = 0
  const close = (): void => {
    if (start === null) return
    segments.push({
      label: start === previous ? `P${start}` : `P${start}–P${previous}`,
      size: previous - start + 1,
    })
    start = null
  }
  for (const page of unique) {
    if (start === null) {
      start = page
    } else if (page !== previous + 1) {
      close()
      start = page
    }
    previous = page
  }
  close()
  return segments
}

/**
 * 页集合 → 紧凑文本：连续段压缩（`1..16` → `P1–P16`，`1,2,3,7,9,10` → `P1–P3 P7 P9–P10`）。
 * 段数超过 `maxSegments` 时尾部折叠成 `+N`（N = 被折叠的页数），例如 7 个孤立页 →
 * `P1 P3 P5 P7 +3`。空集合返回空字符串。
 */
export function formatSlidePageSummary(pages: readonly number[], maxSegments = 4): string {
  const segments = splitPageSegments(pages)
  if (segments.length === 0) return ''
  if (segments.length <= maxSegments) return segments.map((segment) => segment.label).join(' ')
  const visible = segments.slice(0, maxSegments)
  const folded = segments.slice(maxSegments).reduce((sum, segment) => sum + segment.size, 0)
  return `${visible.map((segment) => segment.label).join(' ')} +${folded}`
}

/** 完整页列表 hover 文案：`正在处理第 1、2、3 页`；超过 `maxListed` 页时以「等 N 页」收尾。 */
export function slidePagesTitle(pages: readonly number[], maxListed = 16): string {
  const unique = [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page > 0)
    .sort((left, right) => left - right)
  if (unique.length === 0) return ''
  const listed = unique.slice(0, maxListed).join('、')
  if (unique.length > maxListed) return `正在处理第 ${listed} 等 ${unique.length} 页`
  return `正在处理第 ${listed} 页`
}
