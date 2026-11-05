import type { PlanItem, PlanStatus } from '@nxcore/agent-contract'

/** 一次拖放的落点：目标列 + 前后邻居（null = 该端没有邻居）。 */
export interface PlanDropTarget {
  status: PlanStatus
  /** 目标位置**前**一张卡片（列首时为 null）。 */
  beforeId: string | null
  /** 目标位置**后**一张卡片（列尾时为 null）。 */
  afterId: string | null
}

/** 看板列顺序与列名（渲染层与网关共用语义，只是展示文案在这里）。 */
export const PLAN_COLUMNS: ReadonlyArray<{ status: PlanStatus; label: string; hint: string }> = [
  { status: 'todo', label: '待开始', hint: '认下来了但还没人动' },
  { status: 'doing', label: '进行中', hint: '有人（或某个 Agent 会话）在做' },
  { status: 'done', label: '已完成', hint: '有结论' },
  { status: 'dropped', label: '已取消', hint: '不做了' },
]

/** 把扁平的 items（服务端按 rank 排好）按列分组，列内保持原有顺序。 */
export function groupPlanItems(
  items: readonly PlanItem[],
): Record<PlanStatus, PlanItem[]> {
  const groups: Record<PlanStatus, PlanItem[]> = { todo: [], doing: [], done: [], dropped: [] }
  for (const item of items) groups[item.status].push(item)
  return groups
}

/**
 * 计算拖放落点。
 *
 * `index` 是**落点在目标列里插入的下标**（已排除被拖动的卡片）。列内位置与是否
 * 跨列无关：跨列时目标列就是新的 status，同列时只改排序。
 *
 * 纯函数：拖拽交互的全部状态机都在这里，组件不参与判断，单测直接覆盖。
 */
export function resolveDrop(
  items: readonly PlanItem[],
  dragId: string,
  column: PlanStatus,
  index: number,
): PlanDropTarget {
  const columnItems = items.filter((item) => item.status === column && item.id !== dragId)
  const clamped = Math.min(Math.max(index, 0), columnItems.length)
  const before = clamped > 0 ? columnItems[clamped - 1]! : null
  const after = clamped < columnItems.length ? columnItems[clamped]! : null
  return {
    status: column,
    beforeId: before?.id ?? null,
    afterId: after?.id ?? null,
  }
}

/**
 * 乐观重排：把卡片按落点移动到目标列的目标位置。
 *
 * 只在本地数组里搬位置，不参与 rank 计算——rank 是网关的事，返回后由服务端
 * 的真实顺序覆盖（失败时调用方整体回滚成旧快照）。
 */
export function applyLocalMove(
  items: readonly PlanItem[],
  dragId: string,
  target: Pick<PlanDropTarget, 'status' | 'beforeId' | 'afterId'>,
): PlanItem[] {
  const dragged = items.find((item) => item.id === dragId)
  if (!dragged) return [...items]
  const rest = items.filter((item) => item.id !== dragId)
  const moved: PlanItem = { ...dragged, status: target.status }

  const afterIndex = target.afterId ? rest.findIndex((item) => item.id === target.afterId) : -1
  if (afterIndex >= 0) {
    const next = [...rest]
    next.splice(afterIndex, 0, moved)
    return next
  }
  const beforeIndex = target.beforeId ? rest.findIndex((item) => item.id === target.beforeId) : -1
  if (beforeIndex >= 0) {
    const next = [...rest]
    next.splice(beforeIndex + 1, 0, moved)
    return next
  }
  // 目标列为空（或邻居已消失）：放到数组末尾（列内即列尾）。
  return [...rest, moved]
}

/** 单条 upsert：实时推送与写回共用，保持列内顺序不跳。
 *  非对象输入（如 SSE ready 帧缺 item 时的 undefined）原样丢弃——数组一旦
 *  混入 undefined，看板渲染即崩（reading 'status'）。 */
export function upsertPlanItem(items: readonly PlanItem[], next: PlanItem): PlanItem[] {
  if (!next || typeof next !== 'object') return items as PlanItem[]
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  const copy = [...items]
  copy[index] = next
  return copy
}

/** 截止时间是否已过期（只比日期，避免同一天显示成"已过期"）。 */
export function isPlanOverdue(dueAt: string | null, now = Date.now()): boolean {
  if (!dueAt) return false
  const time = Date.parse(dueAt)
  if (!Number.isFinite(time)) return false
  return time < now - 24 * 60 * 60_000
}

/** 卡片上的负责人标签。 */
export function planOwnerLabel(item: PlanItem): string {
  if (item.ownerKind === 'agent') return item.ownerAgentId ? `Agent ${item.ownerAgentId}` : 'Agent'
  if (item.ownerKind === 'user') return '我'
  return '待认领'
}
