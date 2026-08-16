import type { ReactNode } from 'react'

export type AgentView = 'chat' | 'context' | 'activity'

export function AgentToolbar({
  children,
}: {
  children: ReactNode
}) {
  return (
    <header className="agent-chat-toolbar">
      {children}
    </header>
  )
}
