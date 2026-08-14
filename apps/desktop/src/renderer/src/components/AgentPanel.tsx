import { useEffect, useRef, useState } from 'react'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentInfoView } from '@/components/agent/AgentInfoView'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar, type AgentView } from '@/components/agent/AgentToolbar'
import { useAgentSession } from '@/components/agent/useAgentSession'

import './agent/AgentPanel.css'
import './agent/AgentChat.css'

export function AgentPanel({
  pageLabel,
  focusRequest = 0,
}: {
  pageLabel: string
  focusRequest?: number
}) {
  const [activeView, setActiveView] = useState<AgentView>('chat')
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const contextSummary = `${pageLabel} · 未选择文本`
  const session = useAgentSession(pageLabel)

  const focusComposer = () => {
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  useEffect(() => {
    if (!focusRequest) return
    setActiveView('chat')
    focusComposer()
  }, [focusRequest])

  const sendPrompt = (prompt: string) => {
    if (!prompt.trim()) return
    setDraft('')
    void session.sendPrompt(prompt)
  }

  return (
    <aside className="agent-panel">
      <AgentToolbar
        activeView={activeView}
        sessionTitle={session.currentSession?.title}
        onCreateConversation={() => {
          setActiveView('chat')
          setDraft('')
          void session.createSession().catch(() => undefined)
          focusComposer()
        }}
        onViewChange={setActiveView}
      />

      <AgentSessionSwitcher
        activeRunId={session.activeRunId}
        connected={session.connected}
        currentSession={session.currentSession}
        sessionId={session.sessionId}
        sessions={session.sessions}
        onCreate={session.createSession}
        onDelete={session.deleteSession}
        onRename={session.renameSession}
        onSelect={session.selectSession}
      />

      <button
        type="button"
        className="agent-context-summary"
        aria-label="查看工作区上下文"
        onClick={() => setActiveView('context')}
      >
        {contextSummary}
      </button>

      {activeView === 'chat' ? (
        <AgentChatView
          activeRunId={session.activeRunId}
          error={session.error}
          loading={session.loading}
          messages={session.messages}
          reasoning={session.reasoning}
          onSelectPrompt={sendPrompt}
        />
      ) : (
        <AgentInfoView
          activeRunId={session.activeRunId}
          connected={session.connected}
          messageCount={session.messages.length}
          pageLabel={pageLabel}
          view={activeView}
        />
      )}

      <AgentComposer
        ref={composerRef}
        contextSummary={contextSummary}
        value={draft}
        active={Boolean(session.activeRunId)}
        loading={session.loading}
        onChange={setDraft}
        onStop={() => void session.stop()}
        onSubmit={() => sendPrompt(draft)}
      />
    </aside>
  )
}
