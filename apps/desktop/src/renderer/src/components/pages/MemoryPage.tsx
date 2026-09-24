import { Pause, Play, RefreshCw, Search } from 'lucide-react'
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
import { ScenarioPane } from './memory/ScenarioPane'
import type { MemoryTabId } from './memory/useMemoryData'
import { useMemoryOverview } from './memory/useMemoryData'
import './memory/MemoryPage.css'
import { useLocale } from '@/i18n/LocaleContext'

/** 一级入口：时间轴（记忆库主体）/ 来源（原始记录）/ 整理（派生与治理）。 */
type MemorySection = 'timeline' | 'sources' | 'organize'
type SourceSubId = 'conversation' | 'documents'
type OrganizeSubId = 'scenario' | 'core' | 'writing-style' | 'ledger' | 'filter-rules' | 'org-preferences'

const SECTIONS: Array<{ id: MemorySection; label: string }> = [
  { id: 'timeline', label: 'memory:memory.atomicTimeline' },
  { id: 'sources', label: 'memory:nav.sources' },
  { id: 'organize', label: 'memory:nav.organize' },
]

const SOURCE_TABS: Array<{ id: SourceSubId; label: string }> = [
  { id: 'conversation', label: 'memory:memory.conversations' },
  { id: 'documents', label: 'memory:memory.documents' },
]

const ORGANIZE_TABS: Array<{ id: OrganizeSubId; label: string }> = [
  { id: 'scenario', label: 'memory:memory.scenarios' },
  { id: 'core', label: 'memory:memory.profile' },
  { id: 'writing-style', label: 'memory:memory.writingStyle' },
  { id: 'ledger', label: 'memory:memory.ledger' },
  { id: 'filter-rules', label: 'memory:memory.filterRules' },
  { id: 'org-preferences', label: 'memory:memory.organizationPreferences' },
]

/** 管道事件 tab id → 一级分区 + 二级页（侧边栏记忆管道点击跳转用）。 */
const SECTION_OF_TAB: Record<string, { section: MemorySection; sub: SourceSubId | OrganizeSubId }> = {
  atomic: { section: 'timeline', sub: 'conversation' },
  conversation: { section: 'sources', sub: 'conversation' },
  documents: { section: 'sources', sub: 'documents' },
  scenario: { section: 'organize', sub: 'scenario' },
  core: { section: 'organize', sub: 'core' },
  'writing-style': { section: 'organize', sub: 'writing-style' },
  ledger: { section: 'organize', sub: 'ledger' },
  'filter-rules': { section: 'organize', sub: 'filter-rules' },
  'org-preferences': { section: 'organize', sub: 'org-preferences' },
}

