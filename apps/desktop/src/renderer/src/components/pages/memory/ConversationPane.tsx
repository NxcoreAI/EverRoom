import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryConversationMessageDto } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, useAsyncData } from './useMemoryData'

/** gateway /v1/memory/conversation 的 limit 上限是 100。 */
const RECENT_LIMIT = 100
const UNKNOWN_SESSION_ID = '__unknown_session__'

interface ConversationGroup {
  sessionId: string
  messages: MemoryConversationMessageDto[]
  latestAt: string | null
  /** 文档导入生成的会话（memdoc:*，消息 source_kind=document）。 */
  isDocument: boolean
}

function groupBySession(messages: MemoryConversationMessageDto[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>()
  for (const message of messages) {
    const key = message.sessionId ?? UNKNOWN_SESSION_ID
    let group = groups.get(key)
    if (!group) {
      group = { sessionId: key, messages: [], latestAt: null, isDocument: false }
      groups.set(key, group)
    }
    group.messages.push(message)
    if (message.sourceKind === 'document') group.isDocument = true
    if (!group.latestAt || (message.timestamp && message.timestamp > group.latestAt)) {
      group.latestAt = message.timestamp
    }
  }
  // 服务端按时间倒序返回；每组内还原为时间正序，组间保持最近在前。
  return [...groups.values()]
    .map((group) => ({ ...group, messages: [...group.messages].reverse() }))
}

export function ConversationPane({ focusSessionId }: { focusSessionId?: string | null }) {
  const { locale, t } = useLocale()
  const [reloadTick, setReloadTick] = useState(0)
  const [sessionFilter, setSessionFilter] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listConversations({ limit: RECENT_LIMIT }),
    [reloadTick],
  )

  // 溯源跳转：原子记忆 → 按会话过滤
  useEffect(() => {
    if (focusSessionId) setSessionFilter(focusSessionId)
  }, [focusSessionId])

  const groups = useMemo(() => groupBySession(data?.messages ?? []), [data])
  // 会话记录只展示真实对话；文档导入块（memdoc:*）归「文档记录」页管理，
  // 仅在溯源定位到该会话时单独可见。
  const conversationGroups = groups.filter((group) => !group.isDocument)
  const focusedDocumentGroup = sessionFilter.startsWith('memdoc:')
    ? groups.find((group) => group.sessionId === sessionFilter)
    : undefined
  const visibleGroups = sessionFilter
    ? conversationGroups.filter((group) => group.sessionId === sessionFilter).concat(focusedDocumentGroup ?? [])
    : conversationGroups
  const sessionTitle = (group: ConversationGroup): string => {
    if (group.isDocument || group.sessionId === UNKNOWN_SESSION_ID) return sessionLabel(group.sessionId)
    const firstUser = group.messages.find((message) => message.role === 'user') ?? group.messages[0]
    const excerpt = firstUser?.content.replace(/\s+/g, ' ').trim().slice(0, 28)
    return excerpt || sessionLabel(group.sessionId)
  }
  const sessionLabel = (sessionId: string) => sessionId === UNKNOWN_SESSION_ID
    ? t('memory:conversation.unknownSession')
    : sessionId

  const removeSession = async (sessionId: string) => {
    setDeleting(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteConversations({ sessionIds: [sessionId] })
      setConfirmingId(null)
      if (sessionFilter === sessionId) setSessionFilter('')
      setReloadTick((tick) => tick + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:conversation.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{memoryFailureText(failure, t)}</div>

  return (
    <div className="mem-conversation">
      <div className="mem-toolbar">
        <span className="mem-count">{t('memory:conversation.latestCountMessagesLimitLimit', { count: visibleGroups.reduce((sum, group) => sum + group.messages.length, 0), limit: RECENT_LIMIT })}</span>
        {conversationGroups.length > 1 ? (
          <label className="mem-session-filter">
            {t('memory:conversation.conversations')}
            <select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}>
              <option value="">{t('memory:conversation.allCount', { count: conversationGroups.length })}</option>
              {conversationGroups.map((group) => (
                <option key={group.sessionId} value={group.sessionId}>
                  {t('memory:conversation.idCountItems', { id: sessionTitle(group), count: group.messages.length })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="mem-toolbar-actions">
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)} disabled={loading}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={loading ? 'mem-spin' : undefined} />{t('memory:conversation.refresh')}
          </button>
        </span>
      </div>
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {!loading && visibleGroups.length === 0 ? (
        <MemoryEmptyView
          title={t('memory:conversation.noConversationHistoryYet')}
          hint={t('memory:conversation.everyConversationWithTheAiAssistantIsWritten')}
        />
      ) : (
        visibleGroups.map((group) => (
          <section key={group.sessionId} className="mem-session">
            <header className="mem-session-header">
              <button
                type="button"
                className="mem-session-title"
                data-active={sessionFilter === group.sessionId}
                onClick={() => setSessionFilter(sessionFilter === group.sessionId ? '' : group.sessionId)}
                title={t('memory:conversation.filterByThisSession')}
              >
                {sessionTitle(group)}
                {group.isDocument ? <span className="mem-doc-badge">{t('memory:conversation.documents')}</span> : null}
              </button>
              <small>{group.latestAt ? formatDate(group.latestAt, locale) : ''} · {t('memory:conversation.countItems', { count: group.messages.length })}</small>
              {confirmingId === group.sessionId ? (
                <span className="mem-session-actions">
                  <button type="button" className="mem-danger" disabled={deleting} onClick={() => removeSession(group.sessionId)}>
                    {t('memory:conversation.deleteEntireSession')}
                  </button>
                  <button type="button" disabled={deleting} onClick={() => setConfirmingId(null)}>{t('memory:conversation.cancel')}</button>
                </span>
              ) : (
                <span className="mem-session-actions">
                  <button type="button" onClick={() => setConfirmingId(group.sessionId)} disabled={group.sessionId === UNKNOWN_SESSION_ID}>
                    <Trash2 aria-hidden="true" strokeWidth={1.7} />{t('memory:conversation.deleteSession')}
                  </button>
                </span>
              )}
            </header>
            <ul className="mem-messages">
              {group.messages.map((message) => (
                <li key={message.id || `${message.role}-${message.timestamp}-${message.content.slice(0, 24)}`} data-role={message.role}>
                  <div className="mem-bubble">
                    <p>{message.content}</p>
                    {message.timestamp ? <small>{formatDate(message.timestamp, locale)}</small> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
