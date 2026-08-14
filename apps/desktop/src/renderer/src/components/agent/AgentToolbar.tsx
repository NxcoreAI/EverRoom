import { Activity, ListTree, MessageCircle, MessagesSquare, Plus } from 'lucide-react'
import { useState } from 'react'

export type AgentView = 'chat' | 'context' | 'activity'

const viewOptions: Array<{
  id: AgentView
  label: string
  icon: typeof MessageCircle
}> = [
  { id: 'chat', label: 'Agent', icon: MessageCircle },
  { id: 'context', label: '上下文', icon: ListTree },
  { id: 'activity', label: '活动', icon: Activity },
]

const viewTitles: Record<AgentView, string> = {
  chat: '新建 AI 对话',
  context: '当前上下文',
  activity: '最近活动',
}

export function AgentToolbar({
  activeView,
  sessionTitle,
  onCreateConversation,
  onViewChange,
}: {
  activeView: AgentView
  sessionTitle?: string | null
  onCreateConversation: () => void
  onViewChange: (view: AgentView) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="agent-chat-toolbar">
      <strong className="agent-session-heading">
        {activeView === 'chat' && sessionTitle ? sessionTitle : viewTitles[activeView]}
      </strong>
      <div className="agent-chat-toolbar-actions">
        <button
          type="button"
          className="agent-icon-button"
          aria-label="切换 Agent 视图"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MessagesSquare aria-hidden="true" />
        </button>
        <button
          type="button"
          className="agent-icon-button"
          aria-label="新建对话"
          onClick={() => {
            setMenuOpen(false)
            onCreateConversation()
          }}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div className="agent-view-menu" role="menu" aria-label="Agent 视图">
          {viewOptions.map((option) => {
            const Icon = option.icon
            return (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                data-active={String(option.id === activeView)}
                onClick={() => {
                  onViewChange(option.id)
                  setMenuOpen(false)
                }}
              >
                <Icon aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </header>
  )
}
