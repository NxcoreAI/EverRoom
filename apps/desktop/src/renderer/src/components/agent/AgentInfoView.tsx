import { Activity, Circle, FileText, LayoutPanelTop } from 'lucide-react'

import type { AgentView } from './AgentToolbar'

export function AgentInfoView({ pageLabel, view }: { pageLabel: string; view: Exclude<AgentView, 'chat'> }) {
  if (view === 'context') {
    return (
      <section className="agent-detail-view" aria-label="当前上下文">
        <div className="agent-detail-heading">本轮上下文</div>
        <div className="agent-detail-row">
          <span className="agent-detail-icon"><LayoutPanelTop aria-hidden="true" /></span>
          <span><strong>{pageLabel}</strong><small>当前工作区</small></span>
        </div>
        <div className="agent-detail-row is-muted">
          <span className="agent-detail-icon"><FileText aria-hidden="true" /></span>
          <span><strong>尚未选择来源</strong><small>Agent 不会读取其他内容</small></span>
        </div>
      </section>
    )
  }

  return (
    <section className="agent-detail-view" aria-label="最近活动">
      <div className="agent-detail-heading">最近活动</div>
      <div className="agent-detail-row">
        <span className="agent-detail-icon"><Activity aria-hidden="true" /></span>
        <span><strong>工作区已就绪</strong><small>刚刚</small></span>
      </div>
      <div className="agent-detail-row is-muted">
        <span className="agent-detail-icon"><Circle aria-hidden="true" /></span>
        <span><strong>暂无运行中的任务</strong><small>Agent 操作会显示在这里</small></span>
      </div>
    </section>
  )
}
