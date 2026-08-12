import { Activity, ArrowUp, Bot, Circle, Paperclip, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'

type AgentTab = 'chat' | 'context' | 'activity'

const tabs: Array<{ id: AgentTab; label: string }> = [
  { id: 'chat', label: 'Agent' },
  { id: 'context', label: '上下文' },
  { id: 'activity', label: '活动' },
]

export function AgentPanel({ pageLabel }: { pageLabel: string }) {
  const [activeTab, setActiveTab] = useState<AgentTab>('chat')

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div className="agent-title">
          <span className="agent-avatar">
            <Sparkles aria-hidden="true" />
          </span>
          <span>
            <strong>Nex</strong>
            <small>当前：{pageLabel}</small>
          </span>
        </div>
        <span className="local-badge">
          <ShieldCheck aria-hidden="true" />
          本地
        </span>
      </header>

      <div className="agent-tabs" role="tablist" aria-label="Agent 工作区">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-active={String(tab.id === activeTab)}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="agent-content">
        {activeTab === 'chat' ? (
          <div className="agent-empty">
            <span className="agent-empty-icon">
              <Bot aria-hidden="true" />
            </span>
            <strong>从当前上下文开始</strong>
            <p>选择 Room、来源或文档后，Nex 会在授权范围内协助你。</p>
            <div className="agent-suggestions">
              <button type="button">整理当前项目进展</button>
              <button type="button">从已有来源生成文档</button>
              <button type="button">查看待确认的记忆</button>
            </div>
          </div>
        ) : null}

        {activeTab === 'context' ? (
          <div className="context-list">
            <div className="panel-section-title">本轮上下文</div>
            <div className="context-row">
              <span className="context-icon">R</span>
              <span>
                <strong>{pageLabel}</strong>
                <small>当前工作区</small>
              </span>
            </div>
            <div className="context-row muted-row">
              <span className="context-icon">0</span>
              <span>
                <strong>尚未选择来源</strong>
                <small>Agent 不会读取其他内容</small>
              </span>
            </div>
          </div>
        ) : null}

        {activeTab === 'activity' ? (
          <div className="activity-list">
            <div className="panel-section-title">最近活动</div>
            <div className="activity-row">
              <Activity aria-hidden="true" />
              <span>
                <strong>工作区已就绪</strong>
                <small>刚刚</small>
              </span>
            </div>
            <div className="activity-row muted-row">
              <Circle aria-hidden="true" />
              <span>
                <strong>暂无运行中的任务</strong>
                <small>Agent 操作会显示在这里</small>
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <footer className="agent-composer">
        <div className="composer-scope">使用当前页面上下文</div>
        <div className="composer-box">
          <textarea aria-label="给 Nex 发送消息" placeholder="告诉 Nex 你想完成什么..." rows={3} />
          <div className="composer-actions">
            <button type="button" className="icon-button" title="添加来源" aria-label="添加来源">
              <Paperclip aria-hidden="true" />
            </button>
            <button type="button" className="send-button" title="发送" aria-label="发送">
              <ArrowUp aria-hidden="true" />
            </button>
          </div>
        </div>
      </footer>
    </aside>
  )
}