export function MemoryPage({ focusAtomicId }: { focusAtomicId?: string | null } = {}) {
  const { t } = useLocale()
  const overview = useMemoryOverview()
  const [section, setSection] = useState<MemorySection>('timeline')
  const [sourceTab, setSourceTab] = useState<SourceSubId>('conversation')
  const [organizeTab, setOrganizeTab] = useState<OrganizeSubId>('scenario')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState<{ query: string; result: MemorySearchResult } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 溯源跳转目标（原子记忆 → 文档详情 / 会话过滤），置位同时切到来源页对应子页。
  const [documentFocus, setDocumentFocus] = useState<string | null>(null)
  const [conversationFocus, setConversationFocus] = useState<string | null>(null)
  // 记忆引擎暂停闸（顶部「继续/暂停」）：null = 状态未知（gateway 不可达，按钮禁用）。
  const [ingestPaused, setIngestPaused] = useState<boolean | null>(null)
  const [ingestBusy, setIngestBusy] = useState(false)

  useEffect(() => {
    let active = true
    window.nxcore!.ingest.getPause()
      .then((state) => { if (active) setIngestPaused(state.paused) })
      .catch(() => { if (active) setIngestPaused(null) })
    return () => { active = false }
  }, [])

  const toggleIngest = async () => {
    if (ingestBusy || ingestPaused === null) return
    setIngestBusy(true)
    try {
      const next = await window.nxcore!.ingest.setPause(!ingestPaused)
      setIngestPaused(next.paused)
      setSearchError(null)
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : t('memory:memory.ingestToggleFailed'))
    } finally {
      setIngestBusy(false)
    }
  }

  // 侧边栏记忆管道点击跳转：映射到一级分区 + 二级子页。
  useEffect(() => {
    const openTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab: string }>).detail?.tab
      const target = tab ? SECTION_OF_TAB[tab] : undefined
      if (!target) return
      setSearch(null)
      setSection(target.section)
      if (target.section === 'sources') setSourceTab(target.sub as SourceSubId)
      if (target.section === 'organize') setOrganizeTab(target.sub as OrganizeSubId)
    }
    window.addEventListener(MEMORY_TAB_EVENT, openTab)
    return () => window.removeEventListener(MEMORY_TAB_EVENT, openTab)
  }, [])

  const openDocument = (documentId: string) => {
    setDocumentFocus(documentId)
    setSearch(null)
    setSection('sources')
    setSourceTab('documents')
  }
  const openConversation = (sessionId: string) => {
    setConversationFocus(sessionId)
    setSearch(null)
    setSection('sources')
    setSourceTab('conversation')
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
          <button
            type="button"
            className="mem-ingest-toggle"
            data-paused={ingestPaused === true || undefined}
            title={t(ingestPaused ? 'memory:memory.ingestResumeTitle' : 'memory:memory.ingestPauseTitle')}
            disabled={ingestBusy || ingestPaused === null}
            onClick={() => void toggleIngest()}
          >
            {ingestPaused ? <Play aria-hidden="true" strokeWidth={1.7} /> : <Pause aria-hidden="true" strokeWidth={1.7} />}
            <span>{t(ingestPaused ? 'memory:memory.ingestResume' : 'memory:memory.ingestPause')}</span>
          </button>
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
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={section === entry.id && !search}
            data-active={section === entry.id && !search}
            onClick={() => { setSection(entry.id); setSearch(null) }}
          >
            <span className="mem-tab-name">{t(entry.label)}</span>
          </button>
        ))}
      </nav>
      {searchError ? <p className="mem-inline-error">{searchError}</p> : null}
      {search ? (
        <MemorySearchResults
          query={search.query}
          result={search.result}
          onClear={() => { setSearch(null); setSearchText('') }}
          onOpenAtomic={() => { setSearch(null); setSection('timeline') }}
        />
      ) : searching ? (
        <p className="mem-loading">{t('memory:memory.searching')}</p>
      ) : section === 'timeline' ? (
        <div className="mem-content">
          <AtomicMemoryPane focusItemId={focusAtomicId} onOpenDocument={openDocument} onOpenConversation={openConversation} />
        </div>
      ) : section === 'sources' ? (
        <div className="mem-content mem-subpage">
          <div className="mem-subtabs" role="tablist" aria-label={t('memory:nav.sources')}>
            {SOURCE_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={sourceTab === entry.id}
                data-active={sourceTab === entry.id}
                onClick={() => setSourceTab(entry.id)}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
          {sourceTab === 'conversation' ? (
            <ConversationPane focusSessionId={conversationFocus} />
          ) : (
            <DocumentPane focusDocumentId={documentFocus} />
          )}
        </div>
      ) : (
        <div className="mem-content mem-subpage mem-subpage-organize">
          <aside className="mem-subnav" role="tablist" aria-label={t('memory:nav.organize')}>
            {ORGANIZE_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={organizeTab === entry.id}
                data-active={organizeTab === entry.id}
                onClick={() => setOrganizeTab(entry.id)}
              >
                {t(entry.label)}
              </button>
            ))}
          </aside>
          <div className="mem-subpage-body">
            {organizeTab === 'scenario' ? <ScenarioPane /> : null}
            {organizeTab === 'core' ? <CoreProfilePane /> : null}
            {organizeTab === 'writing-style' ? <WritingStylePane /> : null}
            {organizeTab === 'ledger' ? <IngestLedgerPane /> : null}
            {organizeTab === 'filter-rules' ? <FilterRulesPane /> : null}
            {organizeTab === 'org-preferences' ? <OrganizationPreferencePane /> : null}
          </div>
        </div>
      )}
    </div>
  )
}
