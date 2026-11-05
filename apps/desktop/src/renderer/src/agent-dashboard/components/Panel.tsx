/**
 * 看板唯一的面板容器：**标题 + 一句结论 + 可选明细**。
 *
 * 分层的核心约定：
 * - 第一层（默认可见）只放「结论句 + 主图」，让用户 3 秒知道这块在说什么；
 * - 第二层（`collapsible`）把明细表、全量列表、口径说明收进「展开」，默认收起；
 * - `level=2` 用于卡片内部的次级区块：不加边框、浅底、更小的标题。
 */
import { useState, type ReactNode } from 'react'

import './panel.css'

export interface PanelProps {
  title: string
  /** 一句话结论（可以直接带数字），显示在标题下方。 */
  conclusion?: ReactNode
  /** 标题行右侧的补充信息（条数、口径等）。 */
  meta?: ReactNode
  /** 标题行右侧的操作（筛选、跳转等）。 */
  actions?: ReactNode
  /** 是否把 `children` 收进「展开明细」（默认收起）。 */
  collapsible?: boolean
  defaultOpen?: boolean
  /** 1 = 主卡片（白底描线）；2 = 卡片内次级区块（无边框浅底）。 */
  level?: 1 | 2
  /** 折叠区按钮文案（默认「展开明细」）。 */
  expandLabel?: string
  children?: ReactNode
}

export function Panel({
  title,
  conclusion,
  meta,
  actions,
  collapsible = false,
  defaultOpen = false,
  level = 1,
  expandLabel = '展开明细',
  children,
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = `panel-${title.replace(/\s+/g, '-')}`
  const showBody = !collapsible || open || children === undefined

  return (
    <section className={level === 1 ? 'panel' : 'panel panel-inner'}>
      <header className="panel-head">
        <div className="panel-head-main">
          <h2 className="panel-title">{title}</h2>
          {meta !== undefined && <span className="panel-meta">{meta}</span>}
        </div>
        <div className="panel-head-actions">
          {actions}
          {collapsible && (
            <button
              type="button"
              className="panel-toggle"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls={bodyId}
            >
              {open ? '收起' : expandLabel}
              <span className="panel-toggle-caret" data-open={open || undefined} aria-hidden="true">▾</span>
            </button>
          )}
        </div>
      </header>

      {conclusion !== undefined && <p className="panel-conclusion">{conclusion}</p>}

      {children !== undefined && showBody && (
        <div className="panel-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  )
}

/** 卡片内的「指标 + 数值」小格子（比裸 dl 更稳，不会被中文字数撑歪）。 */
export function Metric({ label, value, hint, tone }: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'error' | 'warn' | 'cost' | 'ok'
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value num" data-tone={tone}>{value}</span>
      {hint !== undefined && <span className="metric-hint">{hint}</span>}
    </div>
  )
}
