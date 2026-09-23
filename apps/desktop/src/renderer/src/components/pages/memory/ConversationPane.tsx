import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryConversationMessageDto } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, useAsyncData } from './useMemoryData'

/** gateway /v1/memory/conversation 的 limit 上限是 100。 */
const PAGE_SIZE = 100
const MAX_PAGES = 10
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

function excerpt(content: string, max: number): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, max)
}

interface ConversationFetch {
  messages: MemoryConversationMessageDto[]
  /** 溯源定位到文档会话时单独拉取的该会话消息（memdoc:* 不在 sourceKind=conversation 结果里）。 */
  focusedDocumentMessages: MemoryConversationMessageDto[] | null
}

/**
 * 拉取真实对话（L0）：sourceKind=conversation 让服务端排除文档导入块，
 * 分页直到 total，避免文档 chunk 吃掉单页 100 条上限导致会话缺失。
 */
async function fetchConversations(focusSessionId: string | null | undefined): Promise<ConversationFetch> {
  const all: MemoryConversationMessageDto[] = []
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await window.nxcore!.memory.listConversations({
      limit: PAGE_SIZE,
      offset,
      sourceKind: 'conversation',
    })
    all.push(...result.messages)
    offset += result.messages.length
    if (result.messages.length === 0 || offset >= result.total) break
  }
  const focusedDocumentMessages = focusSessionId?.startsWith('memdoc:')
    ? (await window.nxcore!.memory.listConversations({ sessionId: focusSessionId, limit: PAGE_SIZE })).messages
    : null
  return { messages: all, focusedDocumentMessages }
}

export function ConversationPane({ focusSessionId }: { focusSessionId?: string | null }) {
  const { locale, t } = useLocale()
  const [reloadTick, setReloadTick] = useState(0)
  const [sessionFilter, setSessionFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data, failure, loading } = useAsyncData(
    () => fetchConversations(focusSessionId),
    [reloadTick, focusSessionId],
  )

  // 溯源跳转：原子记忆 → 按会话过滤并展开
  useEffect(() => {
    if (focusSessionId) {
      setSessionFilter(focusSessionId)
      setExpandedId(focusSessionId)
    }
  }, [focusSessionId])

  const groups = useMemo(() => groupBySession(data?.messages ?? []), [data])
  // 会话记录只展示真实对话；文档导入块（memdoc:*）归「文档记录」页管理，
  // 仅在溯源定位到该会话时单独可见。
  const conversationGroups = groups.filter((group) => !group.isDocument)
  const focusedDocumentGroup = useMemo(() => {
    if (!sessionFilter.startsWith('memdoc:')) return undefined
    const messages = data?.focusedDocumentMessages
    return messages?.length ? groupBySession(messages).find((group) => group.sessionId === sessionFilter) : undefined
  }, [data, sessionFilter])
  const visibleGroups = sessionFilter
    ? conversationGroups.filter((group) => group.sessionId === sessionFilter).concat(focusedDocumentGroup ?? [])
    : conversationGroups
  const sessionTitle = (group: ConversationGroup): string => {
    if (group.isDocument || group.sessionId === UNKNOWN_SESSION_ID) return sessionLabel(group.sessionId)
    const firstUser = group.messages.find((message) => message.role === 'user') ?? group.messages[0]
    return (firstUser ? excerpt(firstUser.content, 40) : '') || sessionLabel(group.sessionId)
  }
  const sessionPreview = (group: ConversationGroup): string => {
    const last = group.messages[group.messages.length - 1]
    return last ? excerpt(last.content, 90) : ''
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
      if (expandedId === sessionId) setExpandedId(null)
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
        <span className="mem-count">{t('memory:conversation.totalSessions', { count: visibleGroups.length })}</span>
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
        visibleGroups.map((group) => {
          const isExpanded = expandedId === group.sessionId
          return (
            <section key={group.sessionId} className="mem-session" data-open={isExpanded}>
              <div className="mem-session-head">
                <button
                  type="button"
                  className="mem-session-toggle"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedId(isExpanded ? null : group.sessionId)}
                >
                  <ChevronRight aria-hidden="true" strokeWidth={2} className="mem-session-chevron" />
                  <span className="mem-session-body">
                    <span className="mem-session-name">
                      {sessionTitle(group)}
                      {group.isDocument ? <span className="mem-doc-badge">{t('memory:conversation.documents')}</span> : null}
                    </span>
                    {!isExpanded ? <span className="mem-session-preview">{sessionPreview(group)}</span> : null}
                  </span>
                </button>
                <small className="mem-session-meta">
                  {group.latestAt ? formatDate(group.latestAt, locale) : ''} · {t('memory:conversation.countItems', { count: group.messages.length })}
                </small>
                {confirmingId === group.sessionId ? (
                  <span className="mem-session-actions">
                    <button type="button" className="mem-danger" disabled={deleting} onClick={() => removeSession(group.sessionId)}>
                      {t('memory:conversation.deleteEntireSession')}
                    </button>
                    <button type="button" disabled={deleting} onClick={() => setConfirmingId(null)}>{t('memory:conversation.cancel')}</button>
                  </span>
                ) : (
                  <span className="mem-session-actions">
                    <button
                      type="button"
                      className="mem-session-icon-btn"
                      title={t('memory:conversation.deleteSession')}
                      aria-label={t('memory:conversation.deleteSession')}
                      disabled={group.sessionId === UNKNOWN_SESSION_ID}
                      onClick={() => setConfirmingId(group.sessionId)}
                    >
                      <Trash2 aria-hidden="true" strokeWidth={1.7} />
                    </button>
                  </span>
                )}
              </div>
              {isExpanded ? (
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
              ) : null}
            </section>
          )
        })
      )}
    </div>
  )
}
