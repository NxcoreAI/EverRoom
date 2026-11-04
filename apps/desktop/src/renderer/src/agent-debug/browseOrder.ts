/**
 * 调试台两栏列表「浏览时锁序」的纯逻辑（不依赖 React / DOM，便于单测）。
 *
 * 背景：Agent / Run 两栏每 1200ms 拉一次 snapshot，Gateway 按「运行中优先 + 最近活动」
 * 排序，运行中 run 的 lastEventAt、Agent 的 state 每次轮询都可能变化。用户向下滚动
 * 回看历史时行会不停换位，看起来像「整个列表被刷新」，没法阅读。
 *
 * 这里把「刷新数据」与「重排行」解耦：
 * - 距顶部超过 {@link BROWSE_TOP_THRESHOLD_PX} 视为正在浏览：冻结行顺序，新行插到
 *   顶部（它们本来就是最新活动），行内容仍在原位置实时更新；
 * - 视口锚定（{@link pickRowAnchor} / {@link anchorScrollAdjustment}）：插入或删除行
 *   后把用户正在看的那一行放回原来的视口位置，避免内容整体跳动；
 * - 回到顶部即恢复实时排序（由调用方用 `browsing === false` 触发）。
 *
 * 顺序冻结只决定「已存在行的相对顺序」，不改变任何行数据；被过滤掉 / 已淘汰的行
 * 自然消失，新行按数据源给的顺序排在最前。
 */

import type { SessionGroup } from './history'

/** 距列表顶部多少像素以内视为「在顶部」：回到顶部即恢复实时排序。 */
export const BROWSE_TOP_THRESHOLD_PX = 8

/** 当前是否处于「浏览」状态（scrollTop 可由浏览器滚动锚定微调，取整仅用于判定是/否）。 */
export function isBrowsingScroll(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop > BROWSE_TOP_THRESHOLD_PX
}

/**
 * 冻结旧顺序：已存在的行保持 `previousIds` 的相对顺序，新行插到最前（按 `items` 原顺序），
 * 已经消失的行丢弃。`previousIds` 为空表示没有可冻结的基准，直接返回数据源顺序。
 */
export function freezeOrder<T>(
  previousIds: readonly string[],
  items: readonly T[],
  idOf: (item: T) => string,
): T[] {
  if (previousIds.length === 0) return [...items]
  const byId = new Map<string, T>()
  for (const item of items) byId.set(idOf(item), item)
  const placed = new Set<string>()
  const frozen: T[] = []
  for (const id of previousIds) {
    if (placed.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    placed.add(id)
    frozen.push(item)
  }
  const added = items.filter((item) => !placed.has(idOf(item)))
  return [...added, ...frozen]
}

/** 会话分组的旧顺序：组顺序 + 每组内的 run 顺序（sessionKey → runId[]）。 */
export interface SessionGroupOrder {
  groups: string[]
  runs: Record<string, string[]>
}

/** 记录当前（实时）排序的基准顺序，供开始浏览后冻结。 */
export function sessionGroupOrderOf(groups: readonly SessionGroup[]): SessionGroupOrder {
  const runs: Record<string, string[]> = {}
  for (const group of groups) runs[group.option.key] = group.runs.map((run) => run.runId)
  return { groups: groups.map((group) => group.option.key), runs }
}

/**
 * 按旧顺序重排会话分组：组顺序与组内 run 顺序都冻结，新组 / 新 run 插到最前。
 * 组属性（计数、运行中状态）始终取当前数据，所以行内容仍然实时更新。
 */
export function freezeSessionGroups(
  previous: SessionGroupOrder | null,
  groups: readonly SessionGroup[],
): SessionGroup[] {
  if (!previous) return [...groups]
  const byKey = new Map<string, SessionGroup>()
  for (const group of groups) byKey.set(group.option.key, group)
  const previousKeys = new Set(previous.groups)
  const added = groups
    .filter((group) => !previousKeys.has(group.option.key))
    .map((group) => group.option.key)
  const orderedKeys = [...added, ...previous.groups.filter((key) => byKey.has(key))]
  const frozen: SessionGroup[] = []
  for (const key of orderedKeys) {
    const group = byKey.get(key)
    if (!group) continue
    frozen.push({
      option: group.option,
      runs: freezeOrder(previous.runs[key] ?? [], group.runs, (run) => run.runId),
    })
  }
  return frozen
}

/** 一行的视口几何（相对视口，来自 getBoundingClientRect）。 */
export interface RowGeometry {
  id: string
  top: number
  bottom: number
}

/** 视口顶部锚点：锁定行 + 它相对滚动容器顶部的偏移（可为负，表示行上半截在视口外）。 */
export interface RowAnchor {
  id: string
  offset: number
}

/**
 * 选出视口顶部第一条（可能只露出一部分的）行作为锚点。
 * 行按视觉顺序传入；`containerTop` 是滚动容器的视口坐标。
 */
export function pickRowAnchor(rows: readonly RowGeometry[], containerTop: number): RowAnchor | null {
  for (const row of rows) {
    if (row.bottom > containerTop + 0.5) return { id: row.id, offset: row.top - containerTop }
  }
  return null
}

/**
 * 把锚点行放回 `offset` 位置所需的 scrollTop 增量。
 * 行被上方插入的内容推下时该值为正（需要往下滚，抵消可视位移）。
 */
export function anchorScrollAdjustment(rowTop: number, containerTop: number, offset: number): number {
  return rowTop - containerTop - offset
}
