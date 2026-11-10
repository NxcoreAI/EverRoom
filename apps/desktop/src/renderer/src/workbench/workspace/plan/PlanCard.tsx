import { AlertCircle, CalendarDays, CheckSquare, Paperclip } from 'lucide-react'

import type { PlanItem } from '@nxcore/agent-contract'

import { relativeTimeLabel } from '../../types'
import { Badge } from '../../ui/primitives'
import { isPlanOverdue } from './planDrag'

const PRIORITY_LABEL: Record<PlanItem['priority'], string> = {
  low: '低',
  normal: '常规',
  high: '高',
  urgent: '紧急',
}

export interface PlanCardProps {
  item: PlanItem
  /** 关联会话标题（有 assigneeSessionId 时）。 */
  sessionTitle?: string | null
  blockedTitles?: string[]
  dragging: boolean
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
}

/**
 * 看板卡片：一行标题 + 一行 meta + 关联会话。
 *
 * meta 里只放"扫一眼就要知道"的东西：截止、材料数、检查项进度、高优先级。
 * 不区分任务是谁的（用户/Agent 共用同一个待办池），其余信息在详情抽屉里。
 */
export function PlanCard({
  item,
  sessionTitle,
  blockedTitles,
  dragging,
  selectMode,
  selected,
  onToggleSelect,
  onOpen,
  onDragStart,
  onDragEnd,
}: PlanCardProps) {
  const checklistDone = item.checklist.filter((entry) => entry.done).length
  const overdue = isPlanOverdue(item.dueAt) && item.status !== 'done' && item.status !== 'dropped'
  const blocked = (blockedTitles?.length ?? 0) > 0

  return (
    <article
      className={[
        'wb-plan-card',
        'wb-plan-task',
        `is-${item.status}`,
        `is-priority-${item.priority}`,
        dragging ? 'is-dragging' : '',
        selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      draggable={!selectMode}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-plan-item', item.id)
        event.dataTransfer.setData('text/plain', item.title)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      aria-label={item.title}
    >
      <header className="wb-plan-task-head">
        {selectMode ? (
          <input
            type="checkbox"
            className="wb-plan-select"
            checked={selected}
            aria-label={`选择「${item.title}」`}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggleSelect}
          />
        ) : (
          <span className={`wb-plan-priority is-${item.priority}`} aria-hidden="true" />
        )}
        <span className="wb-plan-card-title">{item.title}</span>
      </header>

      <div className="wb-plan-task-meta">
        {item.dueAt ? (
          <span className={`wb-plan-task-chip ${overdue ? 'is-overdue' : ''}`}>
            <CalendarDays size={11} aria-hidden="true" />
            {formatDueLabel(item.dueAt)}
          </span>
        ) : null}
        {item.refs.length ? (
          <span className="wb-plan-task-chip">
            <Paperclip size={11} aria-hidden="true" />
            {item.refs.length}
          </span>
        ) : null}
        {item.checklist.length ? (
          <span className="wb-plan-task-chip">
            <CheckSquare size={11} aria-hidden="true" />
            {checklistDone}/{item.checklist.length}
          </span>
        ) : null}
        {item.priority === 'urgent' || item.priority === 'high' ? (
          <Badge tone={item.priority === 'urgent' ? 'danger' : 'warning'}>
            {PRIORITY_LABEL[item.priority]}
          </Badge>
        ) : null}
      </div>

      {blocked ? (
        <div className="wb-plan-task-blocked">
          <AlertCircle size={12} aria-hidden="true" />
          等待 {blockedTitles!.slice(0, 2).join('、')}
        </div>
      ) : null}

      {item.assigneeSessionId ? (
        <footer className="wb-plan-task-foot">
          <span className="wb-plan-task-session">
            会话「{sessionTitle ?? '新工作'}」
          </span>
          <span>{relativeTimeLabel(item.updatedAt)}</span>
        </footer>
      ) : null}
    </article>
  )
}

function formatDueLabel(dueAt: string): string {
  const date = new Date(dueAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
}
