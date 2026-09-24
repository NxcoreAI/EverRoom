import { BookOpenText, ChevronDown, ChevronRight, FileText, ListTree, Network, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  WikiGraphCanvas,
  WIKI_CLUSTERS,
} from '../context-room/ported/components/WikiGraphCanvas'
import { MarkdownBody, resolveWikiLinkTarget } from '../context-room/ported/components/detail-panels/MarkdownBody'
import { FOLDER_LABEL_KEYS, WRAPPER_DIR_NAMES, WIKI_TREE_CARET_SLOT, WikiTree } from '../context-room/ported/components/detail-panels/WikiTree'
import type {
  KnowledgeRoomDto,
  KnowledgeWikiDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from '../../../../shared/knowledge'
import './WikiPage.css'
import { useLocale } from '@/i18n/LocaleContext'
import { localizedRoomKind } from '../context-room/ported/adapters'
import { formatRelative } from './sources/sourceKinds'

type WikiView = 'tree' | 'graph'

const WIKI_STATUS_LABELS: Record<string, string> = {
  none: 'surface:wiki.notCreated',
  pending: 'surface:wiki.pending',
  processing: 'surface:wiki.building',
  active: 'surface:wiki.ready',
  ready: 'surface:wiki.ready',
  error: 'surface:wiki.error',
}

function statusLabel(status: string): string {
  return WIKI_STATUS_LABELS[status] ?? status
}

/** ingest 自动建的 Room 用机名当标题（auto-xxxxxxxx），别让它当门面。 */
const AUTO_ROOM_TITLE_RE = /^auto-[0-9a-z-]{4,}$/i

/** 左栏/标题的 Room 展示名：机名 Room 用 KS 内容摘要首行代称（截 18 字），无摘要回退原名。 */
function roomDisplayName(room: KnowledgeRoomDto | undefined, wiki: KnowledgeWikiDto): string {
  const title = room?.title ?? wiki.roomId
  if (!AUTO_ROOM_TITLE_RE.test(title)) return title
  const firstLine = wiki.summary?.split('\n').find((line) => line.trim())?.trim() ?? null
  if (!firstLine) return title
  return firstLine.length > 18 ? `${firstLine.slice(0, 18)}…` : firstLine
}

/** overview 正文首段（剥掉 frontmatter 与 markdown 痕迹）——KS 摘要缺失时侧栏摘要卡的兜底来源。 */
function firstPlainTextParagraph(markdown: string): string | null {
  // ingest 会把 overview.md 连 YAML frontmatter 一起搬进来；不剥掉的话 --- 头会被压成一行当摘要
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
  for (const block of body.split(/\n\s*\n/)) {
    const trimmed = block.trim()
    if (!trimmed || /^[#>`|]/.test(trimmed) || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue
    const text = trimmed
      .replace(/\s*\n\s*/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`_]/g, '')
      .replace(/[[\]]/g, '')
      .trim()
    if (!text) continue
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  }
  return null
}

/** 核心视图默认只画被引最高的前 N 个节点（治"毛线球"：200 节点全画谁也读不出重点）。 */
const GRAPH_CORE_COUNT = 30

/** 左栏归档组的分组键（殿后，默认折叠）。 */
const ARCHIVED_GROUP_KEY = '__archived'

/**
 * 顶层 Wiki 应用（room-wiki 方案 M3c）：浏览全部 Room 的 wiki。
 * 左栏 wiki 清单（listWikis ⨝ listRooms），主区目录树/图谱切换 + 页面预览；
 * 只对选中 Room 拉页面，防 N+1。
 */
export function WikiPage() {
  const { t, locale } = useLocale()
  const knowledge = window.nxcore?.knowledge
  const [wikis, setWikis] = useState<KnowledgeWikiDto[]>([])
  const [roomsById, setRoomsById] = useState<Map<string, KnowledgeRoomDto>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [pages, setPages] = useState<KnowledgeWikiPageDto[]>([])
  const [pageStatus, setPageStatus] = useState<string>('loading')
  const [pagesLoading, setPagesLoading] = useState(false)
  const [selectedPage, setSelectedPage] = useState<KnowledgeWikiPageDto | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [view, setView] = useState<WikiView>('tree')
  const [graph, setGraph] = useState<KnowledgeWikiGraphDto | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphFailed, setGraphFailed] = useState(false)
  // 左栏分组折叠状态（归档组默认折叠）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set([ARCHIVED_GROUP_KEY]))
  const [treeQuery, setTreeQuery] = useState('')
  const [graphQuery, setGraphQuery] = useState('')
  // 图谱搜索防抖：布局 worker 按节点集重建，逐键重算太重
  const [graphFilter, setGraphFilter] = useState('')
  const [coreOnly, setCoreOnly] = useState(true)
  // 顶部切换器弹层 + 侧栏折叠（CSS 隐藏而非卸载，保住树的展开/滚动状态）
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switcherQuery, setSwitcherQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 面包屑点目录 → 展开定位（受控展开 + 滚动到该目录节点）
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const switcherRef = useRef<HTMLDivElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setGraphFilter(graphQuery), 200)
    return () => clearTimeout(timer)
  }, [graphQuery])

  // 切换器弹层：点外面 / Esc 关闭
  useEffect(() => {
    if (!switcherOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setSwitcherOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSwitcherOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [switcherOpen])

  // 面包屑定位目录：等树展开渲染后再滚动到目标节点
  useEffect(() => {
    if (!revealPath) return
    const timer = setTimeout(() => {
      sidebarRef.current?.querySelector(`[data-path="${revealPath}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 60)
    return () => clearTimeout(timer)
  }, [revealPath])

  const refreshList = useCallback(async () => {
    if (!knowledge) return
    try {
      const [wikiData, roomData] = await Promise.all([
        knowledge.listWikis(),
        knowledge.listRooms(),
      ])
      setWikis(wikiData.items)
      setRoomsById(new Map(roomData.items.map((room) => [room.id, room])))
      setSelectedRoomId((current) =>
        current && wikiData.items.some((wiki) => wiki.roomId === current)
          ? current
          : wikiData.items[0]?.roomId ?? null)
    } catch {
      setWikis([])
    } finally {
      setLoaded(true)
    }
  }, [knowledge])

  useEffect(() => {
    void refreshList()
    const onChanged = () => void refreshList()
    window.addEventListener('everroom:knowledge-changed', onChanged)
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged)
  }, [refreshList])

  // 选中 Room 的页面清单（懒加载：只拉当前 Room）
  useEffect(() => {
    setSelectedPage(null)
    setMarkdown(null)
    setGraph(null)
    setPages([])
    setPageStatus('loading')
    if (!knowledge || !selectedRoomId) return
    let cancelled = false
    setPagesLoading(true)
    knowledge.listWikiPages(selectedRoomId)
      .then((data) => {
        if (cancelled) return
        setPageStatus(data.status)
        setPages(data.items)
        // 默认落地概览页：消灭"从目录选择一个页面阅读"空态，第一屏就是可读内容
        setSelectedPage((current) =>
          current ?? data.items.find((page) => page.path.endsWith('overview.md')) ?? null)
      })
      .catch(() => {
        if (!cancelled) setPageStatus('error')
      })
      .finally(() => {
        if (!cancelled) setPagesLoading(false)
      })
    return () => { cancelled = true }
  }, [knowledge, selectedRoomId])

  // 页面正文（选中页时拉取）
  useEffect(() => {
    setMarkdown(null)
    if (!knowledge || !selectedRoomId || !selectedPage) return
    let cancelled = false
    knowledge.readWikiPage(selectedRoomId, selectedPage.path)
      .then((data) => {
        if (!cancelled) setMarkdown(data.markdown)
      })
      .catch(() => {
        if (!cancelled) setMarkdown('')
      })
    return () => { cancelled = true }
  }, [knowledge, selectedRoomId, selectedPage])

  // 图谱懒加载：首次切到图谱视图才拉；失败不缓存成空图（会被守卫挡住
  // 永不重拉，一次瞬时故障 = 图谱空白直到刷新页面），落 graphFailed 给重试。
  useEffect(() => {
    if (view !== 'graph' || graph || graphLoading || graphFailed || pages.length === 0) return
    if (!knowledge || !selectedRoomId) return
    setGraphLoading(true)
    setGraphFailed(false)
    knowledge.getWikiGraph(selectedRoomId)
      .then((data) => setGraph(data))
      .catch(() => {
        setGraph(null)
        setGraphFailed(true)
      })
      .finally(() => setGraphLoading(false))
  }, [view, graph, graphLoading, graphFailed, pages.length, knowledge, selectedRoomId])

  const openPage = (page: KnowledgeWikiPageDto) => {
    setSelectedPage(page)
  }

  // 正文 [[双链]]/相对 md 链接 → 同 Room 内换页（与服务端图谱同一解析规则）
  const openWikiLink = useCallback((target: string) => {
    const page = resolveWikiLinkTarget(target, pages)
    if (page) setSelectedPage(page)
  }, [pages])

  const closePage = useCallback(() => {
    setSelectedPage(null)
    setMarkdown(null)
  }, [])

  useEffect(() => {
    if (view !== 'graph' || !selectedPage) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePage()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closePage, selectedPage, view])

  const selectedWiki = wikis.find((wiki) => wiki.roomId === selectedRoomId) ?? null
  const selectedRoom = selectedRoomId ? roomsById.get(selectedRoomId) : undefined
  const selectedDisplayName = selectedWiki
    ? roomDisplayName(selectedRoom, selectedWiki)
    : (selectedRoom?.title ?? selectedRoomId ?? '')
  // 侧栏摘要卡：KS 摘要优先；缺失时用当前已加载的 overview 正文首段兜底
  const overviewPath = pages.find((page) => page.path.endsWith('overview.md'))?.path ?? null
  const sidebarSummary = selectedWiki?.summary
    ?? (selectedPage && overviewPath && selectedPage.path === overviewPath && markdown
      ? firstPlainTextParagraph(markdown)
      : null)

  // 面包屑：wiki 名 › 本地化目录 › 页面标题；点 wiki 名回概览页，点目录展开并定位树节点
  const crumbs: Array<{ label: string; onClick: () => void }> = [{
    label: selectedDisplayName || t('surface:wiki.selectWiki'),
    onClick: () => {
      const overview = pages.find((page) => page.path.endsWith('overview.md'))
      if (overview) openPage(overview)
    },
  }]
  if (view === 'graph') {
    crumbs.push({ label: t('surface:wiki.graph'), onClick: () => {} })
  } else if (selectedPage) {
    const segments = selectedPage.path.split('/').filter(Boolean)
    const fileName = segments.pop() ?? ''
    let folderPath = ''
    for (const segment of segments) {
      folderPath += `${segment}/`
      if (WRAPPER_DIR_NAMES.has(segment)) continue
      const path = folderPath
      crumbs.push({
        label: t(FOLDER_LABEL_KEYS[segment] ?? segment),
        onClick: () => {
          setSidebarCollapsed(false)
          setRevealPath(path)
        },
      })
    }
    crumbs.push({ label: selectedPage.title || fileName, onClick: () => {} })
  }

  // 左栏清单分组：归档殿后，其余按 kind 首现顺序分组；组内最近更新优先（无时间殿后）。
  const wikiGroups = useMemo(() => {
    const buckets = new Map<string, KnowledgeWikiDto[]>()
    for (const wiki of wikis) {
      const room = roomsById.get(wiki.roomId)
      const key = wiki.status === 'archived'
        ? ARCHIVED_GROUP_KEY
        : (room?.kind || 'Room')
      const list = buckets.get(key)
      if (list) list.push(wiki)
      else buckets.set(key, [wiki])
    }
    if (buckets.has(ARCHIVED_GROUP_KEY)) {
      const archived = buckets.get(ARCHIVED_GROUP_KEY)!
      buckets.delete(ARCHIVED_GROUP_KEY)
      buckets.set(ARCHIVED_GROUP_KEY, archived)
    }
    return [...buckets.entries()].map(([kind, items]) => ({
      kind,
      label: kind === ARCHIVED_GROUP_KEY
        ? t('surface:wiki.groupArchived')
        : (localizedRoomKind(kind, t) || t('contextRoom:display.room')),
      items: [...items].sort((a, b) => {
        const at = a.updatedAt ? Date.parse(a.updatedAt) : 0
        const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0
        return bt - at
          || (roomsById.get(a.roomId)?.title ?? a.roomId)
            .localeCompare(roomsById.get(b.roomId)?.title ?? b.roomId)
      }),
    }))
  }, [wikis, roomsById, t])

  // 顶部切换器搜索：按展示名 + 机名过滤分组清单，空查询用原分组
  const switcherGroups = useMemo(() => {
    const query = switcherQuery.trim().toLowerCase()
    if (!query) return wikiGroups
    return wikiGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((wiki) => {
          const room = roomsById.get(wiki.roomId)
          const name = roomDisplayName(room, wiki)
          return name.toLowerCase().includes(query)
            || (room?.title ?? '').toLowerCase().includes(query)
            || wiki.roomId.toLowerCase().includes(query)
        }),
      }))
      .filter((group) => group.items.length > 0)
  }, [wikiGroups, roomsById, switcherQuery])

  // 目录搜索：平铺匹配（标题/路径包含），不进树
  const filteredTreePages = useMemo(() => {
    const query = treeQuery.trim().toLowerCase()
    if (!query) return []
    return pages.filter((page) =>
      page.title.toLowerCase().includes(query) || page.path.toLowerCase().includes(query))
  }, [pages, treeQuery])

  // 图谱降噪：默认只画被引 Top N 核心；搜索时在全量里过滤（不受核心限制）。
  const searching = graphFilter.trim().length > 0
  const displayGraph = useMemo((): KnowledgeWikiGraphDto | null => {
    if (!graph) return null
    if (!searching && !coreOnly) return graph
    let nodes = graph.nodes
    if (searching) {
      const query = graphFilter.trim().toLowerCase()
      nodes = nodes.filter((node) =>
        node.title.toLowerCase().includes(query) || node.path.toLowerCase().includes(query))
    } else {
      const coreIds = new Set(
        [...nodes]
          .sort((a, b) => b.inLinks - a.inLinks || a.title.localeCompare(b.title))
          .slice(0, GRAPH_CORE_COUNT)
          .map((node) => node.id),
      )
      nodes = nodes.filter((node) => coreIds.has(node.id))
    }
    const ids = new Set(nodes.map((node) => node.id))
    return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
  }, [graph, coreOnly, graphFilter, searching])

  return (
    <div className="page wiki-page">
      {!loaded ? (
        <div className="wiki-empty">{t('surface:wiki.loading')}</div>
      ) : !knowledge ? (
        <div className="wiki-empty">{t('surface:wiki.knowledgeServiceUnavailable')}</div>
      ) : wikis.length === 0 ? (
        <div className="wiki-empty">
          <BookOpenText aria-hidden="true" strokeWidth={1.6} />
          {t('surface:wiki.noWikisYetTheyAreGeneratedAsRooms')}
        </div>
      ) : (
        <div className={`wiki-body${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
          <div className="wiki-topbar">
            <div className="wiki-switcher" ref={switcherRef}>
              <button
                type="button"
                className="wiki-switcher-button"
                aria-haspopup="listbox"
                aria-expanded={switcherOpen}
                onClick={() => setSwitcherOpen((open) => !open)}
              >
                <BookOpenText aria-hidden="true" strokeWidth={1.7} />
                <strong>{selectedDisplayName || t('surface:wiki.selectWiki')}</strong>
                {selectedWiki?.pageCount != null ? (
                  <span className="wiki-switcher-count">{t('surface:wiki.listPageCount', { count: selectedWiki.pageCount })}</span>
                ) : null}
                <ChevronDown aria-hidden="true" strokeWidth={1.8} className="wiki-switcher-caret" />
              </button>
              {switcherOpen ? (
                <div className="wiki-switcher-popover">
                  <label className="wiki-tree-search wiki-switcher-search">
                    <Search aria-hidden="true" strokeWidth={1.7} />
                    <input
                      value={switcherQuery}
                      onChange={(event) => setSwitcherQuery(event.target.value)}
                      placeholder={t('surface:wiki.switcherSearchPlaceholder')}
                      aria-label={t('surface:wiki.switcherSearchPlaceholder')}
                    />
                  </label>
                  {switcherGroups.length === 0 ? (
                    <div className="wiki-tree-no-match">{t('surface:wiki.switcherNoMatches')}</div>
                  ) : (
                  switcherGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.kind)
              return (
                <section key={group.kind} className="wiki-room-group">
                  <button
                    type="button"
                    className="wiki-room-group-header"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedGroups((current) => {
                      const next = new Set(current)
                      if (next.has(group.kind)) next.delete(group.kind)
                      else next.add(group.kind)
                      return next
                    })}
                  >
                    {collapsed
                      ? <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                      : <ChevronDown aria-hidden="true" strokeWidth={1.8} />}
                    <span>{group.label}</span>
                    <span className="wiki-room-group-count">{group.items.length}</span>
                  </button>
                  {collapsed ? null : group.items.map((wiki) => {
                    const room = roomsById.get(wiki.roomId)
                    // 价值信号行：状态 · 页面数 · 最近更新（无信号项自动省略）
                    const meta = [
                      t(statusLabel(wiki.status)),
                      wiki.pageCount != null ? t('surface:wiki.listPageCount', { count: wiki.pageCount }) : null,
                      wiki.updatedAt ? formatRelative(wiki.updatedAt, locale) : null,
                    ].filter(Boolean).join(' · ')
                    return (
                      <button
                        type="button"
                        key={wiki.roomId}
                        className={`wiki-room-item${wiki.roomId === selectedRoomId ? ' is-selected' : ''}`}
                        onClick={() => {
                          setSelectedRoomId(wiki.roomId)
                          setSwitcherOpen(false)
                          setSwitcherQuery('')
                          setRevealPath(null)
                        }}
                      >
                        <strong>{roomDisplayName(room, wiki)}</strong>
                        <span>{meta}</span>
                      </button>
                    )
                  })}
                  </section>
                  )
                })
                  )}
                </div>
              ) : null}
            </div>
            <nav className="wiki-crumbs" aria-label={t('surface:wiki.breadcrumb')}>
              {crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1
                return (
                  <span key={`${crumb.label}-${index}`} className="wiki-crumb">
                    {index > 0 ? <span className="wiki-crumb-sep" aria-hidden="true">›</span> : null}
                    {isLast
                      ? <span className="wiki-crumb-current" title={crumb.label}>{crumb.label}</span>
                      : (
                        <button
                          type="button"
                          className="wiki-crumb-link"
                          title={crumb.label}
                          onClick={crumb.onClick}
                        >
                          {crumb.label}
                        </button>
                      )}
                  </span>
                )
              })}
            </nav>
            <span className="wiki-topbar-actions">
              <div className="wiki-toggle" role="tablist" aria-label={t('surface:wiki.wikiView')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'tree'}
                  className={view === 'tree' ? 'is-active' : ''}
                  onClick={() => setView('tree')}
                >
                  <ListTree aria-hidden="true" />
                  {t('surface:wiki.pages')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'graph'}
                  className={view === 'graph' ? 'is-active' : ''}
                  onClick={() => setView('graph')}
                >
                  <Network aria-hidden="true" />
                  {t('surface:wiki.graph')}
                </button>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSidebarCollapsed((value) => !value)}
                title={sidebarCollapsed ? t('surface:wiki.expandSidebar') : t('surface:wiki.collapseSidebar')}
                aria-label={sidebarCollapsed ? t('surface:wiki.expandSidebar') : t('surface:wiki.collapseSidebar')}
                aria-pressed={sidebarCollapsed}
              >
                {sidebarCollapsed
                  ? <PanelLeftOpen aria-hidden="true" strokeWidth={1.8} />
                  : <PanelLeftClose aria-hidden="true" strokeWidth={1.8} />}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => void refreshList()}
                disabled={!knowledge}
                title={t('surface:wiki.refresh')}
                aria-label={t('surface:wiki.refresh')}
              >
                <RefreshCw aria-hidden="true" strokeWidth={1.8} />
              </button>
            </span>
          </div>

          <aside ref={sidebarRef} className="wiki-sidebar" aria-label={t('surface:wiki.pages')}>
                    {pagesLoading ? (
                      <div className="wiki-empty">{t('surface:wiki.loading')}</div>
                    ) : pageStatus === 'error' ? (
                      <div className="wiki-empty">{t('surface:wiki.knowledgeServiceUnavailable')}</div>
                    ) : pageStatus === 'none' ? (
                      <div className="wiki-empty">{t('surface:wiki.thisRoomHasNoCapturedKnowledgeYet')}</div>
                    ) : pageStatus === 'processing' || pageStatus === 'pending' ? (
                      <div className="wiki-empty">{t('surface:wiki.theKnowledgeBaseIsBeingBuiltRefreshIn')}</div>
                    ) : pages.length === 0 ? (
                      <div className="wiki-empty">{t('surface:wiki.noPagesYet')}</div>
                    ) : (
                      <>
                        {sidebarSummary ? (
                          <p className="wiki-summary-card">{sidebarSummary}</p>
                        ) : null}
                        <label className="wiki-tree-search">
                          <Search aria-hidden="true" strokeWidth={1.7} />
                          <input
                            value={treeQuery}
                            onChange={(event) => setTreeQuery(event.target.value)}
                            placeholder={t('surface:wiki.treeSearchPlaceholder')}
                            aria-label={t('surface:wiki.treeSearchPlaceholder')}
                          />
                        </label>
                        {treeQuery.trim() ? (
                          filteredTreePages.length === 0 ? (
                            <div className="wiki-tree-no-match">{t('surface:wiki.treeNoMatches')}</div>
                          ) : (
                            <ul className="context-room-wiki-tree">
                              {filteredTreePages.map((page) => (
                                <li key={page.path}>
                                  <button
                                    type="button"
                                    className="context-room-wiki-tree-node"
                                    data-selected={page.path === selectedPage?.path || undefined}
                                    title={page.description || page.title || page.path}
                                    onClick={() => openPage(page)}
                                  >
                                    <span aria-hidden="true" style={{ width: WIKI_TREE_CARET_SLOT, flex: '0 0 auto' }} />
                                    <BookOpenText aria-hidden="true" strokeWidth={1.7} />
                                    <span className="context-room-wiki-tree-name">{page.title || page.path}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )
                        ) : (
                          <WikiTree pages={pages} selectedPath={selectedPage?.path ?? null} onSelect={openPage} revealPath={revealPath} />
                        )}
                      </>
                    )}
                  </aside>
                  <section className="wiki-main">
                    {view === 'tree' ? (
                  <div className="wiki-preview">
                    {selectedPage ? (
                      <>
                        <header className="wiki-preview-header">
                          <strong title={selectedPage.title}>{selectedPage.title}</strong>
                          <span title={selectedPage.path}>{selectedPage.path}</span>
                        </header>
                        {markdown === null ? t('surface:wiki.loading') : <MarkdownBody markdown={markdown} onWikiLink={openWikiLink} />}
                      </>
                    ) : (
                      <div className="wiki-empty">{t('surface:wiki.selectAPageFromTheTreeToRead')}</div>
                    )}
                  </div>
              ) : (
                <div className="wiki-graph-pane">
                  {graphLoading ? (
                    <div className="wiki-empty">{t('surface:wiki.buildingGraph')}</div>
                  ) : graphFailed ? (
                    <div className="wiki-empty wiki-graph-error">
                      <span>{t('surface:wiki.failedToLoadGraph')}</span>
                      <button type="button" className="wiki-graph-retry" onClick={() => setGraphFailed(false)}>
                        {t('surface:wiki.retry')}
                      </button>
                    </div>
                  ) : graph && graph.nodes.length > 0 ? (
                    <>
                      {displayGraph && displayGraph.nodes.length > 0 ? (
                        <WikiGraphCanvas
                          graph={displayGraph}
                          selectedPath={selectedPage?.path ?? null}
                          onSelectPage={(path) => {
                            const page = pages.find((candidate) => candidate.path === path)
                            if (page) openPage(page)
                          }}
                        />
                      ) : (
                        <div className="wiki-graph-no-match">{t('surface:wiki.graphNoMatches')}</div>
                      )}
                      <div className="wiki-graph-overlay">
                        <label className="wiki-graph-search">
                          <Search aria-hidden="true" strokeWidth={1.7} />
                          <input
                            value={graphQuery}
                            onChange={(event) => setGraphQuery(event.target.value)}
                            placeholder={t('surface:wiki.graphSearchPlaceholder')}
                            aria-label={t('surface:wiki.graphSearchPlaceholder')}
                          />
                          {graphQuery ? (
                            <button
                              type="button"
                              className="wiki-graph-search-clear"
                              aria-label={t('surface:wiki.close')}
                              onClick={() => setGraphQuery('')}
                            >
                              <X aria-hidden="true" strokeWidth={1.8} />
                            </button>
                          ) : null}
                        </label>
                        <div className="wiki-graph-legend" aria-label={t('surface:wiki.graphLegend')}>
                          {WIKI_CLUSTERS.map((cluster) => (
                            <span key={cluster.key} className="wiki-graph-legend-item" data-cluster={cluster.key}>
                              {t(cluster.labelKey)}
                            </span>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="wiki-graph-mode"
                          title={coreOnly ? t('surface:wiki.graphShowAll') : t('surface:wiki.graphCoreOnly')}
                          onClick={() => setCoreOnly((value) => !value)}
                        >
                          {coreOnly ? t('surface:wiki.graphShowAll') : t('surface:wiki.graphCoreOnly')}
                        </button>
                      </div>
                      <div className="wiki-graph-stats" aria-label={t('surface:wiki.graphStatistics')}>
                        <span>{t('surface:wiki.countPages', { count: (displayGraph ?? graph).nodes.length })}</span>
                        <span>{t('surface:wiki.countInternalLinks', { count: (displayGraph ?? graph).edges.length })}</span>
                      </div>
                      {selectedPage ? (
                        <aside className="wiki-node-drawer" aria-label={t('surface:wiki.wikiNodeDetails')}>
                          <header>
                            <div className="wiki-node-drawer-title">
                              <span className="wiki-node-drawer-icon">
                                <FileText aria-hidden="true" />
                              </span>
                              <div>
                                <strong title={selectedPage.title}>{selectedPage.title}</strong>
                                <span title={selectedPage.path}>{selectedPage.path}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="wiki-node-drawer-close"
                              aria-label={t('surface:wiki.closeNodeDetails')}
                              title={t('surface:wiki.close')}
                              onClick={closePage}
                            >
                              <X aria-hidden="true" />
                            </button>
                          </header>
                          {selectedPage.description ? (
                            <p className="wiki-node-drawer-description">{selectedPage.description}</p>
                          ) : null}
                          <div className="wiki-node-drawer-body">
                            {markdown === null ? (
                              <div className="wiki-node-drawer-loading">{t('surface:wiki.loading')}</div>
                            ) : (
                              <MarkdownBody markdown={markdown} onWikiLink={openWikiLink} />
                            )}
                          </div>
                        </aside>
                      ) : null}
                    </>
                  ) : (
                    <div className="wiki-empty">{t('surface:wiki.thereAreNoLinksBetweenPagesYet')}</div>
                  )}
                </div>
              )}
          </section>
        </div>
      )}
    </div>
  )
}
