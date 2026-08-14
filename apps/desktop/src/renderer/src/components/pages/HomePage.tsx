import {
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  FileText,
  Mic2,
  Sparkles,
} from 'lucide-react'

import type { PageId } from '@/data/navigation'

import './HomePage.css'

const RECENT_ITEMS = ['NexOS PC 端发布方案', 'NexOS PC 端 V1 发布计划', '新页面'] as const

const TODAY_ITEMS = [
  '整理发布方案并确认写入',
  '回复张总报价确认邮件',
  '处理 7 条记忆候选',
] as const

const UPCOMING_ITEMS = [
  { time: '09:00', title: '晨会同步' },
  { time: '10:30', title: '原型 V2 评审会' },
  { time: '14:00', title: '客户跟进电话·张总' },
] as const

export function HomePage({
  onNavigate,
  onFocusAgent,
}: {
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
}) {
  return (
    <section className="workspace-home-surface" data-testid="workspace-home-surface">
      <div className="workspace-home-inner">
        <header className="workspace-home-heading">
          <h1>晚上好呀</h1>
          <p>继续今天的工作，或快速开始一项新任务。</p>
        </header>

        <div className="workspace-home-grid">
          <section className="workspace-home-panel">
            <h2>最近访问</h2>
            <div className="workspace-home-list">
              {RECENT_ITEMS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="workspace-home-list-item"
                  onClick={() => onNavigate('rooms')}
                >
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                  <span>{item}</span>
                  <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                </button>
              ))}
            </div>
          </section>

          <section className="workspace-home-panel">
            <h2>今日工作</h2>
            <div className="workspace-home-list">
              {TODAY_ITEMS.map((item) => (
                <button key={item} type="button" className="workspace-home-list-item is-muted" disabled>
                  <CheckCircle2 aria-hidden="true" strokeWidth={1.8} />
                  <span>{item}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="workspace-home-panel workspace-home-upcoming">
            <div className="workspace-home-panel-heading">
              <h2>活动预告</h2>
              <button type="button" onClick={() => onNavigate('tasks')}>打开日历</button>
            </div>
            <div className="workspace-upcoming-grid">
              {UPCOMING_ITEMS.map((item) => (
                <button
                  key={`${item.time}-${item.title}`}
                  type="button"
                  aria-label={`${item.time} ${item.title}`}
                  onClick={() => onNavigate('tasks')}
                >
                  <time>{item.time}</time>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="workspace-home-quick-start">
            <h2>快速开始</h2>
            <div className="workspace-quick-grid">
              <button type="button" className="workspace-quick-action" onClick={onFocusAgent}>
                <Sparkles aria-hidden="true" strokeWidth={1.8} data-tone="blue" />
                <span>万事问 AI</span>
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('docs')}>
                <Mic2 aria-hidden="true" strokeWidth={1.8} data-tone="violet" />
                <span>AI 速记</span>
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('rooms')}>
                <BookOpenText aria-hidden="true" strokeWidth={1.8} data-tone="emerald" />
                <span>Context Room</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
