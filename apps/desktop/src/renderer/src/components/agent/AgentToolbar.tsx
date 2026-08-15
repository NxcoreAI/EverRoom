import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'

export type AgentView = 'chat' | 'context' | 'activity'

export function AgentToolbar({
  children,
  onCreateConversation,
}: {
  children: ReactNode
  onCreateConversation: () => void
}) {
  return (
    <header className="agent-chat-toolbar">
      {children}
      <div className="agent-chat-toolbar-actions">
        <button type="button" className="agent-icon-button" title="新建对话" aria-label="新建对话" onClick={onCreateConversation}>
          <Plus aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
