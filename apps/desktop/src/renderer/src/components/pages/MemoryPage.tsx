import { RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { MEMORY_TAB_EVENT } from '../MemoryPipelineStatus'
import { AtomicMemoryPane } from './memory/AtomicMemoryPane'
import { ConversationPane } from './memory/ConversationPane'
import { CoreProfilePane } from './memory/CoreProfilePane'
import { WritingStylePane } from './memory/WritingStylePane'
import { DocumentPane } from './memory/DocumentPane'
import { FilterRulesPane } from './memory/FilterRulesPane'
import { OrganizationPreferencePane } from './memory/OrganizationPreferencePane'
import { IngestLedgerPane } from './memory/IngestLedgerPane'
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
  { id: 'overview', label: 'memory:memory.overview', level: '' },
  { id: 'conversation', label: 'memory:memory.conversations', level: 'L0' },
  { id: 'documents', label: 'memory:memory.documents', level: '' },
  { id: 'atomic', label: 'memory:memory.atomicMemory', level: 'L1' },
  { id: 'scenario', label: 'memory:memory.scenarios', level: 'L2' },
  { id: 'core', label: 'memory:memory.profile', level: 'L3' },
  // 写作风格 = 从用户文档自动沉淀的表达偏好（系统段只读）+ 用户指令段可编辑
  { id: 'writing-style', label: 'memory:memory.writingStyle', level: '' },
  // 导入记录 = 统一引擎台账（全源进入记录 + 过滤闸状态，误杀恢复入口）
  { id: 'ledger', label: 'memory:memory.ledger', level: '' },
  // 过滤规则 = 过滤器判定偏好（用户偏好可编辑 + 系统洞察只读）
  { id: 'filter-rules', label: 'memory:memory.filterRules', level: '' },
  // 整理偏好 = 知识整理习惯学习（M3）：合并/路由/晋升信号的统计与洞察 + 用户接管
  { id: 'org-preferences', label: 'memory:memory.organizationPreferences', level: '' },
]

export function MemoryPage({ focusAtomicId }: { focusAtomicId?: string | null } = {}) {
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

  // 侧边栏记忆管道点击跳转：按新增层级直接打开对应 tab。
  useEffect(() => {
    const openTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab: string }>).detail?.tab
      if (tab && TABS.some((entry) => entry.id === tab)) {
        setSearch(null)
        setTab(tab as MemoryTabId)
      }
    }
    window.addEventListener(MEMORY_TAB_EVENT, openTab)
    return () => window.removeEventListener(MEMORY_TAB_EVENT, openTab)
  }, [])

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
      setSearchError(cause instanceof Error ? cause.message : t('memory:memory.searchFailed'))
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
          <h1>{t('memory:memory.memory')}</h1>
        </div>
        <div className="mem-header-tools">
          <div className="mem-searchbox">
            <Search aria-hidden="true" strokeWidth={1.7} />
            <input
              type="search"
              value={searchText}
              placeholder={t('memory:memory.searchMemoryAndConversations')}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
              }}
            />
          </div>
          <button
            type="button"
            className="mem-icon-button"
            title={t('memory:memory.refresh')}
            onClick={overview.refresh}
            disabled={overview.loading}
          >
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={overview.loading ? 'mem-spin' : undefined} />
          </button>
        </div>
      </header>
      <nav className="mem-tabs" role="tablist" aria-label={t('memory:memory.memoryLevels')}>
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
              <span className="mem-tab-name">
                {t(entry.label)}
                {entry.level ? <span className="mem-level-badge">{entry.level}</span> : null}
              </span>
              {/* 数量固定占一行（无数量的 tab 留空行），保证各 tab 等高、下划线对齐 */}
              <span className="mem-tab-count">{count !== null ? count : ''}</span>
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
        <p className="mem-loading">{t('memory:memory.searching')}</p>
      ) : (
        <div className="mem-content">
          {tab === 'overview' ? (
            overview.data
              ? <MemoryOverviewPane overview={overview.data} onNavigate={setTab} />
              : <p className="mem-loading">{t('memory:memory.loading')}</p>
          ) : null}
          {tab === 'atomic' ? (
            <AtomicMemoryPane focusItemId={focusAtomicId} onOpenDocument={openDocument} onOpenConversation={openConversation} />
          ) : null}
          {tab === 'scenario' ? <ScenarioPane /> : null}
          {tab === 'core' ? <CoreProfilePane /> : null}
          {tab === 'writing-style' ? <WritingStylePane /> : null}
          {tab === 'ledger' ? <IngestLedgerPane /> : null}
          {tab === 'filter-rules' ? <FilterRulesPane /> : null}
          {tab === 'org-preferences' ? <OrganizationPreferencePane /> : null}
          {tab === 'conversation' ? (
            <ConversationPane focusSessionId={conversationFocus} />
          ) : null}
          {tab === 'documents' ? <DocumentPane focusDocumentId={documentFocus} /> : null}
        </div>
      )}
    </div>
  )
}
