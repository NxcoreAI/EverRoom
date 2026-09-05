import { MessagesSquare, Search, Sparkles, X } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryAtomicItemDto, MemoryConversationMessageDto } from '../../../../../shared/memory'
import { formatDate } from './useMemoryData'

const TYPE_LABELS: Record<string, string> = {
  episodic: 'memory:memorySearchResults.episodic',
  persona: 'memory:memorySearchResults.persona',
  instruction: 'memory:memorySearchResults.instruction',
}

export interface MemorySearchResult {
  atomic: MemoryAtomicItemDto[]
  conversations: MemoryConversationMessageDto[]
}

function highlight(text: string, query: string): Array<string | { match: string }> {
  if (!query.trim()) return [text]
  const needle = query.trim()
  const parts: Array<string | { match: string }> = []
  let cursor = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push({ match: text.slice(index, index + needle.length) })
    cursor = index + needle.length
    index = text.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, index) =>
        typeof part === 'string' ? part : <mark key={index}>{part.match}</mark>,
      )}
    </>
  )
}

export function MemorySearchResults({ query, result, onClear, onOpenAtomic }: {
  query: string
  result: MemorySearchResult
  onClear: () => void
  onOpenAtomic: () => void
}) {
  const { locale, t } = useLocale()
  const empty = result.atomic.length === 0 && result.conversations.length === 0
  return (
    <div className="mem-search-results">
      <header className="mem-search-header">
        <Search aria-hidden="true" strokeWidth={1.7} />
        <span>{t('memory:memorySearchResults.resultsForQuery', { query })}</span>
        <button type="button" onClick={onClear}><X aria-hidden="true" strokeWidth={1.8} />{t('memory:memorySearchResults.clear')}</button>
      </header>
      {empty ? (
        <p className="mem-search-empty">{t('memory:memorySearchResults.noRelatedMemoriesOrConversationsFound')}</p>
      ) : (
        <>
          {result.atomic.length > 0 ? (
            <section>
              <h3><Sparkles aria-hidden="true" strokeWidth={1.7} />{t('memory:memorySearchResults.atomicMemoriesCount', { count: result.atomic.length })}</h3>
              <ul className="mem-search-list">
                {result.atomic.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="mem-search-item" onClick={onOpenAtomic}>
                      <span className="mem-type-badge" data-type={item.type}>{t(TYPE_LABELS[item.type] ?? item.type)}</span>
                      {item.roomId ? (
                        <span className="mem-room-chip" data-available={Boolean(item.roomTitle)}>
                          {item.roomTitle ?? t('memory:atomicMemory.roomUnavailable')}
                        </span>
                      ) : null}
                      <span className="mem-atomic-text"><Highlighted text={item.content} query={query} /></span>
                      <span className="mem-time">{formatDate(item.updatedAt, locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {result.conversations.length > 0 ? (
            <section>
              <h3><MessagesSquare aria-hidden="true" strokeWidth={1.7} />{t('memory:memorySearchResults.conversationHistoryCount', { count: result.conversations.length })}</h3>
              <ul className="mem-search-list">
                {result.conversations.map((message, index) => (
                  <li key={message.id || index}>
                    <div className="mem-search-item mem-search-message" data-role={message.role}>
                      <span className="mem-role-tag">{t(message.role === 'user' ? 'memory:memorySearchResults.user' : 'memory:memorySearchResults.assistant')}</span>
                      <span className="mem-atomic-text"><Highlighted text={message.content} query={query} /></span>
                      <span className="mem-time">{formatDate(message.timestamp, locale)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
