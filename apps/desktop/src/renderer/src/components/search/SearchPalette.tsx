import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { LocalAgentInstallation } from '@nxcore/agent-contract'
import type { SearchHitDto, SearchItemType, SearchMessageContextDto, SearchPageDto } from '../../../../shared/search'
import { useLocale } from '@/i18n/LocaleContext'
import { FilterSelect } from '@/components/ui/FilterSelect'
import { splitHighlight } from './search-highlight'
import './search-i18n'
import './SearchPalette.css'

export interface SearchPaletteProps {
  open: boolean
  onClose: () => void
  rooms: Array<{ id: string; title: string }>
  onOpenFile: (fileId: string) => void
  onOpenRoom: (roomId: string, title: string) => void
  onOpenSession: (hit: SearchHitDto) => void
  onAttach: (hit: SearchHitDto) => void
  onDispatch: (hit: SearchHitDto, agent: LocalAgentInstallation | null, instruction: string) => void
}

type TypeFilter = 'all' | SearchItemType
type TimeRange = 'all' | 'today' | 'days7' | 'days30'

const TYPE_FILTERS: Array<{ value: TypeFilter; key: string }> = [
  { value: 'all', key: 'search:type.all' },
  { value: 'file', key: 'search:type.file' },
  { value: 'message', key: 'search:type.message' },
  { value: 'room', key: 'search:type.room' },
  { value: 'document', key: 'search:type.document' },
]

function rangeToFromTo(range: TimeRange): { from?: number; to?: number } {
  const now = Date.now()
  if (range === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime(), to: now + 60_000 }
  }
  if (range === 'days7') return { from: now - 7 * 86_400_000, to: now + 60_000 }
  if (range === 'days30') return { from: now - 30 * 86_400_000, to: now + 60_000 }
  return {}
}

