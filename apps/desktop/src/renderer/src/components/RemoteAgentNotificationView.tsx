import { ArrowLeft, Bot, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  AgentNotificationTarget,
  CloudAgentMessage,
  CloudAgentSessionSummary,
} from '../../../shared/notifications'
import { useLocale } from '@/i18n/LocaleContext'
import './RemoteAgentNotificationView.css'

export function RemoteAgentNotificationView({ target, onClose }: { target: AgentNotificationTarget; onClose(): void }) {
  const { t } = useLocale()
  const [session, setSession] = useState<CloudAgentSessionSummary | null>(null)
  const [messages, setMessages] = useState<CloudAgentMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const api = window.nxcore?.notifications
    if (!api) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([
      api.cloudSessions(target.sourceDeviceId),
      api.cloudMessages(target.sourceDeviceId, target.sessionId),
    ]).then(([sessions, page]) => {
      if (cancelled) return
      setSession(sessions.find((item) => item.id === target.sessionId) ?? null)
      setMessages(page.items)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [target.notificationId, target.sessionId, target.sourceDeviceId])

  const relevantMessages = useMemo(() => {
    const runMessages = messages.filter((message) => message.runId === target.runId)
    return runMessages.length ? runMessages : messages
  }, [messages, target.runId])

  return (
    <section className="remote-agent-view" aria-labelledby="remote-agent-title">
      <header>
        <button type="button" onClick={onClose} aria-label={t('surface:notifications.back')} title={t('surface:notifications.back')}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <div>
          <h1 id="remote-agent-title">{session?.title || session?.pageLabel || t('surface:notifications.agentResult')}</h1>
          <span>{session?.pageLabel || t('surface:notifications.agentSession')}</span>
        </div>
      </header>
      <main>
        {loading ? <div className="remote-agent-state"><LoaderCircle className="spin" aria-hidden="true" /></div> : null}
        {error ? <div className="remote-agent-state" role="alert">{error}</div> : null}
        {!loading && !error && !relevantMessages.length ? (
          <div className="remote-agent-state"><Bot aria-hidden="true" /><span>{t('surface:notifications.noSessionData')}</span></div>
        ) : null}
        {relevantMessages.map((message) => (
          <article key={message.id} className="remote-agent-message" data-role={message.role} data-target-run={String(message.runId === target.runId)}>
            <span>{message.role === 'assistant' ? 'EverRoom Agent' : message.role}</span>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </article>
        ))}
      </main>
    </section>
  )
}
