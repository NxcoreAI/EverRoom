import type { AgentSession } from '@nxcore/agent-contract'
import { Check, ChevronDown, History, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'

export function AgentSessionSwitcher({
  activeRunId,
  connected,
  displayTitle,
  sessionId,
  sessions,
  onCreate,
  onDelete,
  onRename,
  onSelect,
}: {
  activeRunId: string | null
  connected: boolean
  displayTitle: string
  sessionId: string | null
  sessions: AgentSession[]
  onCreate: () => Promise<AgentSession>
  onDelete: (session: AgentSession) => Promise<void>
  onRename: (sessionId: string, title: string) => Promise<void>
  onSelect: (session: AgentSession) => Promise<void>
}) {
  const { locale, t } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const navigationRef = useRef<HTMLDivElement>(null)

  const reportError = (title: string, error: unknown) => showToast({
    title,
    message: error instanceof Error ? error.message : t('surface:agentSessionSwitcher.tryAgainLater'),
  })

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      if (!navigationRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const create = () => {
    void onCreate().then(() => setMenuOpen(false)).catch((error) => reportError(t('surface:agentSessionSwitcher.couldNotCreateConversation'), error))
  }

  const saveTitle = (id: string) => {
    if (!editingTitle.trim()) return
    void onRename(id, editingTitle)
      .then(() => setEditingSessionId(null))
      .catch((error) => reportError(t('surface:agentSessionSwitcher.couldNotRenameConversation'), error))
  }

  return (
    <div ref={navigationRef} className="agent-session-nav">
      <button
        type="button"
        className="agent-session-trigger"
        aria-label={t('surface:agentSessionSwitcher.chooseConversation')}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <History aria-hidden="true" />
        <span>
          <small>{t(connected ? 'surface:agentSessionSwitcher.connected' : 'surface:agentSessionSwitcher.localConversation')}</small>
          <strong>{displayTitle || '\u00a0'}</strong>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      <div
        className="agent-session-menu"
        data-open={String(menuOpen)}
        aria-hidden={!menuOpen}
        {...(!menuOpen ? { inert: '' } : {})}
      >
          <div className="agent-session-menu-header">
            <strong>{t('surface:agentSessionSwitcher.conversations')}</strong>
            <button type="button" title={t('surface:agentSessionSwitcher.newConversation')} aria-label={t('surface:agentSessionSwitcher.newConversation')} disabled={Boolean(activeRunId)} onClick={create}>
              <Plus aria-hidden="true" />
            </button>
          </div>
          <div className="agent-session-list">
            {sessions.length === 0 ? <span className="agent-session-empty">{t('surface:agentSessionSwitcher.noConversations')}</span> : null}
            {sessions.map((session) => {
              const isRunning = session.status === 'running' || (session.id === sessionId && Boolean(activeRunId))
              return (
                <div key={session.id} className="agent-session-row" data-active={String(session.id === sessionId)}>
                  {editingSessionId === session.id ? (
                    <input
                      autoFocus
                      aria-label={t('surface:agentSessionSwitcher.conversationName')}
                      value={editingTitle}
                      maxLength={120}
                      onChange={(event) => setEditingTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveTitle(session.id)
                        if (event.key === 'Escape') setEditingSessionId(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="agent-session-select"
                      disabled={Boolean(activeRunId) && session.id !== sessionId}
                      onClick={() => {
                        if (session.id !== sessionId) {
                          void onSelect(session).catch((error) => reportError(t('surface:agentSessionSwitcher.couldNotSwitchConversations'), error))
                        }
                        setMenuOpen(false)
                      }}
                    >
                      <strong>{session.title || t('surface:agentSessionSwitcher.newConversationTitle')}</strong>
                      <small>{new Date(session.updatedAt).toLocaleString(locale, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}</small>
                    </button>
                  )}
                  <div className="agent-session-row-actions">
                    {editingSessionId === session.id ? (
                      <>
                        <button type="button" title={t('surface:agentSessionSwitcher.save')} aria-label={t('surface:agentSessionSwitcher.save')} disabled={!editingTitle.trim()} onClick={() => saveTitle(session.id)}><Check /></button>
                        <button type="button" title={t('surface:agentSessionSwitcher.cancel')} aria-label={t('surface:agentSessionSwitcher.cancel')} onClick={() => setEditingSessionId(null)}><X /></button>
                      </>
                    ) : (
                      <>
                        <button type="button" title={t('surface:agentSessionSwitcher.rename')} aria-label={t('surface:agentSessionSwitcher.rename')} onClick={() => {
                          setEditingSessionId(session.id)
                          setEditingTitle(session.title || t('surface:agentSessionSwitcher.newConversationTitle'))
                        }}><Pencil /></button>
                        <button
                          type="button"
                          title={t(isRunning ? 'surface:agentSessionSwitcher.aRunningConversationCannotBeDeleted' : 'surface:agentSessionSwitcher.delete')}
                          aria-label={t('surface:agentSessionSwitcher.delete')}
                          disabled={isRunning}
                          onClick={() => void onDelete(session)
                            .then(() => setMenuOpen(false))
                            .catch((error) => reportError(t('surface:agentSessionSwitcher.couldNotDeleteConversation'), error))}
                        ><Trash2 /></button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
      </div>
    </div>
  )
}
