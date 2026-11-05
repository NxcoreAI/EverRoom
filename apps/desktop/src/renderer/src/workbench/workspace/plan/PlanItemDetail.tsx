import { Bot, ExternalLink, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { PlanChecklistItem, PlanClaimPackage, PlanItem, PlanItemEvent } from '@nxcore/agent-contract'
import { formatPlanClaimPackage } from '@nxcore/agent-contract'

import { workbenchApi } from '../../api'
import { relativeTimeLabel } from '../../types'
import { Badge, Button, Field, IconButton, Spinner, TextArea, TextInput } from '../../ui/primitives'

/** 详情抽屉里可编辑的字段（走 PATCH，不含状态迁移）。 */
export type PlanDetailPatch = Partial<Pick<
  PlanItem,
  'title' | 'detail' | 'acceptance' | 'constraints' | 'priority' | 'dueAt' | 'checklist' | 'refs' | 'resultSummary' | 'closeReason'
>>

export interface PlanItemDetailProps {
  item: PlanItem
  onClose: () => void
  onSave: (patch: PlanDetailPatch) => Promise<boolean>
  onAssign: () => void
  onRemove: () => void
  /** 已取消的任务恢复成待开始（走状态迁移，不是改字段）。 */
  onRestore: () => void
  onOpenSession: (sessionId: string) => void
  onToast: (message: string) => void
}

const STATUS_LABEL: Record<PlanItem['status'], string> = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  dropped: '已取消',
}

const PRIORITY_OPTIONS: Array<{ value: PlanItem['priority']; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '常规' },
  { value: 'high', label: '高' },
  { value: 'urgent', label: '紧急' },
]

function toDateInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 任务详情抽屉：人写意图的地方（背景/验收/约束/材料/检查项）+ 时间线 + 认领包预览。
 *
 * 设计取舍：字段各自失焦即保存（没有"保存按钮"），因为看板上的任务是边想边改的；
 * 检查项单独即时保存（勾选是最频繁的动作）。
 */
