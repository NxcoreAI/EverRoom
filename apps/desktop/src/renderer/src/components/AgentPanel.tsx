import type { AgentEvent, AgentMessage, AgentSessionSnapshot } from '@nxcore/agent-contract'
import {
  Activity,
  ArrowUp,
  Bot,
  Brain,
  Circle,
  LoaderCircle,
  Paperclip,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

type AgentTab = 'chat' | 'context' | 'activity'

interface DisplayMessage extends AgentMessage {
  streaming?: boolean
}

const SESSION_STORAGE_KEY = 'nxcore-ce:agent-sessions:v1'

const tabs: Array<{ id: AgentTab; label: string }> = [
  { id: 'chat', label: 'Agent' },
  { id: 'context', label: '上下文' },
  { id: 'activity', label: '活动' },
]

function readStoredSession(pageLabel: string): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object') return null
    const sessionId = (value as Record<string, unknown>)[pageLabel]
    return typeof sessionId === 'string' ? sessionId : null
  } catch {
    return null
  }
}

function storeSession(pageLabel: string, sessionId: string): void {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}')
    const sessions = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...sessions, [pageLabel]: sessionId }))
  } catch {
    // Session persistence is optional when browser storage is unavailable.
  }
}

export function AgentPanel({ pageLabel }: { pageLabel: string }) {
  const api = window.nxcore?.agent
  const [activeTab, setActiveTab] = useState<AgentTab>('chat')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [reasoning, setReasoning] = useState('')
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequenceByRun = useRef(new Map<string, number>())
  const sessionIdRef = useRef<string | null>(null)

  const applyEvent = useCallback((event: AgentEvent) => {
    const lastSequence = sequenceByRun.current.get(event.runId) ?? 0
    if (event.seq <= lastSequence) return
    sequenceByRun.current.set(event.runId, event.seq)

    if (event.type === 'run.accepted' || event.type === 'run.started') {
      setActiveRunId(event.runId)
      return
    }
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') setReasoning((current) => current + delta)
      return
    }
    if (event.type === 'message.started') {
      setMessages((current) => current.some((message) => message.id === `stream-${event.runId}`)
        ? current
        : [...current, {
          id: `stream-${event.runId}`,
          sessionId: event.sessionId,
          runId: event.runId,
          role: 'assistant',
          content: '',
          createdAt: event.occurredAt,
          streaming: true,
        }])
      return
    }
    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta !== 'string') return
      setMessages((current) => {
        const id = `stream-${event.runId}`
        const existing = current.find((message) => message.id === id)
        if (!existing) {
          return [...current, {
            id,
            sessionId: event.sessionId,
            runId: event.runId,
            role: 'assistant',
            content: delta,
            createdAt: event.occurredAt,
            streaming: true,
          }]
        }
        return current.map((message) => message.id === id
          ? { ...message, content: message.content + delta }
          : message)
      })
      return
    }
    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      setMessages((current) => current.map((message) => message.id === `stream-${event.runId}`
        ? { ...message, content: typeof content === 'string' ? content : message.content, streaming: false }
        : message))
      return
    }
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      setActiveRunId((current) => current === event.runId ? null : current)
      if (event.type === 'run.failed') {
        const message = (event.payload as { message?: unknown }).message
        setError(typeof message === 'string' ? message : 'Agent 运行失败。')
      }
    }
  }, [])

  const hydrateSnapshot = useCallback(async (snapshot: AgentSessionSnapshot) => {
    setMessages(snapshot.messages)
    setActiveRunId(snapshot.activeRun?.id ?? null)
    setSessionId(snapshot.session.id)
    sessionIdRef.current = snapshot.session.id
    if (snapshot.activeRun && api) {
      const events = await api.getEvents(snapshot.session.id, snapshot.activeRun.id, 0)
      for (const event of events) applyEvent(event)
    }
  }, [api, applyEvent])

  useEffect(() => {
    let alive = true
    setMessages([])
    setReasoning('')
    setActiveRunId(null)
    setSessionId(null)
    sessionIdRef.current = null
    sequenceByRun.current.clear()
    setConnected(false)
    setError(null)

    const storedSessionId = readStoredSession(pageLabel)
    if (api && storedSessionId) {
      setLoading(true)
      void api.getSession(storedSessionId)
        .then(async (snapshot) => {
          if (!alive) return
          await hydrateSnapshot(snapshot)
          if (alive) await api.subscribe(snapshot.session.id)
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setLoading(false)
        })
    }

    const removeListener = api?.onEvent((frame) => {
      const frameSessionId = frame.type === 'ready' ? frame.sessionId : frame.event.sessionId
      if (!alive || frameSessionId !== sessionIdRef.current) return
      if (frame.type === 'ready') {
        setConnected(true)
        if (frame.lastEventSeq > 0) {
          void api.getSession(frame.sessionId).then(hydrateSnapshot).catch(() => undefined)
        }
      } else {
        applyEvent(frame.event)
      }
    })
    return () => {
      alive = false
      removeListener?.()
      void api?.unsubscribe()
    }
  }, [api, applyEvent, hydrateSnapshot, pageLabel])

  const ensureSession = async (): Promise<string> => {
    if (!api) throw new Error('Agent 服务仅在桌面应用中可用。')
    if (sessionIdRef.current) return sessionIdRef.current
    const session = await api.createSession({ pageLabel })
    sessionIdRef.current = session.id
    setSessionId(session.id)
    storeSession(pageLabel, session.id)
    await api.subscribe(session.id)
    return session.id
  }

  const sendPrompt = async (prompt: string): Promise<void> => {
    const message = prompt.trim()
    if (!message || activeRunId || loading) return
    setLoading(true)
    setError(null)
    setReasoning('')
    try {
      const currentSessionId = await ensureSession()
      const optimisticId = `user-${crypto.randomUUID()}`
      setMessages((current) => [...current, {
        id: optimisticId,
        sessionId: currentSessionId,
        runId: 'pending',
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setDraft('')
      const run = await api!.startRun(currentSessionId, {
        prompt: message,
        idempotencyKey: crypto.randomUUID(),
      })
      setActiveRunId(run.id)
      setMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, runId: run.id }
        : item))
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '无法启动 Agent。')
    } finally {
      setLoading(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void sendPrompt(draft)
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendPrompt(draft)
    }
  }

  const stop = async () => {
    if (!api || !activeRunId) return
    try {
      await api.cancelRun(activeRunId)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : '无法停止 Agent。')
    }
  }

  const hasConversation = messages.length > 0 || loading

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div className="agent-title">
          <span className="agent-avatar"><Sparkles aria-hidden="true" /></span>
          <span><strong>Nex</strong><small>当前：{pageLabel}</small></span>
        </div>
        <span className="local-badge" data-connected={String(connected)}>
          <ShieldCheck aria-hidden="true" />
          {connected ? '已连接' : sessionId ? '连接中' : '本地'}
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
        {activeTab === 'chat' && !hasConversation ? (
          <div className="agent-empty">
            <span className="agent-empty-icon"><Bot aria-hidden="true" /></span>
            <strong>从当前上下文开始</strong>
            <p>选择 Room、来源或文档后，Nex 会在授权范围内协助你。</p>
            <div className="agent-suggestions">
              {['整理当前项目进展', '从已有来源生成文档', '查看待确认的记忆'].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => void sendPrompt(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === 'chat' && hasConversation ? (
          <div className="agent-conversation" aria-live="polite">
            {reasoning ? (
              <details className="agent-reasoning" open={Boolean(activeRunId)}>
                <summary><Brain aria-hidden="true" />思考过程</summary>
                <p>{reasoning}</p>
              </details>
            ) : null}
            {messages.map((message) => (
              <article key={message.id} className="agent-message" data-role={message.role}>
                <div className="agent-message-meta">
                  <span>{message.role === 'user' ? '你' : 'Nex'}</span>
                  {message.streaming ? <LoaderCircle className="spin" aria-label="正在生成" /> : null}
                </div>
                <p>{message.content || ' '}</p>
              </article>
            ))}
            {loading && messages.length === 0 ? (
              <div className="agent-loading"><LoaderCircle className="spin" />正在载入会话</div>
            ) : null}
            {error ? <div className="agent-error" role="alert">{error}</div> : null}
          </div>
        ) : null}

        {activeTab === 'context' ? (
          <div className="context-list">
            <div className="panel-section-title">本轮上下文</div>
            <div className="context-row">
              <span className="context-icon">R</span>
              <span><strong>{pageLabel}</strong><small>当前工作区</small></span>
            </div>
            <div className="context-row muted-row">
              <span className="context-icon">0</span>
              <span><strong>尚未选择来源</strong><small>Agent 不会读取其他内容</small></span>
            </div>
          </div>
        ) : null}

        {activeTab === 'activity' ? (
          <div className="activity-list">
            <div className="panel-section-title">当前运行</div>
            <div className="activity-row">
              {activeRunId ? <LoaderCircle className="spin" aria-hidden="true" /> : <Activity aria-hidden="true" />}
              <span>
                <strong>{activeRunId ? 'Agent 正在运行' : '工作区已就绪'}</strong>
                <small>{messages.length} 条消息</small>
              </span>
            </div>
            <div className="activity-row muted-row">
              <Circle aria-hidden="true" />
              <span><strong>Fake Runtime</strong><small>等待下一阶段替换为 Pi SDK</small></span>
            </div>
          </div>
        ) : null}
      </div>

      <footer className="agent-composer">
        <div className="composer-scope">使用当前页面上下文</div>
        <form className="composer-box" onSubmit={submit}>
          <textarea
            aria-label="给 Nex 发送消息"
            placeholder={activeRunId ? 'Nex 正在处理...' : '告诉 Nex 你想完成什么...'}
            rows={3}
            value={draft}
            disabled={Boolean(activeRunId)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="composer-actions">
            <button type="button" className="icon-button" title="添加来源" aria-label="添加来源" disabled>
              <Paperclip aria-hidden="true" />
            </button>
            {activeRunId ? (
              <button type="button" className="send-button stop-button" title="停止" aria-label="停止" onClick={() => void stop()}>
                <Square aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="send-button" title="发送" aria-label="发送" disabled={!draft.trim() || loading}>
                <ArrowUp aria-hidden="true" />
              </button>
            )}
          </div>
        </form>
      </footer>
    </aside>
  )
}
