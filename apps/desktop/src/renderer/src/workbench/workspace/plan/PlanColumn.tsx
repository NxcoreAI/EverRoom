import { Plus } from 'lucide-react'
import { useState } from 'react'

import type { PlanItem, PlanStatus } from '@nxcore/agent-contract'

import { IconButton, TextInput } from '../../ui/primitives'
import { PlanCard } from './PlanCard'

export interface PlanColumnProps {
  status: PlanStatus
  label: string
  items: PlanItem[]
  dragId: string | null
  sessionTitles: Map<string, string>
  blockedTitles: Map<string, string[]>
  selectMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropAt: (index: number) => void
  onCreate: (title: string) => void
  onOpenCard: (id: string) => void
}

/**
 * 一列（= 一个状态）。
 *
 * 拖放的落点判定：卡片上半 = 插到它前面，下半 = 插到它后面；列空白处 = 列尾。
 * 落点下标是"排除被拖卡片后"的插入位置，交给 `resolveDrop` 换算成前后邻居 id。
 */
export function PlanColumn({
  status,
  label,
  items,
  dragId,
  sessionTitles,
  blockedTitles,
  selectMode,
  selectedIds,
  onToggleSelect,
  onDragStart,
  onDragEnd,
  onDropAt,
  onCreate,
  onOpenCard,
}: PlanColumnProps) {
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    const title = draft.trim()
    setDraft('')
    setComposing(false)
    if (title) onCreate(title)
  }

  return (
    <section
      className={`wb-plan-col wb-plan-col--task is-${status} ${insertAt !== null ? 'is-drop-target' : ''}`}
      onDragOver={(event) => {
        if (!dragId) return
        event.preventDefault()
        setInsertAt(items.length)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setInsertAt(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        const index = insertAt ?? items.length
        setInsertAt(null)
        onDropAt(index)
      }}
      aria-label={`${label}列，${items.length} 条`}
    >
      <header className="wb-plan-col-head">
        <span className={`wb-status-dot is-${status}`} aria-hidden="true" />
        <strong>{label}</strong>
        <span className="wb-plan-col-count">{items.length}</span>
        <IconButton
          label={`在「${label}」新建任务`}
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setComposing(true)}
        />
      </header>

      <div className="wb-plan-col-body">
        {composing ? (
          <div className="wb-plan-compose">
            <TextInput
              autoFocus
              value={draft}
              placeholder="任务标题，回车创建"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
                if (event.key === 'Escape') {
                  setDraft('')
                  setComposing(false)
                }
              }}
              onBlur={commit}
            />
          </div>
        ) : null}

        {items.map((item, index) => (
          <div
            key={item.id}
            className="wb-plan-slot"
            onDragOver={(event) => {
              if (!dragId) return
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              const after = event.clientY - rect.top > rect.height / 2
              // 被拖的卡片在本地数组里已占一个位置：跨列或同列都要按"排除自己"的下标算。
              const base = index
              setInsertAt(after ? base + 1 : base)
            }}
          >
            {insertAt === index ? <div className="wb-plan-insert" aria-hidden="true" /> : null}
            <PlanCard
              item={item}
              sessionTitle={item.assigneeSessionId ? sessionTitles.get(item.assigneeSessionId) ?? null : null}
              blockedTitles={blockedTitles.get(item.id) ?? []}
              dragging={dragId === item.id}
              selectMode={selectMode}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => onToggleSelect(item.id)}
              onOpen={() => onOpenCard(item.id)}
              onDragStart={() => onDragStart(item.id)}
              onDragEnd={() => {
                setInsertAt(null)
                onDragEnd()
              }}
            />
          </div>
        ))}

        {insertAt === items.length ? <div className="wb-plan-insert" aria-hidden="true" /> : null}

        {!items.length && !composing ? (
          <button type="button" className="wb-plan-empty" onClick={() => setComposing(true)}>
            <span className="wb-plan-empty-action">新建任务</span>
          </button>
        ) : null}
      </div>
    </section>
  )
}
