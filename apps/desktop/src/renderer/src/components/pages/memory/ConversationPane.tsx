import { RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { MemoryConversationMessageDto } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, useAsyncData } from './useMemoryData'

/** gateway /v1/memory/conversation 的 limit 上限是 100。 */
const RECENT_LIMIT = 100

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
    const key = message.sessionId ?? '（未知会话）'
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
  const [reloadTick, setReloadTick] = useState(0)
  const [sessionFilter, setSessionFilter] = useState('')
  const [conversationsOnly, setConversationsOnly] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listConversations({
      limit: RECENT_LIMIT,
      ...(conversationsOnly ? { sourceKind: 'conversation' as const } : {}),
    }),
    [reloadTick, conversationsOnly],
  )

  // 溯源跳转：原子记忆 → 按会话过滤
  useEffect(() => {
    if (focusSessionId) setSessionFilter(focusSessionId)
  }, [focusSessionId])

  const groups = useMemo(() => groupBySession(data?.messages ?? []), [data])
  const visibleGroups = sessionFilter
    ? groups.filter((group) => group.sessionId === sessionFilter)
    : groups

  const removeSession = async (sessionId: string) => {
    setDeleting(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteConversations({ sessionIds: [sessionId] })
      setConfirmingId(null)
      if (sessionFilter === sessionId) setSessionFilter('')
      setReloadTick((tick) => tick + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败。')
    } finally {
      setDeleting(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{failure.message}</div>

  return (
    <div className="mem-conversation">
      <div className="mem-toolbar">
        <span className="mem-count">最近 {data?.messages.length ?? 0} 条消息（上限 {RECENT_LIMIT}）</span>
        <label className="mem-source-toggle" title="排除 md 文档导入生成的会话块">
          <input
            type="checkbox"
            checked={conversationsOnly}
            onChange={(event) => { setConversationsOnly(event.target.checked); setSessionFilter('') }}
          />
          仅对话
        </label>
        {groups.length > 1 ? (
          <label className="mem-session-filter">
            会话
            <select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}>
              <option value="">全部（{groups.length} 个）</option>
              {groups.map((group) => (
                <option key={group.sessionId} value={group.sessionId}>
                  {`${group.sessionId}（${group.messages.length} 条）`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="mem-toolbar-actions">
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)} disabled={loading}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={loading ? 'mem-spin' : undefined} />刷新
          </button>
        </span>
      </div>
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {!loading && visibleGroups.length === 0 ? (
        <MemoryEmptyView
          title="暂无对话记录"
          hint="与 AI 助手的每轮对话都会自动写入记忆服务（L0），作为后续提炼的原料。"
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
                title="点击筛选该会话"
              >
                {group.sessionId}
                {group.isDocument ? <span className="mem-doc-badge">文档</span> : null}
              </button>
              <small>{group.latestAt ? formatDate(group.latestAt) : ''} · {group.messages.length} 条</small>
              {confirmingId === group.sessionId ? (
                <span className="mem-session-actions">
                  <button type="button" className="mem-danger" disabled={deleting} onClick={() => removeSession(group.sessionId)}>
                    确认删除整个会话
                  </button>
                  <button type="button" disabled={deleting} onClick={() => setConfirmingId(null)}>取消</button>
                </span>
              ) : (
                <span className="mem-session-actions">
                  <button type="button" onClick={() => setConfirmingId(group.sessionId)} disabled={group.sessionId === '（未知会话）'}>
                    <Trash2 aria-hidden="true" strokeWidth={1.7} />删除会话
                  </button>
                </span>
              )}
            </header>
            <ul className="mem-messages">
              {group.messages.map((message) => (
                <li key={message.id || `${message.role}-${message.timestamp}-${message.content.slice(0, 24)}`} data-role={message.role}>
                  <div className="mem-bubble">
                    <p>{message.content}</p>
                    {message.timestamp ? <small>{formatDate(message.timestamp)}</small> : null}
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
