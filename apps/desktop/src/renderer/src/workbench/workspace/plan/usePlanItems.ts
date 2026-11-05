import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PlanItem, PlanStatus, UpdatePlanItemInput } from '@nxcore/agent-contract'

import { workbenchApi } from '../../api'
import {
  applyLocalMove,
  groupPlanItems,
  resolveDrop,
  upsertPlanItem,
  type PlanDropTarget,
} from './planDrag'

export type PlanLoadState = 'loading' | 'ready' | 'error' | 'unavailable'

/** 可编辑字段的补丁：版本号由 hook 补（调用方只管内容）。 */
export type PlanItemPatch = Omit<UpdatePlanItemInput, 'version'>

/**
 * 计划看板的数据面。
 *
 * 服务端是唯一权威：切页回来重新拉一次即可，不在渲染层做跨页缓存
 * （缓存一份"改了但没落库"的看板，比重新拉一次贵得多）。
 *
 * 实时：网关 SSE 经桌面主进程转发成 `plan:changed`，按 id upsert；
 * 另有 30s 兜底轮询，SSE 断线也不会不一致。
 */
export interface UsePlanItems {
  items: PlanItem[]
  groups: Record<PlanStatus, PlanItem[]>
  state: PlanLoadState
  error: string | null
  reload: () => Promise<void>
  createItem: (title: string, status?: PlanStatus) => Promise<PlanItem | null>
  updateItem: (item: PlanItem, patch: PlanItemPatch) => Promise<PlanItem | null>
  moveItem: (item: PlanItem, target: PlanDropTarget, extra?: { ownerKind?: PlanItem['ownerKind'] }) => Promise<boolean>
  dropItem: (dragId: string, column: PlanStatus, index: number) => Promise<boolean>
  assignItem: (item: PlanItem, agentId?: string) => Promise<{ sessionId: string; runId: string } | null>
  removeItem: (item: PlanItem) => Promise<boolean>
}

const REALTIME_FALLBACK_MS = 30_000

export function usePlanItems(workspaceId: string): UsePlanItems {
  const [items, setItems] = useState<PlanItem[]>([])
  const [state, setState] = useState<PlanLoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const reload = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = await workbenchApi.listPlanItems(workspaceId)
      setItems(next)
      setState('ready')
      setError(null)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '计划加载失败'
      // 旧网关没有 plan 端点时给"能力不可用"而不是红色报错。
      setState(/404|未就绪|not found/i.test(message) ? 'unavailable' : 'error')
      setError(message)
    } finally {
      inFlight.current = false
    }
  }, [workspaceId])

  useEffect(() => {
    setState('loading')
    void reload()
  }, [reload])

  // 实时 + 兜底轮询：只在页面挂载期间订阅（看板是唯一消费者）。
  useEffect(() => {
    const off = workbenchApi.subscribePlanChanges(workspaceId, (item) => {
      setItems((current) => upsertPlanItem(current, item))
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, REALTIME_FALLBACK_MS)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [workspaceId, reload])

  const createItem = useCallback(async (title: string, status: PlanStatus = 'todo') => {
    try {
      const created = await workbenchApi.createPlanItem({ workspaceId, title, status })
      setItems((current) => upsertPlanItem(current, created))
      return created
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新建任务失败')
      return null
    }
  }, [workspaceId])

  const updateItem = useCallback(async (item: PlanItem, patch: PlanItemPatch) => {
    try {
      const saved = await workbenchApi.updatePlanItem(item.id, { ...patch, version: item.version })
      setItems((current) => upsertPlanItem(current, saved))
      return saved
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
      // 冲突/失败后拉一次真实状态，避免界面停在错误的乐观态。
      void reload()
      return null
    }
  }, [reload])

  const moveItem = useCallback(async (
    item: PlanItem,
    target: PlanDropTarget,
    extra: { ownerKind?: PlanItem['ownerKind'] } = {},
  ) => {
    const snapshot = items
    setItems(applyLocalMove(snapshot, item.id, target))
    try {
      const saved = await workbenchApi.movePlanItem(item.id, {
        version: item.version,
        status: target.status,
        beforeId: target.beforeId,
        afterId: target.afterId,
        ...extra,
      })
      // 用服务端顺序重排：把本地的这一条替换成权威版本。
      setItems((current) => upsertPlanItem(current, saved))
      return true
    } catch (reason) {
      setItems(snapshot)
      setError(reason instanceof Error ? reason.message : '移动失败，已恢复')
      return false
    }
  }, [items])

  const dropItem = useCallback(async (dragId: string, column: PlanStatus, index: number) => {
    const item = items.find((entry) => entry.id === dragId)
    if (!item) return false
    return moveItem(item, resolveDrop(items, dragId, column, index))
  }, [items, moveItem])

  const assignItem = useCallback(async (item: PlanItem, agentId?: string) => {
    try {
      const result = await workbenchApi.assignPlanItem(item.id, agentId)
      setItems((current) => upsertPlanItem(current, result.item))
      return { sessionId: result.sessionId, runId: result.runId }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '交给 Agent 失败')
      return null
    }
  }, [])

  const removeItem = useCallback(async (item: PlanItem) => {
    try {
      const saved = await workbenchApi.removePlanItem(item.id)
      setItems((current) => upsertPlanItem(current, saved))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '取消任务失败')
      return false
    }
  }, [])

  const groups = useMemo(() => groupPlanItems(items), [items])

  return {
    items,
    groups,
    state,
    error,
    reload,
    createItem,
    updateItem,
    moveItem,
    dropItem,
    assignItem,
    removeItem,
  }
}
