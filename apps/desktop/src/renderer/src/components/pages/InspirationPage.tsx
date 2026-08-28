import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ExternalLink,
  Heart,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { BrowserExtensionClipperCapture, BrowserExtensionClipperListResult } from '../../../../shared/browser-extension'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { RichClipMarkdown } from './RichClipMarkdown'
import './InspirationPage.css'

type InspirationSortOrder = 'newest' | 'oldest'
type InspirationFilter = 'all' | 'favorite' | 'processing'
type LoadState = 'loading' | 'ready' | 'error'
type DeleteState = 'idle' | 'deleting'
type PipelineState = BrowserExtensionClipperCapture['understanding'][keyof BrowserExtensionClipperCapture['understanding']]

function hostFromUrl(value: string, fallback: string): string {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return fallback }
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value.slice(0, 10).replaceAll('-', '.') : date.toISOString().slice(0, 10).replaceAll('-', '.')
}

function readTime(capture: BrowserExtensionClipperCapture): string {
  const length = capture.artifact?.displayMarkdown?.length ?? capture.artifact?.excerpt.length ?? 0
  return `${Math.max(1, Math.round(length / 900))} min`
}

function isWorking(capture: BrowserExtensionClipperCapture): boolean {
  return Object.values(capture.understanding).some((state) => state === 'pending' || state === 'processing')
}

function cardStatus(capture: BrowserExtensionClipperCapture): 'processing' | 'failed' | 'complete' {
  if (capture.status === 'failed' || Object.values(capture.understanding).some((state) => state === 'failed')) return 'failed'
  return isWorking(capture) ? 'processing' : 'complete'
}

