import { Activity, Circle, FileText, LayoutPanelTop } from 'lucide-react'

import type { AgentView } from './AgentToolbar'

export function AgentInfoView({
  activeRunId,
  connected,
  messageCount,
  pageLabel,
  view,
}: {
  activeRunId: string | null
  connected: boolean
  messageCount: number
  pageLabel: string
  view: Exclude<AgentView, 'chat'>
}) {
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
        <span><strong>{activeRunId ? 'Agent 正在运行' : '工作区已就绪'}</strong><small>{messageCount} 条消息</small></span>
      </div>
      <div className="agent-detail-row is-muted">
        <span className="agent-detail-icon"><Circle aria-hidden="true" /></span>
        <span><strong>{connected ? 'Gateway 已连接' : '本地运行时'}</strong><small>{activeRunId ? '正在接收运行事件' : '等待下一项任务'}</small></span>
      </div>
    </section>
  )
}
