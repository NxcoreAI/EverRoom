import { describe, expect, it } from 'vitest'

import type { PlanItem, PlanStatus } from '@nxcore/agent-contract'

import { applyLocalMove, groupPlanItems, isPlanOverdue, resolveDrop, upsertPlanItem } from './planDrag'

/**
 * 看板拖拽的全部状态机都在 `resolveDrop` / `applyLocalMove` 里（纯函数），
 * 组件只负责把鼠标位置换算成 `index`。这里覆盖落点与乐观重排的边界。
 */

function item(id: string, status: PlanStatus, overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    workspaceId: 'ws-1',
    title: id,
    detail: null,
    acceptance: null,
    constraints: [],
    status,
    priority: 'normal',
    ownerKind: 'unassigned',
    ownerAgentId: null,
    assigneeSessionId: null,
    lastRunId: null,
    createdBy: 'user',
    createdByAgentId: null,
    dueAt: null,
    rank: id,
    tags: [],
    checklist: [],
    refs: [],
    blockedBy: [],
    resultSummary: null,
    closeReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    version: 1,
    completedAt: null,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    ...overrides,
  }
}

const board: PlanItem[] = [
  item('a', 'todo'),
  item('b', 'todo'),
  item('c', 'doing'),
]

describe('groupPlanItems', () => {
  it('按四列分组并保持原顺序', () => {
    const groups = groupPlanItems(board)
    expect(groups.todo.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(groups.doing.map((entry) => entry.id)).toEqual(['c'])
    expect(groups.done).toEqual([])
    expect(groups.dropped).toEqual([])
  })
})

describe('resolveDrop', () => {
  it('跨列落到空列 = 列首且无邻居', () => {
    expect(resolveDrop(board, 'a', 'done', 0)).toEqual({ status: 'done', beforeId: null, afterId: null })
  })

  it('同列插到首位 = afterId 是排除自己后的第一条', () => {
    expect(resolveDrop(board, 'a', 'todo', 0)).toEqual({ status: 'todo', beforeId: null, afterId: 'b' })
  })

  it('同列往后一格 = beforeId 是被越过的卡片', () => {
    expect(resolveDrop(board, 'a', 'todo', 1)).toEqual({ status: 'todo', beforeId: 'b', afterId: null })
  })

  it('跨列插到中间 = 前后邻居都在', () => {
    const extended = [...board, item('d', 'done'), item('e', 'done')]
    expect(resolveDrop(extended, 'a', 'done', 1)).toEqual({ status: 'done', beforeId: 'd', afterId: 'e' })
  })

  it('列尾 = beforeId 是最后一条，afterId 为 null', () => {
    expect(resolveDrop(board, 'c', 'todo', 2)).toEqual({ status: 'todo', beforeId: 'b', afterId: null })
  })

  it('下标越界被夹紧', () => {
    expect(resolveDrop(board, 'a', 'todo', 99)).toEqual({ status: 'todo', beforeId: 'b', afterId: null })
    expect(resolveDrop(board, 'a', 'todo', -5)).toEqual({ status: 'todo', beforeId: null, afterId: 'b' })
  })

  it('落点下标按"排除自己"计算（同列向后拖两位）', () => {
    const three = [item('a', 'todo'), item('b', 'todo'), item('c', 'todo')]
    // 把 a 拖到 b/c 之间：排除 a 后目标列是 [b, c]，index=1 → before=b, after=c
    expect(resolveDrop(three, 'a', 'todo', 1)).toEqual({ status: 'todo', beforeId: 'b', afterId: 'c' })
  })
})

describe('applyLocalMove', () => {
  it('跨列移动后数组顺序与目标位置一致', () => {
    const moved = applyLocalMove(board, 'a', { status: 'doing', beforeId: 'c', afterId: null })
    expect(moved.map((entry) => `${entry.id}:${entry.status}`)).toEqual(['b:todo', 'c:doing', 'a:doing'])
  })

  it('插到列首', () => {
    const extended = [...board, item('d', 'done')]
    const moved = applyLocalMove(extended, 'd', { status: 'todo', beforeId: null, afterId: 'a' })
    expect(moved.map((entry) => entry.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('目标为空列时追加到末尾', () => {
    const moved = applyLocalMove(board, 'c', { status: 'done', beforeId: null, afterId: null })
    expect(moved.at(-1)).toMatchObject({ id: 'c', status: 'done' })
  })

  it('邻居消失时不丢卡片', () => {
    const moved = applyLocalMove(board, 'a', { status: 'doing', beforeId: 'gone', afterId: null })
    expect(moved.some((entry) => entry.id === 'a')).toBe(true)
  })

  it('找不到卡片时原样返回', () => {
    expect(applyLocalMove(board, 'nope', { status: 'done', beforeId: null, afterId: null })).toEqual(board)
  })
})

describe('upsertPlanItem', () => {
  it('已存在则替换，不改变位置', () => {
    const next = upsertPlanItem(board, { ...board[1]!, title: '改名' })
    expect(next.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(next[1]!.title).toBe('改名')
  })

  it('新条目追加到末尾', () => {
    const next = upsertPlanItem(board, item('z', 'todo'))
    expect(next.at(-1)!.id).toBe('z')
  })

  it('非对象输入（SSE ready 帧缺 item 的 undefined）原样丢弃，不污染数组', () => {
    // 回归（2026-11-05）：undefined 曾被追加进数组，看板渲染即崩
    // （Cannot read properties of undefined (reading 'status')）。
    expect(upsertPlanItem([], undefined as unknown as Parameters<typeof upsertPlanItem>[1])).toEqual([])
    expect(upsertPlanItem(board, undefined as unknown as Parameters<typeof upsertPlanItem>[1])).toEqual(board)
  })
})

describe('展示辅助', () => {
  it('截止判断留一天缓冲（当天不算过期）', () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z')
    expect(isPlanOverdue('2026-11-03T09:00:00.000Z', now)).toBe(false)
    expect(isPlanOverdue('2026-11-01T09:00:00.000Z', now)).toBe(true)
    expect(isPlanOverdue(null, now)).toBe(false)
  })
})
