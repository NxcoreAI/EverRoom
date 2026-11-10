import React, { useState } from 'react'
import { Bot, RotateCcw, FileDiff, User } from 'lucide-react'

import { type HistoryEntry, type OfficeFile, defaultHistory, fileHistory } from './data'

/**
 * 历史记录面板：统一时间线（新 → 旧），人 / Agent / 系统混合；参与者筛选。
 * 版本类条目「恢复此版本」可点（confirm → toast，mock）；Agent 操作可「查看改动」（toast）。
 */

type Filter = 'all' | 'user' | 'agent'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '我的修改' },
  { key: 'agent', label: 'Agent' },
]

function ActorBadge({ actor }: { actor: HistoryEntry['actor'] }) {
  if (actor === 'agent')
    return (
      <span className="op-hist-actor agent">
        <Bot size={11} /> Agent
      </span>
    )
  if (actor === 'user')
    return (
      <span className="op-hist-actor user">
        <User size={11} /> 王小雨
      </span>
    )
  return <span className="op-hist-actor system">系统</span>
}

export function HistoryPanel({ file, onToast }: { file: OfficeFile; onToast: (msg: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const entries = (fileHistory[file.id] ?? defaultHistory).filter((e) => filter === 'all' || e.actor === filter)

  const restore = (entry: HistoryEntry) => {
    const ok = window.confirm(`恢复到此版本？\n\n${entry.title}${entry.detail ? `\n${entry.detail}` : ''}\n\n恢复后会生成一个新版本，当前内容不会丢失。`)
    if (!ok) return
    onToast(`已恢复到「${entry.title}」（演示）`)
  }

  return (
    <div className="op-hist">
      <div className="op-hist-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'active' : ''}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="op-hist-list">
        {entries.length === 0 && <div className="op-empty">该筛选下没有记录</div>}
        {entries.map((e) => (
          <div key={e.id} className="op-hist-entry">
            <span className={`op-hist-dot ${e.actor}`} />
            <div className="op-hist-body">
              <div className="op-hist-head">
                <ActorBadge actor={e.actor} />
                <span className="op-hist-title">{e.title}</span>
              </div>
              {e.detail && <div className="op-hist-detail">{e.detail}</div>}
              {(e.restorable || e.diffable) && (
                <div className="op-hist-actions">
                  {e.diffable && (
                    <button type="button" onClick={() => onToast(`「${e.title}」的改动预览将在下一阶段接入`)}>
                      <FileDiff size={12} /> 查看改动
                    </button>
                  )}
                  {e.restorable && (
                    <button type="button" className="restore" onClick={() => restore(e)}>
                      <RotateCcw size={12} /> 恢复此版本
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