export function SearchPalette({
  open,
  onClose,
  rooms,
  onOpenFile,
  onOpenRoom,
  onOpenSession,
  onAttach,
  onDispatch,
}: SearchPaletteProps) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [roomFilter, setRoomFilter] = useState('')
  const [timeBasis, setTimeBasis] = useState<'occurred' | 'ingested'>('ingested')
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [page, setPage] = useState<SearchPageDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prioritized, setPrioritized] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Map<string, SearchMessageContextDto>>(() => new Map())
  const [dispatchPick, setDispatchPick] = useState<SearchHitDto | null>(null)
  const [dispatchAgents, setDispatchAgents] = useState<LocalAgentInstallation[]>([])
  const [dispatchAgentId, setDispatchAgentId] = useState('')
  const [dispatchInstruction, setDispatchInstruction] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)
  const resultsRef = useRef<HTMLDivElement>(null)

  const fetchPage = useCallback(async (currentQuery: string) => {
    const api = window.nxcore?.search
    if (!api) return
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const { from, to } = rangeToFromTo(timeRange)
      const result = await api.invoke({
        query: currentQuery,
        ...(typeFilter !== 'all' ? { types: [typeFilter] } : {}),
        ...(roomFilter ? { roomIds: [roomFilter] } : {}),
        timeBasis,
        ...(from !== undefined && to !== undefined ? { from, to } : {}),
        limit: 30,
        offset: 0,
      })
      if (seqRef.current !== seq) return
      setPage(result)
    } catch (cause) {
      if (seqRef.current !== seq) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setPage(null)
    } finally {
      if (seqRef.current === seq) setLoading(false)
    }
  }, [roomFilter, timeBasis, timeRange, typeFilter])

  useEffect(() => {
    if (!open) return
    void fetchPage(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typeFilter, roomFilter, timeBasis, timeRange])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void fetchPage(query), 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // 索引仍在消化时轮询补齐（结果按稳定 id 原位刷新）。scope 缺失（旧网关/降级数据面）不轮询。
  useEffect(() => {
    if (!open) return
    const pending = page?.scope?.pendingCount ?? 0
    if (pending === 0) return
    const timer = window.setInterval(() => void fetchPage(query), 3_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page?.scope?.pendingCount])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!dispatchPick || dispatchAgents.length > 0) return
    void window.nxcore?.agent?.discoverLocalAgents?.().then((agents) => {
      if (agents?.length) setDispatchAgents(agents)
    }).catch(() => {})
  }, [dispatchPick, dispatchAgents.length])

  const openHit = useCallback((hit: SearchHitDto) => {
    if (hit.itemType === 'file') onOpenFile(hit.refId)
    else if (hit.itemType === 'message') onOpenSession(hit)
    else if (hit.itemType === 'room') onOpenRoom(hit.refId, hit.title)
    else if (hit.itemType === 'document' && hit.roomIds[0]) onOpenRoom(hit.roomIds[0], hit.title)
    onClose()
  }, [onClose, onOpenFile, onOpenRoom, onOpenSession])

  const expandContext = useCallback(async (hit: SearchHitDto) => {
    const api = window.nxcore?.search
    if (!api) return
    if (expanded.has(hit.id)) {
      const next = new Map(expanded)
      next.delete(hit.id)
      setExpanded(next)
      return
    }
    try {
      const context = await api.messageContext(hit.refId)
      setExpanded((current) => new Map(current).set(hit.id, context))
    } catch {
      /* 网关暂不可达时静默，结果列表保持可用 */
    }
  }, [expanded])

  const prioritize = useCallback(async (hit: SearchHitDto) => {
    const api = window.nxcore?.search
    if (!api) return
    try {
      await api.prioritize(hit.itemType, hit.refId)
      setPrioritized((current) => new Set(current).add(hit.id))
    } catch {
      /* 已入队/已完成的重复请求按成功对待 */
    }
  }, [])

  const submitDispatch = useCallback(() => {
    if (!dispatchPick) return
    const agent = dispatchAgents.find((item) => item.id === dispatchAgentId) ?? null
    onDispatch(dispatchPick, agent, dispatchInstruction)
    setDispatchPick(null)
    setDispatchInstruction('')
    onClose()
  }, [dispatchAgentId, dispatchAgents, dispatchInstruction, dispatchPick, onClose, onDispatch])

  const roomTitleById = useMemo(() => new Map(rooms.map((room) => [room.id, room.title])), [rooms])
  const items = page?.items ?? []
  const state = loading ? 'loading' : error ? 'error' : query.trim() && items.length === 0 ? 'empty' : 'initial'

  if (!open) return null

  return (
    <div className="search-palette-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="search-palette" role="dialog" aria-modal="true">
        <div className="search-palette-input-row">
          <Search className="search-palette-input-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            className="search-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && items[0]) openHit(items[0])
            }}
            placeholder={t('search:palette.placeholder')}
          />
        </div>

        <div className="search-palette-filters">
          {TYPE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`search-chip ${typeFilter === item.value ? 'search-chip-active' : ''}`}
              onClick={() => setTypeFilter(item.value)}
            >{t(item.key)}</button>
          ))}
          <FilterSelect
            value={roomFilter}
            options={[{ value: '', label: t('search:filter.roomAll') }, ...rooms.map((room) => ({ value: room.id, label: room.title }))]}
            onChange={setRoomFilter}
            ariaLabel={t('search:filter.roomAll')}
          />
          <FilterSelect
            value={timeRange}
            options={[
              { value: 'all', label: t('search:filter.range.all') },
              { value: 'today', label: t('search:filter.range.today') },
              { value: 'days7', label: t('search:filter.range.days7') },
              { value: 'days30', label: t('search:filter.range.days30') },
            ]}
            onChange={setTimeRange}
            ariaLabel={t('search:filter.range.all')}
          />
          <FilterSelect
            value={timeBasis}
            options={[
              { value: 'occurred', label: t('search:filter.basisOccurred') },
              { value: 'ingested', label: t('search:filter.basisIngested') },
            ]}
            onChange={setTimeBasis}
            ariaLabel={t('search:filter.basisIngested')}
          />
        </div>

        <div className="search-palette-results" ref={resultsRef}>
          {state !== 'initial' && items.length === 0 && (
            <div className="search-palette-state">
              {state === 'loading' ? t('search:state.loading') : state === 'error' ? `${t('search:state.error')}：${error}` : t('search:state.empty')}
            </div>
          )}
          {items.map((hit) => (
            <SearchHitRow
              key={hit.id}
              hit={hit}
              query={query}
              roomTitleById={roomTitleById}
              prioritized={prioritized.has(hit.id)}
              context={expanded.get(hit.id)}
              onOpen={openHit}
              onAttach={onAttach}
              onDispatch={(target) => { setDispatchPick(target) }}
              onExpand={expandContext}
              onPrioritize={prioritize}
            />
          ))}
        </div>

        {dispatchPick && (
          <div className="search-palette-dispatch">
            <div className="search-palette-dispatch-title">{t('search:dispatch.title')}：{dispatchPick.title}</div>
            <div className="search-palette-dispatch-row">
              <FilterSelect
                value={dispatchAgentId}
                options={[{ value: '', label: 'main' }, ...dispatchAgents.map((agent) => ({ value: agent.id, label: agent.displayName }))]}
                onChange={setDispatchAgentId}
                ariaLabel={t('search:dispatch.title')}
              />
              <input
                className="search-palette-dispatch-input"
                value={dispatchInstruction}
                onChange={(event) => setDispatchInstruction(event.target.value)}
                placeholder={t('search:dispatch.placeholder')}
              />
              <button type="button" className="search-action" onClick={submitDispatch}>
                {dispatchPick.itemType === 'file' ? t('search:dispatch.sendWithFile') : t('search:dispatch.send')}
              </button>
              <button type="button" className="search-action search-action-ghost" onClick={() => setDispatchPick(null)}>✕</button>
            </div>
          </div>
        )}

        <div className="search-palette-footer">
          {page?.scope && (
            <>
              <span>{t('search:palette.scopeReady', { count: page.scope.indexedCount })}</span>
              {page.scope.pendingCount > 0 && (
                <span className="search-palette-pending">{t('search:palette.scopePending', { count: page.scope.pendingCount })}</span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface SearchHitRowProps {
  hit: SearchHitDto
  query: string
  roomTitleById: Map<string, string>
  prioritized: boolean
  context?: SearchMessageContextDto
  onOpen: (hit: SearchHitDto) => void
  onAttach: (hit: SearchHitDto) => void
  onDispatch: (hit: SearchHitDto) => void
  onExpand: (hit: SearchHitDto) => void
  onPrioritize: (hit: SearchHitDto) => void
}

const SearchHitRow = memo(function SearchHitRow({
  hit,
  query,
  roomTitleById,
  prioritized,
  context,
  onOpen,
  onAttach,
  onDispatch,
  onExpand,
  onPrioritize,
}: SearchHitRowProps) {
  const { t } = useLocale()
  const time = hit.timeBasis === 'occurred' && hit.occurredAt ? hit.occurredAt : hit.ingestedAt
  const basisLabel = hit.timeBasis === 'occurred' ? t('search:hit.basisOccurred') : t('search:hit.basisIngested')
  const roomBadges = hit.roomIds.slice(0, 2)
    .map((roomId) => roomTitleById.get(roomId))
    .filter((title): title is string => Boolean(title))

  return (
    <div className="search-hit">
      <button type="button" className="search-hit-main" onClick={() => onOpen(hit)}>
        <div className="search-hit-title">
          <Highlighted text={hit.title} query={query} />
        </div>
        {hit.snippet && (
          <div className="search-hit-snippet">
            <Highlighted text={hit.snippet} query={query} />
          </div>
        )}
        <div className="search-hit-meta">
          <span>{t(`search:type.${hit.itemType === 'document' ? 'document' : hit.itemType}`)}</span>
          {hit.versionLabel && <span>{hit.versionLabel}</span>}
          {roomBadges.map((title) => <span key={title} className="search-hit-room">{title}</span>)}
          <span>{basisLabel} {new Date(time).toLocaleDateString()}</span>
        </div>
      </button>
      <div className="search-hit-actions">
        <button type="button" className="search-action" onClick={() => onOpen(hit)}>{t(`search:hit.open.${hit.itemType}`)}</button>
        {hit.itemType === 'file' && (
          <button type="button" className="search-action" onClick={() => onAttach(hit)}>{t('search:hit.attach')}</button>
        )}
        <button type="button" className="search-action" onClick={() => onDispatch(hit)}>{t('search:hit.dispatch')}</button>
        {hit.itemType === 'message' && (
          <button type="button" className="search-action" onClick={() => void onExpand(hit)}>
            {context ? t('search:hit.collapse') : t('search:hit.expand')}
          </button>
        )}
        {hit.status === 'meta_only' && !prioritized && (
          <button type="button" className="search-action search-action-priority" onClick={() => void onPrioritize(hit)}>
            {t('search:hit.priority')}
          </button>
        )}
        {hit.status === 'meta_only' && prioritized && (
          <span className="search-hit-meta-chip">{t('search:hit.priorityDone')}</span>
        )}
      </div>
      {hit.status === 'meta_only' && !hit.snippet && (
        <div className="search-hit-meta-chip">{t('search:hit.statusMetaOnly')}</div>
      )}
      {context && (
        <div className="search-hit-context">
          {context.messages.map((message) => (
            <div key={message.id} className="search-hit-context-message">
              <span className="search-hit-context-role">
                {message.role === 'user' ? t('search:hit.roleUser') : t('search:hit.roleAssistant')}
              </span>
              <span className="search-hit-context-body">{message.content.slice(0, 400)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => splitHighlight(text, query), [text, query])
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit
          ? <mark key={index} className="search-hit-mark">{segment.text}</mark>
          : <span key={index}>{segment.text}</span>,
      )}
    </>
  )
}
