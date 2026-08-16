import { useEffect, useRef, useState } from 'react'

import { AgentChatView } from '@/components/agent/AgentChatView'
import { AgentComposer } from '@/components/agent/AgentComposer'
import { AgentSessionSwitcher } from '@/components/agent/AgentSessionSwitcher'
import { AgentToolbar } from '@/components/agent/AgentToolbar'
import { useAgentSession } from '@/components/agent/useAgentSession'
import { showToast } from '@/state/toast'

import './agent/AgentPanel.css'
import './agent/AgentChat.css'

export function AgentPanel({
  pageLabel,
  roomId,
  focusRequest = 0,
}: {
  pageLabel: string
  roomId: string | null
  focusRequest?: number
}) {
  const [draft, setDraft] = useState('')
  const [selectedText, setSelectedText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [composerResetKey, setComposerResetKey] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const previousSessionIdRef = useRef<string | null>(null)
  const selectedTextSummary = selectedText.replace(/\s+/g, ' ').trim()
  const contextSummary = selectedTextSummary
    ? `${pageLabel} · “${selectedTextSummary}”`
    : `${pageLabel} · 未选择文本`
  const session = useAgentSession(pageLabel, roomId)

  const focusComposer = () => {
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  useEffect(() => {
    if (!focusRequest) return
    focusComposer()
  }, [focusRequest])

  useEffect(() => {
    setSelectedText('')
    setComposerResetKey((current) => current + 1)
  }, [pageLabel])

  useEffect(() => {
    if (previousSessionIdRef.current === session.sessionId) return
    if (previousSessionIdRef.current !== null) {
      setDraft('')
      setSelectedText('')
      setComposerResetKey((current) => current + 1)
    }
    previousSessionIdRef.current = session.sessionId
  }, [session.sessionId])

  useEffect(() => {
    const readWorkspaceSelection = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      const anchor = selection.anchorNode
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      if (!anchorElement?.closest('.workspace-main')) return
      const text = selection.toString().trim()
      if (text) setSelectedText(text.slice(0, 8_000))
    }
    document.addEventListener('selectionchange', readWorkspaceSelection)
    return () => document.removeEventListener('selectionchange', readWorkspaceSelection)
  }, [])

  const sendPrompt = async (prompt: string) => {
    if (!prompt.trim()) return
    const submittedPrompt = prompt.trim()
    const submittedContext = selectedText
    setDraft('')
    setSubmitting(true)
    try {
      await session.sendPrompt(submittedPrompt, submittedContext)
      setSelectedText('')
      setComposerResetKey((current) => current + 1)
    } catch {
      setDraft(submittedPrompt)
    } finally {
      setSubmitting(false)
    }
  }

  const composer = (
    <AgentComposer
      ref={composerRef}
      contextSummary={contextSummary}
      hasSelectedText={Boolean(selectedText)}
      resetKey={composerResetKey}
      value={draft}
      active={Boolean(session.activeRunId)}
      loading={session.loading || submitting}
      onChange={setDraft}
      onClearContext={() => setSelectedText('')}
      onStop={() => void session.stop()}
      onSubmit={() => void sendPrompt(draft)}
    />
  )

  return (
    <aside className="agent-panel">
      <AgentToolbar
        onCreateConversation={() => {
          setDraft('')
          setSelectedText('')
          setComposerResetKey((current) => current + 1)
          void session.createSession().catch((error) => showToast({
            title: '新建会话失败',
            message: error instanceof Error ? error.message : '请稍后重试。',
          }))
          focusComposer()
        }}
      >
        <AgentSessionSwitcher
          activeRunId={session.activeRunId}
          connected={session.connected}
          currentSession={session.currentSession}
          sessionId={session.sessionId}
          sessions={session.sessions}
          onCreate={async () => {
            setDraft('')
            setSelectedText('')
            setComposerResetKey((current) => current + 1)
            return session.createSession()
          }}
          onDelete={session.deleteSession}
          onRename={session.renameSession}
          onSelect={async (selectedSession) => {
            setDraft('')
            setSelectedText('')
            setComposerResetKey((current) => current + 1)
            await session.selectSession(selectedSession)
          }}
        />
      </AgentToolbar>

      <AgentChatView
        activeRunId={session.activeRunId}
        composer={composer}
        draftHasContent={Boolean(draft.trim())}
        error={session.error}
        loading={session.loading}
        messages={session.messages}
        onRetryPrompt={(prompt) => void sendPrompt(prompt)}
        onSelectPrompt={(prompt) => {
          setDraft(prompt)
          focusComposer()
        }}
        reasoningByRun={session.reasoningByRun}
        runCompletedAtByRun={session.runCompletedAtByRun}
        runStartedAtByRun={session.runStartedAtByRun}
        submitting={submitting}
        toolCallsByRun={session.toolCallsByRun}
      />
    </aside>
  )
}
