import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { PlanStatus } from '@nxcore/agent-contract'

import { workbenchApi } from '../api'
import { sessionDisplayTitle } from '../types'
import { Button, Spinner, TextInput } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import { PlanBoard } from './plan/PlanBoard'
import { PlanItemDetail, type PlanDetailPatch } from './plan/PlanItemDetail'
import { resolveDrop } from './plan/planDrag'
import { usePlanItems } from './plan/usePlanItems'
import './plan/plan.css'

/**
 * 工作空间「计划」：任务的看板（用户与 Agent 的共同待办池）。
 *
 * 四列常显：没有任务时也渲染四个状态列（空列保留各自的「新建任务」入口），
 * 不用空态整页替换看板。任务不按负责人区分（卡片上也没有我/Agent 标签），
 * 会话降级为卡片上的执行入口；会话列表仍在侧栏「工作 N」里，这里不再重复。
 */
export function PlanPage({ workspace, sessions, onOpenSession, onNewWork, onToast }: WorkspacePageProps) {
  const plan = usePlanItems(workspace.id)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return plan.items
    return plan.items.filter((item) => item.title.toLowerCase().includes(keyword)
      || (item.detail ?? '').toLowerCase().includes(keyword)
      || item.tags.some((tag) => tag.toLowerCase().includes(keyword)))
  }, [plan.items, query])

  const groups = useMemo(() => {
    const buckets: Record<PlanStatus, typeof visible> = { todo: [], doing: [], done: [], dropped: [] }
    for (const item of visible) buckets[item.status].push(item)
    return buckets
  }, [visible])

  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) map.set(session.id, sessionDisplayTitle(session))
    return map
  }, [sessions])

  const blockedTitles = useMemo(() => {
    const byId = new Map(plan.items.map((item) => [item.id, item]))
    const map = new Map<string, string[]>()
    for (const item of plan.items) {
      if (!item.blockedBy.length) continue
      const titles: string[] = []
      for (const id of item.blockedBy) {
        const blocker = byId.get(id)
        if (blocker && blocker.status !== 'done') titles.push(blocker.title)
      }
      if (titles.length) map.set(item.id, titles)
    }
    return map
  }, [plan.items])

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runBatch = async (action: 'move' | 'drop', status?: PlanStatus) => {
    const ids = [...selectedIds]
    if (!ids.length) return
    try {
      const result = await workbenchApi.batchPlanItems(ids, action, status)
      setSelectedIds(new Set())
      setSelectMode(false)
      await plan.reload()
      const label = action === 'drop' ? '取消' : '移动'
      onToast(result.failed.length
        ? `已${label} ${result.items.length} 项，${result.failed.length} 项被占用未处理`
        : `已${label} ${result.items.length} 项`)
    } catch {
      onToast('批量操作失败，请重试')
    }
  }

  const selected = selectedId ? plan.items.find((item) => item.id === selectedId) ?? null : null

  const createTask = async (title: string, status: PlanStatus = 'todo') => {
    const created = await plan.createItem(title, status)
    if (!created) {
      onToast('新建任务失败')
      return
    }
    setSelectedId(created.id)
  }

  const commitDraft = async () => {
    const title = draftTitle.trim()
    setDraftTitle('')
    setComposing(false)
    if (title) await createTask(title)
  }

  const detailHandlers = selected ? {
    onClose: () => setSelectedId(null),
    onSave: async (patch: PlanDetailPatch) => (
      (await plan.updateItem(selected, patch)) !== null
    ),
    onAssign: async () => {
      const result = await plan.assignItem(selected)
      if (!result) {
        onToast('交给 Agent 失败（检查网关与 Agent 配置）')
        return
      }
      onToast('已交给 Agent，正在新会话里执行')
      onOpenSession(result.sessionId)
    },
    onRemove: async () => {
      if (await plan.removeItem(selected)) {
        onToast('已取消该任务')
        setSelectedId(null)
      } else {
        onToast('取消任务失败，请重试')
      }
    },
    onRestore: async () => {
      const todoCount = plan.items.filter((item) => item.status === 'todo').length
      const target = resolveDrop(plan.items, selected.id, 'todo', todoCount)
      if (await plan.moveItem(selected, target)) onToast('已恢复到「待开始」')
      else onToast('恢复失败，请重试')
    },
    onOpenSession,
    onToast,
  } : null

  return (
    <div className="wb-wspage wb-tools-page wb-plan-page">
      <header className="wb-plan-toolbar">
        <div className="wb-plan-toolbar-title">
          <h2>计划</h2>
        </div>
        <div className="wb-plan-toolbar-search">
          <Search size={14} aria-hidden="true" />
          <TextInput
            value={query}
            placeholder="搜索任务"
            aria-label="搜索任务"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="wb-plan-toolbar-actions">
          {plan.items.length ? (
            <Button
              variant={selectMode ? 'soft' : 'ghost'}
              size="sm"
              onClick={() => {
                setSelectMode((current) => !current)
                setSelectedIds(new Set())
              }}
            >
              {selectMode ? '退出多选' : '多选'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onNewWork}>新建工作</Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setComposing(true)}>
            新建任务
          </Button>
        </div>
      </header>

      {composing ? (
        <div className="wb-plan-compose-bar">
          <TextInput
            autoFocus
            value={draftTitle}
            placeholder="任务标题，回车创建"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitDraft()
              if (event.key === 'Escape') {
                setDraftTitle('')
                setComposing(false)
              }
            }}
            onBlur={() => void commitDraft()}
          />
        </div>
      ) : null}

      {plan.error && plan.state !== 'ready' ? (
        <div className="wb-tool-error" role="alert">
          {plan.state === 'unavailable'
            ? '当前网关版本不支持计划，升级后可在这里管理任务。'
            : `计划加载失败：${plan.error}`}
        </div>
      ) : null}

      {plan.state === 'loading' ? (
        <div className="wb-plan-loading"><Spinner /> 正在加载计划…</div>
      ) : (
        <PlanBoard
          groups={groups}
          sessionTitles={sessionTitles}
          blockedTitles={blockedTitles}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onDrop={async (dragId, column, index) => {
            const ok = await plan.dropItem(dragId, column, index)
            if (!ok) onToast('移动失败，卡片已恢复')
          }}
          onCreate={(title, status) => void createTask(title, status)}
          onOpenCard={setSelectedId}
        />
      )}

      {selectedIds.size ? (
        <div className="wb-plan-batch-bar" role="toolbar" aria-label="批量操作">
          <span className="wb-plan-batch-count">已选 {selectedIds.size} 项</span>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'todo')}>移到待开始</Button>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'doing')}>移到进行中</Button>
          <Button size="sm" variant="secondary" onClick={() => void runBatch('move', 'done')}>标记完成</Button>
          <Button size="sm" variant="ghost" onClick={() => void runBatch('drop')}>取消任务</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>清空</Button>
        </div>
      ) : null}

      <div className={selected ? 'wb-plan-detail-layer is-open' : 'wb-plan-detail-layer'}>
        {selected && detailHandlers ? (
          <PlanItemDetail item={selected} {...detailHandlers} />
        ) : null}
      </div>
    </div>
  )
}
