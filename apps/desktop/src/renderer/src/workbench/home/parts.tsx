import { ArrowRight } from 'lucide-react'
import React from 'react'

import { cn } from '../ui/cn'

/**
 * 主页标签六个页面共用的小排版件：
 * 分节标题（含计数与「全部」入口）、骨架行、行内状态文案。
 * 页面骨架/间距全部由 home.css 提供，这里只出结构。
 */

export interface HomeSectionProps {
  title: React.ReactNode
  /** 标题后的真实计数（不传则不显示）。 */
  count?: number
  /** 右侧轻量入口文案（如「全部空间」）。 */
  actionLabel?: string
  onAction?: () => void
  actionIcon?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function HomeSection({
  title, count, actionLabel, onAction, actionIcon, children, className,
}: HomeSectionProps) {
  return (
    <section className={cn('wb-home-section', className)}>
      <header className="wb-home-section-head">
        <h2>{title}</h2>
        {typeof count === 'number' ? <span className="wb-home-section-count">{count}</span> : null}
        {actionLabel ? (
          <button type="button" className="wb-home-more" onClick={onAction}>
            {actionLabel}
            {actionIcon ?? <ArrowRight size={12} aria-hidden="true" />}
          </button>
        ) : null}
      </header>
      {children}
    </section>
  )
}

/** 文件/空间列表的骨架行（加载态，避免空白闪烁）。 */
export function HomeSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="wb-home-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="wb-home-skeleton-row">
          <span className="wb-home-skeleton-icon" />
          <span className="wb-home-skeleton-lines">
            <span className="wb-home-skeleton-line" style={{ width: `${64 - index * 8}%` }} />
            <span className="wb-home-skeleton-line is-short" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** 行内状态/空数据提示（图上无卡片，只占一行；可内嵌重试按钮）。 */
export function HomeNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('wb-home-note', className)}>{children}</div>
}

/** 新建项目空间的全局事件：弹窗由外壳（Workbench → CreateWorkspaceDialog）承载。 */
export const NEW_SPACE_EVENT = 'everroom:workbench-new-space'

export function requestNewSpace(): void {
  window.dispatchEvent(new CustomEvent(NEW_SPACE_EVENT))
}
