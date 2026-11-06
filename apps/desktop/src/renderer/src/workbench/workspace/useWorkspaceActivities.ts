import type { WorkspaceActivity, WorkspaceActivityPage } from '@nxcore/agent-contract'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ActivityItem, ActivitySegment } from './activity'

/**
 * 概览「动态」的服务端数据源（网关派生，见 `docs/workspace-overview-activity-plan.zh-CN.md` §5）。
 *
 * - 数据来自 `GET /v1/agent/workspaces/:id/activities`：runs 的开始/结束、文件库的产物/材料、
 *   计划事件流三源合并后按 (at, id) 游标分页；
 * - 桥不可用 / 请求失败 → `state === 'unavailable'`，调用方回落到本地派生
 *   （`buildActivities(sessions, files)`），离线与单测零成本；
 * - `refreshKey` 变了才重拉第一页（页面传「会话状态指纹」），避免每 3.5s 轮询都打网关。
 */

const DEFAULT_LIMIT = 20

export type WorkspaceActivityFeedState = 'loading' | 'ready' | 'unavailable'

export interface WorkspaceActivityFeed {
  state: WorkspaceActivityFeedState
  items: ActivityItem[]
  /** 服务端还有更早的事件（点「显示更早」再拉一页）。 */
  hasMore: boolean
  loadingMore: boolean
  loadMore(): void
  refresh(): void
}

interface Cursor {
  beforeAt: string
  beforeId: string
}

/** 契约段的 `sessionId` → 本地模型的 `workId`（产品里「工作」就是会话）。 */
function toSegment(segment: WorkspaceActivity['segments'][number]): ActivitySegment {
  const text = segment.text ? { text: segment.text } : {}
  if (segment.sessionId) return { workId: segment.sessionId, ...text }
  if (segment.fileId) return { fileId: segment.fileId, ...text }
  if (segment.planItemId) return { planItemId: segment.planItemId, ...text }
  return { text: segment.text ?? '' }
}

function toActivityItem(dto: WorkspaceActivity): ActivityItem {
  return {
    id: dto.id,
    kind: dto.kind,
    at: dto.at,
    segments: dto.segments.map(toSegment),
  }
}

export function useWorkspaceActivities(
  workspaceId: string,
  options: { limit?: number; refreshKey?: string; pollMs?: number } = {},
): WorkspaceActivityFeed {
  const limit = options.limit ?? DEFAULT_LIMIT
  const refreshKey = options.refreshKey ?? ''
  const pollMs = options.pollMs ?? 0

  const [state, setState] = useState<WorkspaceActivityFeedState>('loading')
  const [items, setItems] = useState<ActivityItem[]>([])
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // 并发保护：切空间/重拉时旧响应直接作废，不回写新列表。
  const requestSeq = useRef(0)
  // 轮询里要判断「用户是不是已经翻过页」，用 ref 拿最新值，避免把 interval 反复重建。
  const loadedCount = useRef(0)
  loadedCount.current = items.length

  const fetchPage = useCallback(async (before?: Cursor): Promise<WorkspaceActivityPage | null> => {
    const api = window.nxcore?.workspace
    if (typeof api?.activities !== 'function') return null
    try {
      return await api.activities(
        workspaceId,
        before
          ? { limit, beforeAt: before.beforeAt, beforeId: before.beforeId }
          : { limit },
      )
    } catch {
      return null
    }
  }, [limit, workspaceId])

  const reload = useCallback(async (): Promise<void> => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    const page = await fetchPage()
    if (seq !== requestSeq.current) return
    if (!page) {
      setItems([])
      setCursor(null)
      setState('unavailable')
      return
    }
    setItems(page.items.map(toActivityItem))
    setCursor(page.nextBeforeAt && page.nextBeforeId
      ? { beforeAt: page.nextBeforeAt, beforeId: page.nextBeforeId }
      : null)
    setState('ready')
  }, [fetchPage])

  useEffect(() => {
    // 首屏 state 初值就是 loading；后续 refreshKey 变化时**不**回到 loading，
    // 免得已渲染的列表闪一下退回本地派生。
    void reload()
  }, [reload, refreshKey])

  // 「等你确认」是活状态：审批卡弹出时会话的 status/updatedAt 都不变，
  // 指纹刷新抓不到，所以有运行中会话时才低频轮询（用户已翻页就不打断）。
  useEffect(() => {
    if (pollMs <= 0) return
    const timer = setInterval(() => {
      if (loadedCount.current > limit) return
      void reload()
    }, pollMs)
    return () => clearInterval(timer)
  }, [limit, pollMs, reload])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!cursor || loadingMore) return
    const seq = requestSeq.current
    setLoadingMore(true)
    const page = await fetchPage(cursor)
    if (seq === requestSeq.current && page) {
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id))
        const next = page.items.map(toActivityItem).filter((item) => !seen.has(item.id))
        return next.length > 0 ? [...previous, ...next] : previous
      })
      setCursor(page.nextBeforeAt && page.nextBeforeId
        ? { beforeAt: page.nextBeforeAt, beforeId: page.nextBeforeId }
        : null)
      setState('ready')
    }
    setLoadingMore(false)
  }, [cursor, fetchPage, loadingMore])

  // 稳定引用：调用方（页面）会把 refresh 放进 effect 依赖里，每次渲染换新函数会反复重建监听。
  const loadMoreStable = useCallback(() => {
    void loadMore()
  }, [loadMore])
  const refresh = useCallback(() => {
    void reload()
  }, [reload])

  return {
    state,
    items,
    hasMore: cursor !== null,
    loadingMore,
    loadMore: loadMoreStable,
    refresh,
  }
}
