import { Brain, ChevronRight } from 'lucide-react'

import { PageHeader } from './PageHeader'

const MEMORIES = [
  ['开源版首发平台只支持 macOS', '已确认', '来自产品 PRD · 2 个证据'],
  ['连接器优先于虚拟机能力', '已确认', '来自产品讨论 · 1 个证据'],
  ['用户偏好中性黑白灰界面', '待确认', '来自当前会话 · 1 个证据'],
] as const

export function MemoryPage() {
  return (
    <div className="page">
      <PageHeader title="记忆" description="查看 AI 记住了什么，并决定哪些内容可以继续使用。" />
      <div className="memory-layout">
        <aside className="memory-filters">
          <button type="button" data-active="true">全部记忆 <span>128</span></button>
          <button type="button">已确认 <span>96</span></button>
          <button type="button">待确认 <span>24</span></button>
          <button type="button">冲突 <span>8</span></button>
        </aside>
        <section className="memory-feed">
          {MEMORIES.map(([title, status, source]) => (
            <article key={title} className="memory-row">
              <span className="memory-symbol"><Brain aria-hidden="true" strokeWidth={1.8} /></span>
              <div><strong>{title}</strong><small>{source}</small></div>
              <span className="memory-status">{status}</span>
              <ChevronRight aria-hidden="true" strokeWidth={1.8} />
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}
