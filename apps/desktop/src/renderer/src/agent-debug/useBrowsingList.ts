/**
 * 两栏列表的「浏览时锁序 + 视口锚定」Hook。
 *
 * 纯逻辑（顺序冻结、锚点选取、偏移换算）在 browseOrder.ts；这里只做 DOM 交互：
 * - 监听滚动容器：离开顶部即进入 browsing，并记录视口顶部那一行作为锚点；
 * - 每次提交后用 useLayoutEffect 把锚点行放回原来的视口偏移（新行插到顶部时不移动
 *   用户正在看的内容），绘制前完成，不会闪；
 * - 回到顶部 / 点「回到顶部」：清锚点、解除 browsing，列表恢复实时排序。
 *
 * 行标记用 `data-row-key`；列表里所有可能成为视口锚点的行都要带（run 行、会话组头、
 * 「全部 Agent」行）。滚动锚定由这里接管，对应列表需要 `overflow-anchor: none`，
 * 否则浏览器原生锚定会和这里的修正互相打架。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  anchorScrollAdjustment,
  freezeOrder,
  freezeSessionGroups,
  isBrowsingScroll,
  pickRowAnchor,
  sessionGroupOrderOf,
  type RowGeometry,
  type SessionGroupOrder,
} from './browseOrder'
import type { SessionGroup } from './history'

const ROW_ATTRIBUTE = 'data-row-key'
const ROW_SELECTOR = `[${ROW_ATTRIBUTE}]`
const ANCHOR_EPSILON_PX = 0.5

interface ScrollAnchor {
  id: string
  offset: number
  resetKey: string
}

export interface BrowsingListState {
  /** 挂到列表滚动容器上。 */
  scrollRef: RefObject<HTMLDivElement>
  /** 是否离开顶部：为 true 时列表应冻结行顺序。 */
  browsing: boolean
  /** 挂到滚动容器的 onScroll。 */
  onScroll: () => void
  /** 回到顶部并恢复实时排序。 */
  scrollToTop: () => void
}

export function useBrowsingList(resetKey: string): BrowsingListState {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [browsing, setBrowsing] = useState(false)
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const resetKeyRef = useRef(resetKey)
  resetKeyRef.current = resetKey

  const onScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const next = isBrowsingScroll(container.scrollTop)
    setBrowsing(next)
    if (!next) {
      anchorRef.current = null
      return
    }
    const anchor = readVisibleAnchor(container)
    anchorRef.current = anchor ? { ...anchor, resetKey: resetKeyRef.current } : null
  }, [])

  const scrollToTop = useCallback(() => {
    anchorRef.current = null
    setBrowsing(false)
    const container = scrollRef.current
    if (container) container.scrollTop = 0
  }, [])

  // 切换 Agent / 会话 / 范围后整列内容被换掉：旧的锚点和锁序都失效，回到顶部。
  useEffect(() => {
    anchorRef.current = null
    setBrowsing(false)
    const container = scrollRef.current
    if (container && container.scrollTop !== 0) container.scrollTop = 0
  }, [resetKey])

  // 每次提交后校正 scrollTop：锚点行被上方新增内容推下时，把它滚回原视口位置。
  useLayoutEffect(() => {
    const container = scrollRef.current
    const anchor = anchorRef.current
    if (!container || !anchor) return
    if (anchor.resetKey !== resetKeyRef.current) return
    if (!isBrowsingScroll(container.scrollTop)) return
    const element = findRowElement(container, anchor.id)
    if (!element) return
    const delta = anchorScrollAdjustment(
      element.getBoundingClientRect().top,
      container.getBoundingClientRect().top,
      anchor.offset,
    )
    if (Math.abs(delta) < ANCHOR_EPSILON_PX) return
    container.scrollTop += delta
  })

  return { scrollRef, browsing, onScroll, scrollToTop }
}

/**
 * 扁平列表的顺序：未浏览时用数据源排序并把当前顺序记为基准；浏览时按基准冻结，
 * 新行插到最前（行内容仍会被替换成最新数据）。
 */
export function useBrowsingOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  browsing: boolean,
  resetKey: string,
): readonly T[] {
  const baselineRef = useRef<{ resetKey: string; ids: string[] } | null>(null)
  return useMemo(() => {
    const baseline = baselineRef.current
    if (!browsing || !baseline || baseline.resetKey !== resetKey) {
      baselineRef.current = { resetKey, ids: items.map(idOf) }
      return items
    }
    return freezeOrder(baseline.ids, items, idOf)
  }, [items, idOf, browsing, resetKey])
}

/** 会话分组列表的顺序：组顺序与每组内 run 顺序都按浏览开始时的基准冻结。 */
export function useBrowsingGroupOrder(
  groups: readonly SessionGroup[],
  browsing: boolean,
  resetKey: string,
): readonly SessionGroup[] {
  const baselineRef = useRef<{ resetKey: string; order: SessionGroupOrder } | null>(null)
  return useMemo(() => {
    const baseline = baselineRef.current
    if (!browsing || !baseline || baseline.resetKey !== resetKey) {
      baselineRef.current = { resetKey, order: sessionGroupOrderOf(groups) }
      return groups
    }
    return freezeSessionGroups(baseline.order, groups)
  }, [groups, browsing, resetKey])
}

/** 视口顶部第一条可见行（带 resetKey 校验，避免旧锚点碰巧命中同 id 的新行）。 */
function readVisibleAnchor(container: HTMLElement): { id: string; offset: number } | null {
  const containerTop = container.getBoundingClientRect().top
  const rows: RowGeometry[] = []
  for (const element of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const id = element.dataset.rowKey
    if (!id) continue
    const rect = element.getBoundingClientRect()
    rows.push({ id, top: rect.top, bottom: rect.bottom })
    // 找到第一条露出的行即可停止，滚动时不必测量整列。
    if (rect.bottom > containerTop + ANCHOR_EPSILON_PX) break
  }
  return pickRowAnchor(rows, containerTop)
}

function findRowElement(container: HTMLElement, id: string): HTMLElement | null {
  for (const element of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (element.dataset.rowKey === id) return element
  }
  return null
}
