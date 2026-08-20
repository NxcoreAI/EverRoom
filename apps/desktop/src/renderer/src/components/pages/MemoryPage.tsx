import { RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'

import { AtomicMemoryPane } from './memory/AtomicMemoryPane'
import { ConversationPane } from './memory/ConversationPane'
import { CoreProfilePane } from './memory/CoreProfilePane'
import { DocumentPane } from './memory/DocumentPane'
import { MemoryDisabledView, MemoryUnreachableView } from './memory/MemoryStatusViews'
import type { MemorySearchResult } from './memory/MemorySearchResults'
import { MemorySearchResults } from './memory/MemorySearchResults'
import { MemoryOverviewPane } from './memory/MemoryOverviewPane'
import { ScenarioPane } from './memory/ScenarioPane'
import type { MemoryTabId } from './memory/useMemoryData'
import { useMemoryOverview } from './memory/useMemoryData'
import './memory/MemoryPage.css'
import { useLocale } from '@/i18n/LocaleContext'

const TABS: Array<{ id: MemoryTabId; label: string; level: string }> = [
  { id: 'overview', label: '总览', level: '' },
  { id: 'conversation', label: '对话', level: 'L0' },
  { id: 'documents', label: '文档', level: '' },
  { id: 'atomic', label: '原子记忆', level: 'L1' },
  { id: 'scenario', label: '场景', level: 'L2' },
  { id: 'core', label: '画像', level: 'L3' },
]

export function MemoryPage() {
  const { t } = useLocale()
  const overview = useMemoryOverview()
  const [tab, setTab] = useState<MemoryTabId>('overview')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState<{ query: string; result: MemorySearchResult } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 溯源跳转目标（原子记忆 → 文档详情 / 会话过滤），置位同时切 Tab。
  const [documentFocus, setDocumentFocus] = useState<string | null>(null)
  const [conversationFocus, setConversationFocus] = useState<string | null>(null)

  const openDocument = (documentId: string) => {
    setDocumentFocus(documentId)
    setSearch(null)
    setTab('documents')
  }
  const openConversation = (sessionId: string) => {
    setConversationFocus(sessionId)
    setSearch(null)
    setTab('conversation')
  }

  const runSearch = async () => {
    const query = searchText.trim()
    if (!query) return
    setSearching(true)
    setSearchError(null)
    try {
      const [atomic, conversations] = await Promise.all([
        window.nxcore!.memory.searchAtomic(query, 20),
        window.nxcore!.memory.searchConversations(query, 20),
      ])
      setSearch({ query, result: { atomic: atomic.items, conversations: conversations.messages } })
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : t('搜索失败。'))
    } finally {
      setSearching(false)
    }
  }

  if (overview.failure && !overview.data) {
    if (overview.failure.kind === 'disabled') {
      return <div className="page mem-page"><MemoryDisabledView /></div>
    }
    return (
      <div className="page mem-page">
        <MemoryUnreachableView failure={overview.failure} onRetry={overview.refresh} />
      </div>
    )
  }

  return (
    <div className="page mem-page">
      <header className="mem-header">
        <div>
          <h1>{t('记忆')}</h1>
          <p>{t('查看 AI 通过 MemoryCore 沉淀的长期记忆：对话（L0）、原子记忆（L1）、场景（L2）与画像（L3）。')}</p>
        </div>
        <div className="mem-header-tools">
          <div className="mem-searchbox">
            <Search aria-hidden="true" strokeWidth={1.7} />
            <input
              type="search"
              value={searchText}
              placeholder={t('搜索记忆与历史对话')}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
              }}
            />
          </div>
          <button
            type="button"
            className="mem-icon-button"
            title={t('刷新')}
            onClick={overview.refresh}
            disabled={overview.loading}
          >
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={overview.loading ? 'mem-spin' : undefined} />
          </button>
        </div>
      </header>
      <nav className="mem-tabs" role="tablist" aria-label={t('记忆层级')}>
        {TABS.map((entry) => {
          const data = overview.data
          const count = !data ? null
            : entry.id === 'atomic' ? data.l1?.total ?? null
              : entry.id === 'scenario' ? data.l2?.total ?? null
                : entry.id === 'conversation' ? data.l0?.total ?? null
                  : null
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id && !search}
              data-active={tab === entry.id && !search}
              onClick={() => { setTab(entry.id); setSearch(null) }}
            >
              {t(entry.label)}
              {entry.level ? <span className="mem-level-badge">{entry.level}</span> : null}
              {count !== null ? <span className="mem-tab-count">{count}</span> : null}
            </button>
          )
        })}
      </nav>
      {searchError ? <p className="mem-inline-error">{searchError}</p> : null}
      {search ? (
        <MemorySearchResults
          query={search.query}
          result={search.result}
          onClear={() => { setSearch(null); setSearchText('') }}
          onOpenAtomic={() => { setSearch(null); setTab('atomic') }}
        />
      ) : searching ? (
        <p className="mem-loading">{t('搜索中…')}</p>
      ) : (
        <div className="mem-content">
          {tab === 'overview' ? (
            overview.data
              ? <MemoryOverviewPane overview={overview.data} onNavigate={setTab} />
              : <p className="mem-loading">{t('加载中…')}</p>
          ) : null}
          {tab === 'atomic' ? (
            <AtomicMemoryPane onOpenDocument={openDocument} onOpenConversation={openConversation} />
          ) : null}
          {tab === 'scenario' ? <ScenarioPane /> : null}
          {tab === 'core' ? <CoreProfilePane /> : null}
          {tab === 'conversation' ? (
            <ConversationPane focusSessionId={conversationFocus} />
          ) : null}
          {tab === 'documents' ? <DocumentPane focusDocumentId={documentFocus} /> : null}
        </div>
      )}
    </div>
  )
}
