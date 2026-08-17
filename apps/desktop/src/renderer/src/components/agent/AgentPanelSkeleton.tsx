// Gateway 启动期间 Agent 服务不可用,整个面板(会话栏/对话/输入框)先用骨架屏占位。
import './AgentPanelSkeleton.css'

export function AgentPanelSkeleton() {
  return (
    <aside className="agent-panel" aria-busy="true" aria-label="Agent 服务启动中">
      <header className="agent-chat-toolbar">
        <div className="agent-skeleton-trigger">
          <span className="agent-skeleton-icon" />
          <span className="agent-skeleton-trigger-copy">
            <i className="agent-skeleton-line" />
            <i className="agent-skeleton-line" />
          </span>
        </div>
      </header>

      <div className="agent-skeleton-conversation">
        <div className="agent-skeleton-bubble">
          <i className="agent-skeleton-line" />
        </div>
        <div className="agent-skeleton-reply">
          <i className="agent-skeleton-line" />
          <i className="agent-skeleton-line" />
          <i className="agent-skeleton-line" />
        </div>
        <div className="agent-skeleton-bubble">
          <i className="agent-skeleton-line" />
        </div>
        <div className="agent-skeleton-reply">
          <i className="agent-skeleton-line" />
          <i className="agent-skeleton-line" />
        </div>
      </div>

      <div className="agent-skeleton-composer">
        <div className="agent-skeleton-composer-box">
          <i className="agent-skeleton-line" />
          <div className="agent-skeleton-composer-actions">
            <span className="agent-skeleton-circle" />
            <span className="agent-skeleton-circle" />
            <span className="agent-skeleton-circle accent" />
          </div>
        </div>
      </div>
    </aside>
  )
}