export function PlanItemDetail({
  item,
  onClose,
  onSave,
  onAssign,
  onRemove,
  onRestore,
  onOpenSession,
  onToast,
}: PlanItemDetailProps) {
  const [title, setTitle] = useState(item.title)
  const [detail, setDetail] = useState(item.detail ?? '')
  const [acceptance, setAcceptance] = useState(item.acceptance ?? '')
  const [constraints, setConstraints] = useState(item.constraints.join('、'))
  const [events, setEvents] = useState<PlanItemEvent[] | null>(null)
  const [claimPackage, setClaimPackage] = useState<PlanClaimPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [newCheckText, setNewCheckText] = useState('')

  useEffect(() => {
    setTitle(item.title)
    setDetail(item.detail ?? '')
    setAcceptance(item.acceptance ?? '')
    setConstraints(item.constraints.join('、'))
  }, [item.id, item.version, item.title, item.detail, item.acceptance, item.constraints])

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setClaimPackage(null)
    void workbenchApi.planItemEvents(item.id)
      .then((next) => { if (!cancelled) setEvents(next) })
      .catch(() => { if (!cancelled) setEvents([]) })
    void workbenchApi.planClaimPackage(item.id)
      .then((next) => { if (!cancelled) setClaimPackage(next) })
      .catch(() => { if (!cancelled) setClaimPackage(null) })
    return () => { cancelled = true }
  }, [item.id, item.version])

  const claimText = useMemo(
    () => (claimPackage ? formatPlanClaimPackage(claimPackage) : ''),
    [claimPackage],
  )

  const save = async (patch: PlanDetailPatch) => {
    setBusy(true)
    try {
      const ok = await onSave(patch)
      if (!ok) onToast('保存失败，已刷新为最新状态')
      return ok
    } finally {
      setBusy(false)
    }
  }

  const saveChecklist = (checklist: PlanChecklistItem[]) => save({ checklist })

  const toggleCheck = (id: string) => {
    saveChecklist(item.checklist.map((entry) => (entry.id === id ? { ...entry, done: !entry.done } : entry)))
  }

  return (
    <aside className="wb-plan-detail" aria-label="任务详情">
      <header className="wb-plan-detail-head">
        <div className="wb-plan-detail-heading">
          <span className={`wb-status-dot is-${item.status}`} aria-hidden="true" />
          <span className="wb-plan-detail-status">{STATUS_LABEL[item.status]}</span>
        </div>
        <IconButton label="关闭详情" size="sm" icon={<X size={15} />} onClick={onClose} />
      </header>

      <div className="wb-plan-detail-body">
        <TextInput
          className="wb-plan-detail-title"
          value={title}
          aria-label="任务标题"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const next = title.trim()
            if (next && next !== item.title) void save({ title: next })
            else setTitle(item.title)
          }}
        />

        <div className="wb-plan-detail-grid">
          <Field label="优先级">
            <select
              className="ui-input"
              value={item.priority}
              onChange={(event) => void save({ priority: event.target.value as PlanItem['priority'] })}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field label="截止">
            <TextInput
              type="date"
              value={toDateInput(item.dueAt)}
              onChange={(event) => {
                const value = event.target.value
                void save({ dueAt: value ? new Date(`${value}T18:00:00`).toISOString() : null })
              }}
            />
          </Field>
        </div>

        <Field label="背景与要求">
          <TextArea
            rows={4}
            value={detail}
            placeholder="为什么有这件事、上下文、注意事项…"
            onChange={(event) => setDetail(event.target.value)}
            onBlur={() => {
              if (detail.trim() !== (item.detail ?? '')) void save({ detail: detail.trim() || null })
            }}
          />
        </Field>

        <Field label="验收标准">
          <TextArea
            rows={3}
            value={acceptance}
            placeholder="例：三页 PPT，含一张成本对比表"
            onChange={(event) => setAcceptance(event.target.value)}
            onBlur={() => {
              if (acceptance.trim() !== (item.acceptance ?? '')) void save({ acceptance: acceptance.trim() || null })
            }}
          />
        </Field>

        <Field label="硬约束">
          <TextInput
            value={constraints}
            placeholder="例：只用 2025 年数据、不要超过 800 字"
            onChange={(event) => setConstraints(event.target.value)}
            onBlur={() => {
              const next = constraints.split(/[、,，]/).map((entry) => entry.trim()).filter(Boolean)
              const current = item.constraints.join('、')
              if (next.join('、') !== current) void save({ constraints: next })
            }}
          />
        </Field>

        {item.refs.length ? (
          <div className="wb-plan-detail-block">
            <div className="wb-plan-detail-block-head">材料（{item.refs.length}）</div>
            <ul className="wb-plan-refs">
              {item.refs.map((ref) => (
                <li key={`${ref.kind}:${ref.id}`}>
                  <Badge tone="neutral">{ref.kind}</Badge>
                  <span className="wb-plan-ref-title">{ref.title}</span>
                  <IconButton
                    label="移除引用"
                    size="sm"
                    icon={<X size={12} />}
                    onClick={() => void save({
                      refs: item.refs.filter((entry) => !(entry.kind === ref.kind && entry.id === ref.id)),
                    })}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="wb-plan-detail-block">
          <div className="wb-plan-detail-block-head">检查项（{item.checklist.filter((entry) => entry.done).length}/{item.checklist.length}）</div>
          <ul className="wb-plan-checks">
            {item.checklist.map((entry) => (
              <li key={entry.id}>
                <label>
                  <input type="checkbox" checked={entry.done} onChange={() => toggleCheck(entry.id)} />
                  <span className={entry.done ? 'is-done' : undefined}>{entry.text}</span>
                </label>
                <IconButton
                  label="删除检查项"
                  size="sm"
                  icon={<X size={12} />}
                  onClick={() => saveChecklist(item.checklist.filter((current) => current.id !== entry.id))}
                />
              </li>
            ))}
          </ul>
          <TextInput
            value={newCheckText}
            placeholder="加一条检查项，回车添加"
            onChange={(event) => setNewCheckText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const text = newCheckText.trim()
              if (!text) return
              setNewCheckText('')
              void saveChecklist([...item.checklist, { id: crypto.randomUUID(), text, done: false }])
            }}
          />
        </div>

        <div className="wb-plan-detail-actions">
          {item.status !== 'done' && item.status !== 'dropped' ? (
            <Button variant="primary" size="sm" icon={<Bot size={14} />} onClick={onAssign}>
              交给 Agent
            </Button>
          ) : null}
          {item.status === 'dropped' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw size={14} />}
              onClick={onRestore}
            >
              恢复
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onRemove}>取消任务</Button>
          )}
          {item.assigneeSessionId ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<ExternalLink size={14} />}
              onClick={() => onOpenSession(item.assigneeSessionId!)}
            >
              打开会话
            </Button>
          ) : null}
          {busy ? <Spinner /> : null}
        </div>

        <div className="wb-plan-detail-block">
          <div className="wb-plan-detail-block-head">时间线</div>
          {events === null ? (
            <p className="wb-plan-detail-muted">加载中…</p>
          ) : events.length === 0 ? (
            <p className="wb-plan-detail-muted">还没有记录。</p>
          ) : (
            <ol className="wb-plan-timeline">
              {[...events].reverse().map((event) => (
                <li key={event.id}>
                  <span className="wb-plan-timeline-kind">{event.kind}</span>
                  <span className="wb-plan-timeline-summary">{event.summary}</span>
                  <span className="wb-plan-timeline-time">{relativeTimeLabel(event.createdAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <details className="wb-plan-detail-block wb-plan-claim">
          <summary>认领包</summary>
          {claimText ? <pre>{claimText}</pre> : <p className="wb-plan-detail-muted">认领包不可用。</p>}
        </details>
      </div>
    </aside>
  )
}
