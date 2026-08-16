import { ChevronLeft, ChevronRight, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import type { MemoryAtomicItemDto, MemoryAtomicType } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, useAsyncData } from './useMemoryData'

const PAGE_SIZE = 50

const TYPE_FILTERS: Array<{ value: MemoryAtomicType | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'episodic', label: '情景' },
  { value: 'persona', label: '人格' },
  { value: 'instruction', label: '指令' },
]

const TYPE_LABELS: Record<string, string> = {
  episodic: '情景',
  persona: '人格',
  instruction: '指令',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function AtomicDetail({ item, onSaved, onDeleted }: {
  item: MemoryAtomicItemDto
  onSaved: () => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.content)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.updateAtomic(item.id, content, item.background ?? undefined)
      setEditing(false)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteAtomic([item.id])
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败。')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mem-atomic-detail">
      <div className="mem-atomic-detail-meta">
        <span className="mem-type-badge" data-type={item.type}>{typeLabel(item.type)}</span>
        {item.background ? <span className="mem-source">来源场景：{item.background}</span> : null}
        <span className="mem-time">创建 {formatDate(item.createdAt)} · 更新 {formatDate(item.updatedAt)}</span>
        <span className="mem-atomic-detail-actions">
          {editing ? null : (
            <button type="button" onClick={() => { setDraft(item.content); setEditing(true) }}>
              <Pencil aria-hidden="true" strokeWidth={1.7} />编辑
            </button>
          )}
          {confirming ? (
            <>
              <button type="button" className="mem-danger" disabled={busy} onClick={remove}>确认删除</button>
              <button type="button" onClick={() => setConfirming(false)}>取消</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={editing}>
              <Trash2 aria-hidden="true" strokeWidth={1.7} />删除
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <div className="mem-atomic-editor">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} maxLength={8192} />
          <div className="mem-atomic-editor-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>保存</button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>取消</button>
          </div>
        </div>
      ) : (
        <p className="mem-atomic-content">{item.content}</p>
      )}
      {error ? <p className="mem-inline-error">{error}</p> : null}
    </div>
  )
}

export function AtomicMemoryPane() {
  const [type, setType] = useState<MemoryAtomicType | 'all'>('all')
  const [offset, setOffset] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const listOptions = {
    ...(type === 'all' ? {} : { type }),
    limit: PAGE_SIZE,
    offset,
  }
  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listAtomic(listOptions),
    [type, offset, reloadTick],
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pageStart = offset + 1
  const pageEnd = offset + items.length

  if (failure && !data) {
    return <div className="mem-pane-error">{failure.message}</div>
  }

  return (
    <div className="mem-atomic">
      <div className="mem-toolbar">
        <div className="mem-type-filters" role="tablist" aria-label="记忆类型">
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              data-active={type === filter.value}
              onClick={() => { setType(filter.value); setOffset(0); setExpandedId(null) }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="mem-count">共 {total} 条</span>
        <div className="mem-pager">
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.8} />
          </button>
          <span>{loading ? '…' : total === 0 ? '0' : `${pageStart}–${pageEnd} / ${total}`}</span>
          <button type="button" disabled={pageEnd >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {!loading && items.length === 0 ? (
        <MemoryEmptyView
          title="暂无原子记忆"
          hint={type === 'all' ? '与 AI 助手多轮对话后，MemoryCore 会自动提炼原子记忆。' : '该类型下暂无记忆。'}
        />
      ) : (
        <ul className="mem-atomic-list">
          {items.map((item) => (
            <li key={item.id} className="mem-atomic-item">
              <button
                type="button"
                className="mem-atomic-summary"
                data-expanded={expandedId === item.id}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <span className="mem-type-badge" data-type={item.type}>{typeLabel(item.type)}</span>
                <span className="mem-atomic-text">{item.content}</span>
                <span className="mem-time">{formatDate(item.updatedAt)}</span>
              </button>
              {expandedId === item.id ? (
                <AtomicDetail
                  item={item}
                  onSaved={() => setReloadTick((tick) => tick + 1)}
                  onDeleted={() => { setExpandedId(null); setReloadTick((tick) => tick + 1) }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
