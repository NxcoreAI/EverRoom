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

import type { BrowserExtensionClipperCapture } from '../../../../shared/browser-extension'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import { RichClipMarkdown } from './RichClipMarkdown'
import './InspirationPage.css'

type InspirationSortOrder = 'newest' | 'oldest'
type LoadState = 'loading' | 'ready' | 'error'
type DeleteState = 'idle' | 'deleting'
type PipelineState = BrowserExtensionClipperCapture['understanding'][keyof BrowserExtensionClipperCapture['understanding']]

function hostFromUrl(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return '网页剪藏' }
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

const stateText: Record<PipelineState, string> = {
  pending: '等待中',
  processing: '处理中',
  ready: '已完成',
  partial: '部分完成',
  skipped: '无需处理',
  failed: '失败',
  unavailable: '不可用',
}

function UnderstandingStatus({ capture }: { capture: BrowserExtensionClipperCapture }) {
  const stages: Array<[string, PipelineState]> = [
    ['图片理解', capture.understanding.visual],
    ['内容解析', capture.understanding.parse],
    ['记忆', capture.understanding.memory],
    ['实体', capture.understanding.entities],
  ]
  return (
    <div className="inspiration-pipeline" aria-label="理解进度">
      {stages.map(([label, state]) => (
        <span key={label} className={`is-${state}`} title={`${label}：${stateText[state]}`}>
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
  return window.innerWidth <= 640 ? 1 : window.innerWidth <= 980 ? 2 : 3
}

export function InspirationPage() {
  const { locale } = useLocale()
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
  const [moreOpen, setMoreOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteState, setDeleteState] = useState<DeleteState>('idle')
  const [columnCount, setColumnCount] = useState(masonryColumnCount)
  const [saved, setSaved] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('everroom:inspiration:saved') ?? '[]') as string[]) } catch { return new Set() }
  })

  const loadCaptures = useCallback(async (background = false) => {
    if (!filesApi?.listClipCaptures) {
      setLoadError('当前环境没有连接到本地剪藏服务。')
      setLoadState('error')
      return
    }
    if (!background) setLoadState('loading')
    try {
      const result = await filesApi.listClipCaptures(200, 0)
      setItems(result.items)
      setLoadError('')
      setLoadState('ready')
    } catch (error) {
      if (!background) {
        setLoadError(error instanceof Error ? error.message : '无法读取本地剪藏。')
        setLoadState('error')
      }
    }
  }, [filesApi])

  const loadDetail = useCallback(async (captureId: string, background = false) => {
    if (!filesApi?.getClipCaptureDetail) {
      setDetailError('当前版本无法读取剪藏详情。')
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
        setDetailError(error instanceof Error ? error.message : '无法读取剪藏详情。')
        setDetailState('error')
      }
    }
  }, [filesApi])

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

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return items
      .filter((item) => !normalized || [item.title, item.artifact?.excerpt, item.author, ...item.entities.map((entity) => entity.name)]
        .filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(normalized))
      .sort((left, right) => {
        const difference = Date.parse(right.capturedAt) - Date.parse(left.capturedAt)
        return sortOrder === 'newest' ? difference : -difference
      })
  }, [items, locale, query, sortOrder])

  const masonryColumns = useMemo(() => {
    const columns = Array.from({ length: columnCount }, () => [] as BrowserExtensionClipperCapture[])
    filteredItems.forEach((item, index) => columns[index % columnCount]!.push(item))
    return columns
  }, [columnCount, filteredItems])

  const toggleSaved = (id: string) => {
    setSaved((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem('everroom:inspiration:saved', JSON.stringify([...next])) } catch { /* optional local preference */ }
      return next
    })
  }

  const copySelectedLink = async () => {
    if (!selected) return
    try {
      const text = `${selected.title}\n${selected.sourceUrl}`
      if (window.nxcore?.clipboard) await window.nxcore.clipboard.writeText(text)
      else await navigator.clipboard.writeText(text)
      showToast({ title: '链接已复制', message: hostFromUrl(selected.sourceUrl) })
      setMoreOpen(false)
    } catch {
      showToast({ title: '复制失败', message: '当前环境无法访问剪贴板。' })
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
      showToast({ title: '分享失败', message: '请稍后重试。' })
    }
  }

  const deleteSelected = async () => {
    if (!selected?.fileEntryId || !filesApi?.delete) {
      showToast({ title: '无法删除', message: '这条灵感没有可用的本地文件记录。' })
      return
    }
    setDeleteState('deleting')
    try {
      const fileEntryId = selected.fileEntryId
      await filesApi.delete(fileEntryId)
      setItems((current) => current.filter((item) => item.fileEntryId !== fileEntryId))
      setSaved((current) => {
        const next = new Set(current)
        for (const item of items) {
          if (item.fileEntryId === fileEntryId) next.delete(item.id)
        }
        try { localStorage.setItem('everroom:inspiration:saved', JSON.stringify([...next])) } catch { /* optional local preference */ }
        return next
      })
      setDeleteOpen(false)
      setSelectedId(null)
      setSelected(null)
      showToast({ title: '灵感已删除', message: '网页剪藏和对应记忆已从本地移除。' })
    } catch (error) {
      showToast({ title: '删除失败', message: error instanceof Error ? error.message : '请稍后重试。' })
    } finally {
      setDeleteState('idle')
    }
  }

  if (selectedId) {
    return (
      <main className="page inspiration-page inspiration-detail-page">
        <div className="inspiration-detail-toolbar">
          <button type="button" className="inspiration-back-button" onClick={() => { setSelectedId(null); setMoreOpen(false) }}>
            <ArrowLeft aria-hidden="true" /> <span>返回灵感</span>
          </button>
          {selected ? <div className="inspiration-detail-actions">
            <button type="button" className={`inspiration-icon-button ${saved.has(selected.id) ? 'is-saved' : ''}`} aria-label="收藏" title="收藏" onClick={() => toggleSaved(selected.id)}><Bookmark aria-hidden="true" fill={saved.has(selected.id) ? 'currentColor' : 'none'} /></button>
            <button type="button" className="inspiration-icon-button" aria-label="更多操作" title="更多操作" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal aria-hidden="true" /></button>
            {moreOpen ? <div className="inspiration-more-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void shareSelected()}>分享灵感 <Share2 aria-hidden="true" /></button>
              <button type="button" className="is-danger" role="menuitem" onClick={() => { setMoreOpen(false); setDeleteOpen(true) }}>删除灵感 <Trash2 aria-hidden="true" /></button>
            </div> : null}
          </div> : null}
        </div>
        {detailState === 'loading' ? <div className="inspiration-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><h2>正在读取剪藏详情</h2></div>
          : detailState === 'error' || !selected ? <div className="inspiration-empty"><AlertCircle aria-hidden="true" /><h2>无法打开这条剪藏</h2><p>{detailError}</p><button type="button" className="inspiration-retry" onClick={() => void loadDetail(selectedId)}><RefreshCw aria-hidden="true" />重试</button></div>
            : <article className="inspiration-entry">
              <aside className="inspiration-entry-rail">
                <span className="inspiration-entry-day">{dateLabel(selected.capturedAt).slice(-2)}</span>
                <span className="inspiration-entry-month">{dateLabel(selected.capturedAt).slice(0, 7).replace('.', ' / ')}</span>
                <span className="inspiration-entry-line" />
                <span className="inspiration-entry-label">网页剪藏</span>
              </aside>
              <div className="inspiration-entry-main">
                <div className="inspiration-entry-kicker"><span>{hostFromUrl(selected.sourceUrl)}</span><i />{selected.author || '网页剪藏'}</div>
                <h1>{selected.title}</h1>
                {selected.artifact?.excerpt ? <p className="inspiration-entry-intro">{selected.artifact.excerpt}</p> : null}
                <UnderstandingStatus capture={selected} />
                {selected.entities.length > 0 ? <div className="inspiration-entities" aria-label="提取出的实体">{selected.entities.map((entity) => <span key={entity.id} title={entity.evidence ?? entity.kind}>{entity.name}<small>{entity.kind}</small></span>)}</div> : null}
                <div className="inspiration-entry-copy">
                  {selected.artifact?.displayMarkdown ? <RichClipMarkdown markdown={selected.artifact.displayMarkdown} />
                    : <div className="inspiration-content-empty">这条剪藏没有可渲染的正文。</div>}
                </div>
                {selected.assets.some((asset) => asset.visualStatus === 'ready' && asset.visualContentRole !== 'noise' && asset.visualKind !== 'logo' && asset.visualKind !== 'decoration') ? <section className="inspiration-visual-notes" aria-label="图片理解结果">
                  <h2>图片理解</h2>
                  {selected.assets.filter((asset) => asset.visualStatus === 'ready' && asset.visualContentRole !== 'noise' && asset.visualKind !== 'logo' && asset.visualKind !== 'decoration').map((asset) => <article key={asset.id}>
                    <img src={asset.localUrl} alt={asset.altText ?? ''} loading="lazy" />
                    <div><strong>{asset.visualKind || '图片'}</strong><p>{asset.visualSummary}</p>{asset.visualKeyPoints.length > 0 ? <ul>{asset.visualKeyPoints.map((point) => <li key={point}>{point}</li>)}</ul> : null}</div>
                  </article>)}
                </section> : null}
                <footer className="inspiration-entry-footer">
                  <span>{isWorking(selected) ? <><LoaderCircle className="is-spinning" aria-hidden="true" /> 正在进入理解链路</> : <><Check aria-hidden="true" /> 已完成本地处理</>}</span>
                  <a href={selected.sourceUrl} target="_blank" rel="noreferrer">打开原网页 <ExternalLink aria-hidden="true" /></a>
                </footer>
              </div>
            </article>}
        <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (deleteState !== 'deleting') setDeleteOpen(open) }}>
          <Dialog.Portal>
            <Dialog.Overlay className="inspiration-dialog-overlay" />
            <Dialog.Content className="inspiration-delete-dialog" aria-describedby="inspiration-delete-description">
              <span className="inspiration-dialog-mark" aria-hidden="true"><Trash2 /></span>
              <Dialog.Title>删除这条灵感？</Dialog.Title>
              <Dialog.Description id="inspiration-delete-description">网页剪藏、关联内容和对应记忆都会从本地移除。此操作无法撤销。</Dialog.Description>
              <div className="inspiration-dialog-actions">
                <Dialog.Close disabled={deleteState === 'deleting'}>取消</Dialog.Close>
                <button type="button" className="is-danger" disabled={deleteState === 'deleting'} onClick={() => void deleteSelected()}>
                  {deleteState === 'deleting' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {deleteState === 'deleting' ? '正在删除' : '删除灵感'}
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
      <header className="inspiration-header">
        <div className="inspiration-heading">
          <div className="inspiration-eyebrow"><span className="inspiration-eyebrow-mark"><Sparkles aria-hidden="true" /></span> WEB CLIPPINGS · {new Date().getFullYear()}</div>
          <h1>灵感</h1>
          <p>把在网页上遇见的好东西，留给未来的自己。</p>
        </div>
        <div className="inspiration-header-note"><span>本地已收录</span><strong>{String(items.length).padStart(2, '0')}</strong><small>篇</small></div>
      </header>
      <div className="inspiration-toolbar">
        <div className="inspiration-scope" aria-label="当前灵感范围"><span className="inspiration-scope-dot" aria-hidden="true" />全部 <small>{items.reduce((sum, item) => sum + item.entities.length, 0)} 个关联实体</small></div>
        <label className="inspiration-search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索剪藏或实体" aria-label="搜索剪藏" />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>×</button> : null}</label>
        <button type="button" className="inspiration-sort" title="切换收录顺序" onClick={() => setSortOrder((order) => order === 'newest' ? 'oldest' : 'newest')}><span>{sortOrder === 'newest' ? '最近收录' : '最早收录'}</span><ChevronDown aria-hidden="true" /></button>
      </div>
      <div className="inspiration-rule" />
      {loadState === 'loading' ? <div className="inspiration-empty"><LoaderCircle className="is-spinning" aria-hidden="true" /><h2>正在读取本地剪藏</h2><p>正在加载索引和理解状态。</p></div>
        : loadState === 'error' ? <div className="inspiration-empty"><AlertCircle aria-hidden="true" /><h2>无法读取灵感</h2><p>{loadError}</p><button type="button" className="inspiration-retry" onClick={() => void loadCaptures()}><RefreshCw aria-hidden="true" />重试</button></div>
          : filteredItems.length > 0 ? <section className="inspiration-masonry" aria-label="灵感瀑布流">
            {masonryColumns.map((column, columnIndex) => <div key={`masonry-column-${columnIndex}`} className="inspiration-masonry-column">
              {column.map((item) => {
                const cover = item.artifact?.coverUrl
                return <article key={item.id} className={`inspiration-card ${cover ? 'has-cover' : 'without-cover'}`}>
                  <button type="button" className="inspiration-card-hit" onClick={() => { setSelectedId(item.id); setMoreOpen(false) }} aria-label={`打开：${item.title}`}>
                    {cover ? <div className="inspiration-card-media"><img src={cover} alt={item.assets.find((asset) => asset.id === item.artifact?.coverAssetId)?.altText ?? item.title} loading="lazy" /><span className="inspiration-card-source">{item.author || hostFromUrl(item.sourceUrl)}</span><span className="inspiration-card-arrow"><ArrowUpRight aria-hidden="true" /></span></div> : null}
                    <div className="inspiration-card-content">
                      <div className="inspiration-card-meta"><span>{hostFromUrl(item.sourceUrl)}</span><span>{dateLabel(item.capturedAt)}</span></div>
                      <h2>{item.title}</h2>
                      {item.artifact?.excerpt ? <p>{item.artifact.excerpt}</p> : null}
                      {isWorking(item) ? <div className="inspiration-card-processing"><LoaderCircle className="is-spinning" aria-hidden="true" />正在理解内容</div> : null}
                      <div className="inspiration-card-footer"><span>{readTime(item)} 阅读</span><span className="inspiration-card-host">{item.entities.slice(0, 2).map((entity) => entity.name).join(' · ') || hostFromUrl(item.sourceUrl)}</span></div>
                    </div>
                  </button>
                  <button type="button" className={`inspiration-save-button ${saved.has(item.id) ? 'is-saved' : ''}`} aria-label={saved.has(item.id) ? '取消收藏' : '收藏'} title={saved.has(item.id) ? '取消收藏' : '收藏'} onClick={() => toggleSaved(item.id)}><Heart aria-hidden="true" fill={saved.has(item.id) ? 'currentColor' : 'none'} /></button>
                </article>
              })}
            </div>)}
          </section>
            : <div className="inspiration-empty">{items.length === 0 ? <Sparkles aria-hidden="true" /> : <Search aria-hidden="true" />}<h2>{items.length === 0 ? '还没有网页剪藏' : '没有找到匹配的灵感'}</h2><p>{items.length === 0 ? '在浏览器扩展中保存网页后，内容会出现在这里。' : '换一个关键词再试。'}</p></div>}
    </main>
  )
}
