import { useEffect, useRef, useState } from 'react'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentInfoView } from '@/components/agent/AgentInfoView'
import { AgentToolbar, type AgentView } from '@/components/agent/AgentToolbar'

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

  const focusComposer = () => {
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  useEffect(() => {
    if (!focusRequest) return
    setActiveView('chat')
    focusComposer()
  }, [focusRequest])

  const selectPrompt = (prompt: string) => {
    setDraft(prompt)
    focusComposer()
  }

  return (
    <aside className="agent-panel">
      <AgentToolbar
        activeView={activeView}
        onCreateConversation={() => {
          setActiveView('chat')
          setDraft('')
          focusComposer()
        }}
        onViewChange={setActiveView}
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
        <AgentChatView onSelectPrompt={selectPrompt} />
      ) : (
        <AgentInfoView pageLabel={pageLabel} view={activeView} />
      )}

      <AgentComposer
        ref={composerRef}
        contextSummary={contextSummary}
        value={draft}
        onChange={setDraft}
      />
    </aside>
  )
}
