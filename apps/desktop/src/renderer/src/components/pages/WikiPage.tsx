import { BookOpenText, FileText, ListTree, Network, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  WikiGraphCanvas,
} from '../context-room/ported/components/WikiGraphCanvas'
import { MarkdownBody } from '../context-room/ported/components/detail-panels/MarkdownBody'
import { WikiTree } from '../context-room/ported/components/detail-panels/WikiTree'
import type {
  KnowledgeRoomDto,
  KnowledgeWikiDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from '../../../../shared/knowledge'
import './WikiPage.css'
import { useLocale } from '@/i18n/LocaleContext'
import { uiText } from '../context-room/ported/adapters'

type WikiView = 'tree' | 'graph'

const WIKI_STATUS_LABELS: Record<string, string> = {
  none: 'surface:wiki.notCreated',
  pending: 'surface:wiki.pending',
  processing: 'surface:wiki.building',
  ready: 'surface:wiki.ready',
  error: 'surface:wiki.error',
}

function statusLabel(status: string): string {
  return WIKI_STATUS_LABELS[status] ?? status
}

/**
 * 顶层 Wiki 应用（room-wiki 方案 M3c）：浏览全部 Room 的 wiki。
 * 左栏 wiki 清单（listWikis ⨝ listRooms），主区目录树/图谱切换 + 页面预览；
 * 只对选中 Room 拉页面，防 N+1。
 */
export function WikiPage() {
  const { t } = useLocale()
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

  // 图谱懒加载：首次切到图谱视图才拉
  useEffect(() => {
    if (view !== 'graph' || graph || graphLoading || pages.length === 0) return
    if (!knowledge || !selectedRoomId) return
    setGraphLoading(true)
    knowledge.getWikiGraph(selectedRoomId)
      .then((data) => setGraph(data))
      .catch(() => setGraph({ nodes: [], edges: [] }))
      .finally(() => setGraphLoading(false))
  }, [view, graph, graphLoading, pages.length, knowledge, selectedRoomId])

  const openPage = (page: KnowledgeWikiPageDto) => {
    setSelectedPage(page)
  }

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
  const selectedRoomTitle = selectedRoomId ? roomsById.get(selectedRoomId)?.title : undefined

  return (
    <div className="page wiki-page">
      <header className="page-header">
        <div>
          <h1>Wiki</h1>
          <p>{t('surface:wiki.browseKnowledgeCapturedInEachRoomAsA')}</p>
        </div>
        <span className="page-header-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void refreshList()}
            disabled={!knowledge}
          >
            <RefreshCw aria-hidden="true" strokeWidth={1.8} />
            {t('surface:wiki.refresh')}
          </button>
        </span>
      </header>

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
        <div className="wiki-body">
          <aside className="wiki-room-list" aria-label={t('surface:wiki.roomWikiList')}>
            {wikis.map((wiki) => {
              const room = roomsById.get(wiki.roomId)
              return (
                <button
                  type="button"
                  key={wiki.roomId}
                  className={`wiki-room-item${wiki.roomId === selectedRoomId ? ' is-selected' : ''}`}
                  onClick={() => setSelectedRoomId(wiki.roomId)}
                >
                  <strong>{room?.title ?? wiki.roomId}</strong>
                  <span>{room ? t(uiText(room.kind)) : t('contextRoom:display.room')} · {t(statusLabel(wiki.status))}</span>
                </button>
              )
            })}
          </aside>

          <section className="wiki-main">
            <div className="wiki-main-toolbar">
              <div className="wiki-main-title">
                <BookOpenText aria-hidden="true" strokeWidth={1.7} />
                <span>
                  {selectedRoomTitle ?? selectedRoomId ?? ''}
                  {selectedWiki ? ` (${t(statusLabel(selectedWiki.status))})` : ''}
                </span>
              </div>
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
            </div>

            <div className={`wiki-panes${view === 'graph' ? ' is-graph' : ''}`}>
              {view === 'tree' ? (
                <>
                  <div className="wiki-tree-pane">
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
                      <WikiTree pages={pages} selectedPath={selectedPage?.path ?? null} onSelect={openPage} />
                    )}
                  </div>
                  <div className="wiki-preview">
                    {selectedPage ? (
                      <>
                        <header className="wiki-preview-header">
                          <strong title={selectedPage.title}>{selectedPage.title}</strong>
                          <span title={selectedPage.path}>{selectedPage.path}</span>
                        </header>
                        {markdown === null ? t('surface:wiki.loading') : <MarkdownBody markdown={markdown} />}
                      </>
                    ) : (
                      <div className="wiki-empty">{t('surface:wiki.selectAPageFromTheTreeToRead')}</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="wiki-graph-pane">
                  {graphLoading ? (
                    <div className="wiki-empty">{t('surface:wiki.buildingGraph')}</div>
                  ) : graph && graph.nodes.length > 0 ? (
                    <>
                      <WikiGraphCanvas
                        graph={graph}
                        selectedPath={selectedPage?.path ?? null}
                        onSelectPage={(path) => {
                          const page = pages.find((candidate) => candidate.path === path)
                          if (page) openPage(page)
                        }}
                      />
                      <div className="wiki-graph-stats" aria-label={t('surface:wiki.graphStatistics')}>
                        <span>{t('surface:wiki.countPages', { count: graph.nodes.length })}</span>
                        <span>{t('surface:wiki.countInternalLinks', { count: graph.edges.length })}</span>
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
                              <MarkdownBody markdown={markdown} />
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
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