function UnderstandingStatus({ capture }: { capture: BrowserExtensionClipperCapture }) {
  const { t } = useLocale()
  const stages: Array<[string, PipelineState]> = [
    [t('surface:inspiration.visualUnderstanding'), capture.understanding.visual],
    [t('surface:inspiration.contentParsing'), capture.understanding.parse],
    [t('surface:inspiration.memory'), capture.understanding.memory],
    [t('surface:inspiration.entities'), capture.understanding.entities],
  ]
  return (
    <div className="inspiration-pipeline" aria-label={t('surface:inspiration.understandingProgress')}>
      {stages.map(([label, state]) => (
        <span key={label} className={`is-${state}`} title={`${label}: ${t(`surface:inspiration.state.${state}`)}`}>
          {state === 'pending' || state === 'processing' ? <LoaderCircle aria-hidden="true" />
            : state === 'ready' ? <Check aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
          {label}
        </span>
      ))}
    </div>
  )
}

function masonryColumnCount(): number {
  if (typeof window === 'undefined') return 3
  return window.innerWidth <= 840 ? 1 : window.innerWidth <= 1200 ? 2 : 3
}

export function InspirationPage() {
  const { t } = useLocale()
  const filesApi = window.nxcore?.files
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<BrowserExtensionClipperCapture[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<BrowserExtensionClipperCapture | null>(null)
  const [detailState, setDetailState] = useState<LoadState>('loading')
  const [detailError, setDetailError] = useState('')
  const [sortOrder, setSortOrder] = useState<InspirationSortOrder>('newest')
  const [filter, setFilter] = useState<InspirationFilter>('all')
  const [page, setPage] = useState(0)
  const [listMeta, setListMeta] = useState<Pick<BrowserExtensionClipperListResult, 'total' | 'counts'>>({ total: 0, counts: { all: 0, favorite: 0, processing: 0 } })
  const [moreOpen, setMoreOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteState, setDeleteState] = useState<DeleteState>('idle')
  const [columnCount, setColumnCount] = useState(masonryColumnCount)

  const loadCaptures = useCallback(async (background = false) => {
    if (!filesApi?.listClipCaptures) {
      setLoadError(t('surface:inspiration.serviceUnavailable'))
      setLoadState('error')
      return
    }
    if (!background) setLoadState('loading')
    try {
      const result = await filesApi.listClipCaptures({ query, filter, sort: sortOrder, limit: 30, offset: page * 30 })
      setItems(result.items)
      setListMeta({ total: result.total, counts: result.counts })
      setLoadError('')
      setLoadState('ready')
    } catch (error) {
      if (!background) {
        setLoadError(error instanceof Error ? error.message : t('surface:inspiration.readFailed'))
        setLoadState('error')
      }
    }
  }, [filesApi, filter, page, query, sortOrder, t])

  const loadDetail = useCallback(async (captureId: string, background = false) => {
    if (!filesApi?.getClipCaptureDetail) {
      setDetailError(t('surface:inspiration.detailUnavailable'))
      setDetailState('error')
      return
    }
    if (!background) setDetailState('loading')
    try {
      const capture = await filesApi.getClipCaptureDetail(captureId)
      setSelected(capture)
      setDetailError('')
      setDetailState('ready')
      setItems((current) => current.map((item) => {
        if (item.id !== capture.id) return item
        if (!capture.artifact) return { ...capture, artifact: null }
        const { displayMarkdown: _displayMarkdown, ...artifact } = capture.artifact
        return { ...capture, artifact }
      }))
    } catch (error) {
      if (!background) {
        setDetailError(error instanceof Error ? error.message : t('surface:inspiration.detailReadFailed'))
        setDetailState('error')
      }
    }
  }, [filesApi, t])

  useEffect(() => { setPage(0) }, [filter, query, sortOrder])
  useEffect(() => { void loadCaptures() }, [loadCaptures])

  useEffect(() => {
    if (loadState !== 'ready' || !items.some(isWorking)) return
    const timer = window.setInterval(() => void loadCaptures(true), 3_000)
    return () => window.clearInterval(timer)
  }, [items, loadCaptures, loadState])

  useEffect(() => {
    if (!selectedId) { setSelected(null); return }
    void loadDetail(selectedId)
  }, [loadDetail, selectedId])

  useEffect(() => {
    if (!selectedId || !selected || !isWorking(selected)) return
    const timer = window.setInterval(() => void loadDetail(selectedId, true), 2_500)
    return () => window.clearInterval(timer)
  }, [loadDetail, selected, selectedId])

  useEffect(() => {
    const handleResize = () => setColumnCount(masonryColumnCount())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const filteredItems = items

  const masonryColumns = useMemo(() => {
    const columns = Array.from({ length: columnCount }, () => [] as BrowserExtensionClipperCapture[])
    filteredItems.forEach((item, index) => columns[index % columnCount]!.push(item))
    return columns
  }, [columnCount, filteredItems])

  const toggleSaved = async (capture: BrowserExtensionClipperCapture) => {
    if (!filesApi?.setClipCaptureFavorite) return
    const favorite = !capture.favoritedAt
    try {
      const updated = await filesApi.setClipCaptureFavorite(capture.id, favorite)
      setItems((current) => current.map((item) => item.id === updated.id ? { ...item, favoritedAt: updated.favoritedAt } : item))
      setSelected((current) => current?.id === updated.id ? { ...current, favoritedAt: updated.favoritedAt } : current)
      void loadCaptures(true)
    } catch (error) {
      showToast({ title: t('surface:inspiration.favoriteFailed'), message: error instanceof Error ? error.message : t('surface:inspiration.tryAgainLater') })
    }
  }

  const copySelectedLink = async () => {
    if (!selected) return
    try {
      const text = `${selected.title}\n${selected.sourceUrl}`
      if (window.nxcore?.clipboard) await window.nxcore.clipboard.writeText(text)
      else await navigator.clipboard.writeText(text)
      showToast({ title: t('surface:inspiration.linkCopied'), message: hostFromUrl(selected.sourceUrl, t('surface:inspiration.webClip')) })
      setMoreOpen(false)
    } catch {
      showToast({ title: t('surface:inspiration.copyFailed'), message: t('surface:inspiration.clipboardUnavailable') })
    }
  }

  const shareSelected = async () => {
    if (!selected) return
    setMoreOpen(false)
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: selected.title, text: selected.artifact?.excerpt, url: selected.sourceUrl })
      } else await copySelectedLink()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      showToast({ title: t('surface:inspiration.shareFailed'), message: t('surface:inspiration.tryAgainLater') })
    }
  }

  const deleteSelected = async () => {
    if (!selected?.fileEntryId || !filesApi?.delete) {
      showToast({ title: t('surface:inspiration.cannotDelete'), message: t('surface:inspiration.noLocalRecord') })
      return
    }
    setDeleteState('deleting')
    try {
      const fileEntryId = selected.fileEntryId
      await filesApi.delete(fileEntryId)
      setItems((current) => current.filter((item) => item.fileEntryId !== fileEntryId))
      setDeleteOpen(false)
      setSelectedId(null)
      setSelected(null)
      showToast({ title: t('surface:inspiration.deleted'), message: t('surface:inspiration.deletedDescription') })
    } catch (error) {
      showToast({ title: t('surface:inspiration.deleteFailed'), message: error instanceof Error ? error.message : t('surface:inspiration.tryAgainLater') })
    } finally {
      setDeleteState('idle')
    }
  }

  if (selectedId) {
    return (
      <main className="page inspiration-page inspiration-detail-page">
        <div className="inspiration-detail-toolbar">
          <button type="button" className="inspiration-back-button" onClick={() => { setSelectedId(null); setMoreOpen(false) }}>
            <ArrowLeft aria-hidden="true" /> <span>{t('surface:inspiration.back')}</span>
          </button>
          {selected ? <div className="inspiration-detail-actions">
            <button type="button" className={`inspiration-icon-button ${selected.favoritedAt ? 'is-saved' : ''}`} aria-label={t(`surface:inspiration.${selected.favoritedAt ? 'unsave' : 'save'}`)} title={t(`surface:inspiration.${selected.favoritedAt ? 'unsave' : 'save'}`)} onClick={() => void toggleSaved(selected)}><Bookmark aria-hidden="true" fill={selected.favoritedAt ? 'currentColor' : 'none'} /></button>
            <button type="button" className="inspiration-icon-button" aria-label={t('surface:inspiration.moreActions')} title={t('surface:inspiration.moreActions')} aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal aria-hidden="true" /></button>
            {moreOpen ? <div className="inspiration-more-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void shareSelected()}>{t('surface:inspiration.share')} <Share2 aria-hidden="true" /></button>
              <button type="button" className="is-danger" role="menuitem" onClick={() => { setMoreOpen(false); setDeleteOpen(true) }}>{t('surface:inspiration.delete')} <Trash2 aria-hidden="true" /></button>
            </div> : null}
          </div> : null}
        </div>
        {detailState === 'loading' ? <div className="inspiration-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><h2>{t('surface:inspiration.loadingDetail')}</h2></div>
          : detailState === 'error' || !selected ? <div className="inspiration-empty"><AlertCircle aria-hidden="true" /><h2>{t('surface:inspiration.openFailed')}</h2><p>{detailError}</p><button type="button" className="inspiration-retry" onClick={() => void loadDetail(selectedId)}><RefreshCw aria-hidden="true" />{t('surface:inspiration.retry')}</button></div>
            : <article className="inspiration-entry">
              <div className="inspiration-entry-main">
                <div className="inspiration-entry-kicker"><span>{hostFromUrl(selected.sourceUrl, t('surface:inspiration.webClip'))}</span><i />{selected.author || t('surface:inspiration.webClip')}</div>
                <h1>{selected.title}</h1>
                {selected.artifact?.excerpt ? <p className="inspiration-entry-intro">{selected.artifact.excerpt}</p> : null}
                <UnderstandingStatus capture={selected} />
                {selected.entities.length > 0 ? <div className="inspiration-entities" aria-label={t('surface:inspiration.extractedEntities')}>{selected.entities.map((entity) => <span key={entity.id} title={entity.evidence ?? entity.kind}>{entity.name}<small>{entity.kind}</small></span>)}</div> : null}
                <div className="inspiration-entry-copy">
                  {selected.artifact?.displayMarkdown ? <RichClipMarkdown markdown={selected.artifact.displayMarkdown} />
                    : <div className="inspiration-content-empty">{t('surface:inspiration.noRenderableContent')}</div>}
                </div>
                {selected.assets.some((asset) => asset.visualStatus === 'ready' && asset.visualContentRole !== 'noise' && asset.visualKind !== 'logo' && asset.visualKind !== 'decoration') ? <section className="inspiration-visual-notes" aria-label={t('surface:obsidian.visualResults')}>
                  <h2>{t('surface:inspiration.visualUnderstanding')}</h2>
                  {selected.assets.filter((asset) => asset.visualStatus === 'ready' && asset.visualContentRole !== 'noise' && asset.visualKind !== 'logo' && asset.visualKind !== 'decoration').map((asset) => <article key={asset.id}>
                    <img src={asset.localUrl} alt={asset.altText ?? ''} loading="lazy" />
                    <div><strong>{asset.visualKind || t('surface:inspiration.image')}</strong><p>{asset.visualSummary}</p>{asset.visualKeyPoints.length > 0 ? <ul>{asset.visualKeyPoints.map((point) => <li key={point}>{point}</li>)}</ul> : null}</div>
                  </article>)}
                </section> : null}
                <footer className="inspiration-entry-footer">
                  <span>{isWorking(selected) ? <><LoaderCircle className="is-spinning" aria-hidden="true" /> {t('surface:inspiration.enteringPipeline')}</> : <><Check aria-hidden="true" /> {t('surface:inspiration.localProcessingComplete')}</>}</span>
                  <a href={selected.sourceUrl} target="_blank" rel="noreferrer">{t('surface:inspiration.openOriginal')} <ExternalLink aria-hidden="true" /></a>
                </footer>
              </div>
            </article>}
        <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (deleteState !== 'deleting') setDeleteOpen(open) }}>
          <Dialog.Portal>
            <Dialog.Overlay className="inspiration-dialog-overlay" />
            <Dialog.Content className="inspiration-delete-dialog" aria-describedby="inspiration-delete-description">
              <span className="inspiration-dialog-mark" aria-hidden="true"><Trash2 /></span>
              <Dialog.Title>{t('surface:inspiration.deleteTitle')}</Dialog.Title>
              <Dialog.Description id="inspiration-delete-description">{t('surface:inspiration.deleteDescription')}</Dialog.Description>
              <div className="inspiration-dialog-actions">
                <Dialog.Close disabled={deleteState === 'deleting'}>{t('surface:inspiration.cancel')}</Dialog.Close>
                <button type="button" className="is-danger" disabled={deleteState === 'deleting'} onClick={() => void deleteSelected()}>
                  {deleteState === 'deleting' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {t(`surface:inspiration.${deleteState === 'deleting' ? 'deleting' : 'delete'}`)}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </main>
    )
  }

  return (
    <main className="page inspiration-page">
      <header className="inspiration-header"><div className="inspiration-heading"><h1>{t('surface:inspiration.title')}</h1></div><div className="inspiration-header-note"><span>{t('surface:inspiration.currentResults')}</span><strong>{listMeta.total}</strong><small>{t('surface:inspiration.itemUnit')}</small></div></header>
      <div className="inspiration-toolbar">
        <div className="inspiration-segmented" role="tablist" aria-label={t('surface:inspiration.filterLabel')}>{(['all', 'favorite', 'processing'] as const).map((value) => <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{t(`surface:inspiration.${value}`)}<small>{listMeta.counts[value]}</small></button>)}</div>
        <label className="inspiration-search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('surface:inspiration.searchPlaceholder')} aria-label={t('surface:inspiration.searchPlaceholder')} />{query ? <button type="button" aria-label={t('surface:inspiration.clearSearch')} onClick={() => setQuery('')}>×</button> : null}</label>
        <button type="button" className="inspiration-sort" onClick={() => setSortOrder((order) => order === 'newest' ? 'oldest' : 'newest')}><span>{t(`surface:inspiration.${sortOrder}`)}</span><ChevronDown aria-hidden="true" /></button>
      </div>
      <div className="inspiration-rule" />
      {loadState === 'loading' ? <div className="inspiration-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><h2>{t('surface:inspiration.loading')}</h2><p>{t('surface:inspiration.loadingDescription')}</p></div>
        : loadState === 'error' ? <div className="inspiration-empty"><AlertCircle aria-hidden="true" /><h2>{t('surface:inspiration.loadFailed')}</h2><p>{loadError}</p><button type="button" className="inspiration-retry" onClick={() => void loadCaptures()}><RefreshCw aria-hidden="true" />{t('surface:inspiration.retry')}</button></div>
          : filteredItems.length > 0 ? <section className="inspiration-masonry" aria-label={t('surface:inspiration.libraryLabel')}>
            {masonryColumns.map((column, columnIndex) => <div key={`masonry-column-${columnIndex}`} className="inspiration-masonry-column">
              {column.map((item) => {
                const cover = item.artifact?.coverUrl
                return <article key={item.id} data-status={cardStatus(item)} className={`inspiration-card ${cover ? 'has-cover' : 'without-cover'}`}>
                  <button type="button" className="inspiration-card-hit" onClick={() => { setSelectedId(item.id); setMoreOpen(false) }} aria-label={t('surface:inspiration.openItem', { title: item.title })}>
                    {cover ? <div className="inspiration-card-media"><img src={cover} alt={item.assets.find((asset) => asset.id === item.artifact?.coverAssetId)?.altText ?? item.title} loading="lazy" /><span className="inspiration-card-source">{item.author || hostFromUrl(item.sourceUrl, t('surface:inspiration.webClip'))}</span><span className="inspiration-card-arrow"><ArrowUpRight aria-hidden="true" /></span></div> : null}
                    <div className="inspiration-card-content">
                      <div className="inspiration-card-meta"><span>{hostFromUrl(item.sourceUrl, t('surface:inspiration.webClip'))}</span><span>{dateLabel(item.capturedAt)}</span></div>
                      <h2>{item.title}</h2>
                      {item.artifact?.excerpt ? <p>{item.artifact.excerpt}</p> : null}
                      {isWorking(item) ? <div className="inspiration-card-processing"><LoaderCircle className="is-spinning" aria-hidden="true" />{t('surface:inspiration.understanding')}</div> : null}
                      <div className="inspiration-card-footer"><span>{readTime(item)} {t('surface:inspiration.reading')}</span><span className="inspiration-card-host">{item.entities.slice(0, 2).map((entity) => entity.name).join(' · ') || hostFromUrl(item.sourceUrl, t('surface:inspiration.webClip'))}</span></div>
                    </div>
                  </button>
                  <button type="button" className={`inspiration-save-button ${item.favoritedAt ? 'is-saved' : ''}`} aria-label={t(`surface:inspiration.${item.favoritedAt ? 'unsave' : 'save'}`)} title={t(`surface:inspiration.${item.favoritedAt ? 'unsave' : 'save'}`)} onClick={() => void toggleSaved(item)}><Heart aria-hidden="true" fill={item.favoritedAt ? 'currentColor' : 'none'} /></button>
                </article>
              })}
            </div>)}
          </section>
            : <div className="inspiration-empty">{listMeta.total === 0 ? <Sparkles aria-hidden="true" /> : <Search aria-hidden="true" />}<h2>{t(`surface:inspiration.${listMeta.total === 0 ? 'empty' : 'noMatches'}`)}</h2><p>{t(`surface:inspiration.${listMeta.total === 0 ? 'emptyDescription' : 'noMatchesDescription'}`)}</p></div>}
      {listMeta.total > 30 ? <nav className="inspiration-pagination" aria-label={t('surface:inspiration.filterLabel')}><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{t('surface:inspiration.previousPage')}</button><span>{page + 1} / {Math.ceil(listMeta.total / 30)}</span><button type="button" disabled={(page + 1) * 30 >= listMeta.total} onClick={() => setPage((value) => value + 1)}>{t('surface:inspiration.nextPage')}</button></nav> : null}
    </main>
  )
}
