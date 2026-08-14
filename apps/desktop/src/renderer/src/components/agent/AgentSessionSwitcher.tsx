import type { AgentSession } from '@nxcore/agent-contract'
import { Check, ChevronDown, History, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'

export function AgentSessionSwitcher({
  activeRunId,
  connected,
  currentSession,
  sessionId,
  sessions,
  onCreate,
  onDelete,
  onRename,
  onSelect,
}: {
  activeRunId: string | null
  connected: boolean
  currentSession: AgentSession | null
  sessionId: string | null
  sessions: AgentSession[]
  onCreate: () => Promise<AgentSession>
  onDelete: (session: AgentSession) => Promise<void>
  onRename: (sessionId: string, title: string) => Promise<void>
  onSelect: (session: AgentSession) => Promise<void>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const create = () => {
    void onCreate().then(() => setMenuOpen(false)).catch(() => undefined)
  }

  const saveTitle = (id: string) => {
    if (!editingTitle.trim()) return
    void onRename(id, editingTitle).then(() => setEditingSessionId(null))
  }

  return (
    <div className="agent-session-nav">
      <button
        type="button"
        className="agent-session-trigger"
        aria-label="选择会话"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <History aria-hidden="true" />
        <span>
          <small>{connected ? '已连接' : sessionId ? '连接中' : '本地会话'}</small>
          <strong>{currentSession?.title || '新会话'}</strong>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      {menuOpen ? (
        <div className="agent-session-menu">
          <div className="agent-session-menu-header">
            <strong>会话</strong>
            <button type="button" title="新建会话" aria-label="新建会话" disabled={Boolean(activeRunId)} onClick={create}>
              <Plus aria-hidden="true" />
            </button>
          </div>
          <div className="agent-session-list">
            {sessions.length === 0 ? <span className="agent-session-empty">暂无会话</span> : null}
            {sessions.map((session) => {
              const isRunning = session.status === 'running' || (session.id === sessionId && Boolean(activeRunId))
              return (
                <div key={session.id} className="agent-session-row" data-active={String(session.id === sessionId)}>
                  {editingSessionId === session.id ? (
                    <input
                      autoFocus
                      aria-label="会话名称"
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
                        if (session.id !== sessionId) void onSelect(session)
                        setMenuOpen(false)
                      }}
                    >
                      <strong>{session.title || '新会话'}</strong>
                      <small>{new Date(session.updatedAt).toLocaleString('zh-CN', {
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
                        <button type="button" title="保存" aria-label="保存" disabled={!editingTitle.trim()} onClick={() => saveTitle(session.id)}><Check /></button>
                        <button type="button" title="取消" aria-label="取消" onClick={() => setEditingSessionId(null)}><X /></button>
                      </>
                    ) : (
                      <>
                        <button type="button" title="重命名" aria-label="重命名" onClick={() => {
                          setEditingSessionId(session.id)
                          setEditingTitle(session.title || '新会话')
                        }}><Pencil /></button>
                        <button type="button" title={isRunning ? '运行中的会话不能删除' : '删除'} aria-label="删除" disabled={isRunning} onClick={() => void onDelete(session)}><Trash2 /></button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
