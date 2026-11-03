/** 顶栏：只保留「看谁的数据」三个开关 + 连接态 + 刷新。 */
import type { DebugSource } from '../../agent-debug/api'
import type { RangeMode } from '../../agent-debug/history'
import { isArchiveSource, sourceLabel, sourceTitle } from '../../agent-debug/sources'
import { formatRelative } from '../insight/format'
import { NO_PRICE_ID, PRICE_SPECS, type Currency } from '../insight/pricing'

import './header-bar.css'

export type ConnectionState = 'live' | 'error' | 'readonly' | 'pending'

const RANGE_OPTIONS: ReadonlyArray<{ id: RangeMode; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'live', label: '本次' },
  { id: 'archive', label: '历史' },
]

interface HeaderBarProps {
  sources: DebugSource[]
  sourceId: string | null
  source: DebugSource | null
  onSelectSource: (sourceId: string) => void
  range: RangeMode
  onRange: (range: RangeMode) => void
  priceId: string
  onPriceId: (priceId: string) => void
  currency: Currency
  onCurrency: (currency: Currency) => void
  connection: { state: ConnectionState; label: string; title: string }
  lastSyncedAt: number | null
  onRefresh: () => void
  warning: string | null
}

export function HeaderBar({
  sources,
  sourceId,
  source,
  onSelectSource,
  range,
  onRange,
  priceId,
  onPriceId,
  currency,
  onCurrency,
  connection,
  lastSyncedAt,
  onRefresh,
  warning,
}: HeaderBarProps) {
  return (
    <header className="db-header">
      <div className="db-brand">
        <span className="db-brand-title">Agent 链路剖析</span>
        <span className="db-brand-sub">Tracing & Profiling</span>
      </div>

      <div className="db-header-controls">
        <label className="db-control" title={source ? sourceTitle(source) : '选择数据来源'}>
          <span className="db-control-label">来源</span>
          <select
            className="db-select"
            value={sourceId ?? ''}
            onChange={(event) => onSelectSource(event.target.value)}
            aria-label="数据来源"
          >
            {sources.length === 0 && <option value="">未发现</option>}
            {sources.map((item) => (
              <option key={item.id} value={item.id}>{sourceLabel(item)}</option>
            ))}
          </select>
        </label>

        <div className="db-segmented" role="group" aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === range ? 'db-segment is-on' : 'db-segment'}
              onClick={() => onRange(option.id)}
              title={option.id === 'all' ? '本次进程 + 磁盘归档' : option.id === 'live' ? '只看本次 Gateway 进程的 run' : '只看磁盘归档里的历史 run'}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="db-control" title="埋点不含模型名：成本按所选模型的公开单价估算">
          <span className="db-control-label">计价</span>
          <select
            className="db-select"
            value={priceId}
            onChange={(event) => onPriceId(event.target.value)}
            aria-label="计价模型"
          >
            {PRICE_SPECS.map((spec) => (
              <option key={spec.id} value={spec.id}>{spec.label}</option>
            ))}
            <option value={NO_PRICE_ID}>不估算</option>
          </select>
        </label>

        <div className="db-segmented" role="group" aria-label="币种">
          {(['USD', 'CNY'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={option === currency ? 'db-segment is-on' : 'db-segment'}
              onClick={() => onCurrency(option)}
            >
              {option === 'USD' ? '$' : '¥'}
            </button>
          ))}
        </div>

        <div className="db-conn" title={connection.title}>
          <span className="db-dot" data-state={connection.state} />
          <span className="db-conn-label">{connection.label}</span>
          {isArchiveSource(source) && <span className="db-conn-tag">只读</span>}
        </div>

        <button type="button" className="db-refresh" onClick={onRefresh} title="立即刷新快照">
          <span aria-hidden="true">↻</span>
          <span className="db-refresh-text num">{lastSyncedAt ? formatRelative(new Date(lastSyncedAt).toISOString()) : '—'}</span>
        </button>
      </div>

      {warning && <span className="db-warning" title={warning}>来源提示</span>}
    </header>
  )
}
