import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ExternalLink,
  Heart,
  MoreHorizontal,
  Search,
  Share2,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import type { BrowserExtensionClipperCapture } from '../../../../shared/browser-extension'
import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import './InspirationPage.css'

type InspirationCategory = '全部'
type InspirationSortOrder = 'newest' | 'oldest'

interface InspirationItem {
  id: string
  category: InspirationCategory
  title: string
  excerpt: string
  source: string
  host: string
  sourceUrl: string
  date: string
  readTime: string
  image: string
  imageAlt: string
  palette: string
  note: string
  body: string[]
  quote: string
}

const inspirationItems: InspirationItem[] = [
  {
    id: 'quiet-interface', category: '全部', title: '安静的界面，也可以很有力量',
    excerpt: '留白不是空缺，而是给内容一口呼吸。好的产品让人更快抵达想去的地方。',
    source: 'The Gentlewoman', host: 'thegentlewoman.co.uk', sourceUrl: 'https://thegentlewoman.co.uk/', date: '2024.08.24', readTime: '6 min',
    image: 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1200&q=85', imageAlt: '安静明亮的工作空间', palette: '#d7cfc4',
    note: '收录时想起：界面不必时时发出声音。', quote: 'A calm interface is an invitation to stay.',
    body: ['我们常常把“有设计”误解成更多的元素、更多的动效、更多的选择。但真正成熟的界面，往往先为人删去噪音。', '它用清晰的层级和恰到好处的留白，让阅读变成一种没有阻力的移动。用户不需要学习它，只需要在其中继续自己的思考。'],
  },
  {
    id: 'material-and-memory', category: '全部', title: '物件如何替我们保存记忆',
    excerpt: '从一张旧车票到一只磨损的杯子，物质比文字更早替我们记住当时的光线。',
    source: 'Apartamento', host: 'apartamentomagazine.com', sourceUrl: 'https://www.apartamentomagazine.com/', date: '2024.08.21', readTime: '8 min',
    image: 'https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=1200&q=85', imageAlt: '桌上的书与眼镜', palette: '#bfaa95',
    note: '一个适合周末下午慢慢读完的片段。', quote: 'Things remember what we have forgotten.',
    body: ['我们把重要的东西收进抽屉，以为这样就完成了保存。其实真正留下来的，是物件和时间摩擦之后的手感。', '网页剪藏让文字回到生活里：它不再只是一个链接，而是我在某个下午被打动过的证据。'],
  },
  {
    id: 'small-rituals', category: '全部', title: '把复杂的工作还给工具',
    excerpt: '一个产品的价值，不在于它有多少功能，而在于它能否替用户守住专注。',
    source: 'Dense Discovery', host: 'densediscovery.com', sourceUrl: 'https://www.densediscovery.com/', date: '2024.08.17', readTime: '4 min',
    image: 'https://images.unsplash.com/photo-1523726491678-bf852e717f6a?auto=format&fit=crop&w=1200&q=85', imageAlt: '设计师在工作', palette: '#9baec4',
    note: '值得带回产品评审的一句话。', quote: 'Good tools make room for better thinking.',
    body: ['工具应该承接重复、琐碎和容易忘记的部分，把注意力还给真正重要的判断。', '这也是我想在 EverRoom 里保留“灵感”这一页的原因：捕捉是一瞬间，回看才是长期的工作。'],
  },
  {
    id: 'light-through-window', category: '全部', title: '光线是空间里最柔软的导航',
    excerpt: '在数字空间里，我们也需要一些像窗边光线一样的提示：轻、慢，但准确。',
    source: 'Kinfolk', host: 'kinfolk.com', sourceUrl: 'https://www.kinfolk.com/', date: '2024.08.12', readTime: '5 min',
    image: 'https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=1200&q=85', imageAlt: '窗边的自然光', palette: '#d7d2c3',
    note: '颜色、节奏、动效，都可以成为一种不打扰的引导。', quote: 'Let the light do some of the guiding.',
    body: ['有些提示不需要被读出来。它们可以像窗边的光，随着时间改变，却始终让人知道方向。', '当视觉层级变得清楚，用户就可以把精力放在内容本身。'],
  },
  {
    id: 'slow-web', category: '全部', title: '慢一点，互联网仍然在这里',
    excerpt: '收藏不是囤积。它是和未来的自己约定，某个念头值得被再次打开。',
    source: 'The Creative Independent', host: 'thecreativeindependent.com', sourceUrl: 'https://thecreativeindependent.com/', date: '2024.08.05', readTime: '7 min',
    image: 'https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=1200&q=85', imageAlt: '纸张与手写文字', palette: '#d2bfa7',
    note: '“再次打开”是收藏最好的理由。', quote: 'The internet can still be a place to return to.',
    body: ['我们在网上快速地经过很多东西，却很少真正回到它们。剪藏的意义，是给值得的内容留下一个更慢的入口。', '每一张卡片都是一个小小的路标，标记我曾经在哪里停下来。'],
  },
  {
    id: 'editorial-patience', category: '全部', title: '耐心是一种产品能力',
    excerpt: '不急着把所有答案放在首屏，给探索保留一点余地，体验反而更完整。',
    source: 'Muzli', host: 'muz.li', sourceUrl: 'https://muz.li/', date: '2024.07.29', readTime: '3 min',
    image: 'https://images.unsplash.com/photo-1522542550221-31fd19575a2d?auto=format&fit=crop&w=1200&q=85', imageAlt: '产品设计草图', palette: '#b4c9c5',
    note: '关于“渐进式披露”的一个温柔版本。', quote: 'Not everything needs to arrive at once.',
    body: ['成熟的产品知道什么时候出现，也知道什么时候退后。信息被分层之后，用户拥有了自己的节奏。', '这种耐心不是隐藏功能，而是相信用户可以一步一步走进产品。'],
  },
]

function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function paragraphsFromMarkdown(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => plainTextFromMarkdown(paragraph))
    .filter((paragraph) => paragraph.length > 20)
    .slice(0, 8)
}

function hostFromUrl(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return '网页剪藏' }
}

function mapCapture(capture: BrowserExtensionClipperCapture, markdown: string): InspirationItem {
  const date = new Date(capture.capturedAt)
  const dateLabel = Number.isNaN(date.getTime())
    ? capture.capturedAt.slice(0, 10).replaceAll('-', '.')
    : date.toISOString().slice(0, 10).replaceAll('-', '.')
  const paragraphs = paragraphsFromMarkdown(markdown)
  const excerpt = plainTextFromMarkdown(markdown).slice(0, 140) || '这条网页剪藏还没有可展示的摘要。'
  const asset = capture.assets.find((item) => item.status === 'stored') ?? capture.assets[0]
  const host = hostFromUrl(capture.sourceUrl)
  return {
    id: capture.id,
    category: '全部',
    title: capture.title,
    excerpt,
    source: capture.author || host,
    host,
    sourceUrl: capture.sourceUrl,
    date: dateLabel,
    readTime: `${Math.max(1, Math.round(Math.max(markdown.length, 300) / 900))} min`,
    image: asset?.localUrl || asset?.originalUrl || 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1200&q=85',
    imageAlt: asset?.altText || capture.title,
    palette: '#d7d2c3',
    note: capture.status === 'ready' ? '已保存到本地对象库。' : `剪藏状态：${capture.status}`,
    quote: capture.author ? `Saved from ${capture.author}.` : 'A small thing worth returning to.',
    body: paragraphs.length > 0 ? paragraphs : [excerpt],
  }
}

function masonryColumnCount(): number {
  if (typeof window === 'undefined') return 3
  return window.innerWidth <= 640 ? 1 : window.innerWidth <= 980 ? 2 : 3
}

export function InspirationPage() {
  const { locale } = useLocale()
  const filesApi = window.nxcore?.files
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<InspirationItem | null>(null)
  const [items, setItems] = useState<InspirationItem[]>(() => filesApi?.listClipCaptures ? [] : inspirationItems)
  const [loading, setLoading] = useState(Boolean(filesApi?.listClipCaptures))
  const [sortOrder, setSortOrder] = useState<InspirationSortOrder>('newest')
  const [moreOpen, setMoreOpen] = useState(false)
  const [columnCount, setColumnCount] = useState(masonryColumnCount)
  const [saved, setSaved] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('everroom:inspiration:saved') ?? '[]') as string[]) } catch { return new Set() }
  })

  useEffect(() => {
    let disposed = false
    const loadCaptures = async () => {
      if (!filesApi?.listClipCaptures) {
        setLoading(false)
        return
      }
      try {
        const result = await filesApi.listClipCaptures(200, 0)
        const mapped = await Promise.all(result.items.map(async (capture) => {
          let markdown = ''
          if (capture.fileEntryId) {
            try { markdown = (await filesApi.readMarkdown(capture.fileEntryId, { waitMs: 5_000, pollMs: 250 })).markdown } catch { /* capture metadata is still useful without parsed text */ }
          }
          return mapCapture(capture, markdown)
        }))
        if (!disposed) setItems(mapped)
      } catch {
        // Keep the page usable when the local gateway is unavailable.
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    void loadCaptures()
    return () => { disposed = true }
  }, [filesApi])

  useEffect(() => {
    const handleResize = () => setColumnCount(masonryColumnCount())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale)
    return items
      .filter((item) => !normalized || `${item.title} ${item.excerpt} ${item.source}`.toLocaleLowerCase(locale).includes(normalized))
      .sort((left, right) => {
        const leftTime = Date.parse(left.date.replaceAll('.', '-'))
        const rightTime = Date.parse(right.date.replaceAll('.', '-'))
        return sortOrder === 'newest' ? rightTime - leftTime : leftTime - rightTime
      })
  }, [items, locale, query, sortOrder])

  const masonryColumns = useMemo(() => {
    const columns = Array.from({ length: columnCount }, () => [] as InspirationItem[])
    filteredItems.forEach((item, index) => columns[index % columnCount]!.push(item))
    return columns
  }, [columnCount, filteredItems])

  const toggleSaved = (id: string) => {
    setSaved((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem('everroom:inspiration:saved', JSON.stringify([...next])) } catch { /* persistence is optional */ }
      return next
    })
  }

  const copySelectedLink = async () => {
    if (!selected) return
    try {
      if (window.nxcore?.clipboard) await window.nxcore.clipboard.writeText(`${selected.title}\n${selected.sourceUrl}`)
      else await navigator.clipboard.writeText(`${selected.title}\n${selected.sourceUrl}`)
      showToast({ title: '链接已复制', message: selected.host })
      setMoreOpen(false)
    } catch {
      showToast({ title: '复制失败', message: '当前环境无法访问剪贴板。' })
    }
  }

  const shareSelected = async () => {
    if (!selected) return
    const nativeShareAvailable = typeof navigator.share === 'function'
    try {
      if (nativeShareAvailable) await navigator.share({ title: selected.title, text: selected.excerpt, url: selected.sourceUrl })
      else await copySelectedLink()
      if (nativeShareAvailable) showToast({ title: '分享内容已准备好', message: selected.title })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      showToast({ title: '分享失败', message: '请稍后重试，或使用“更多”复制链接。' })
    }
  }

  if (selected) {
    return (
      <main className="page inspiration-page inspiration-detail-page">
        <div className="inspiration-detail-toolbar">
          <button type="button" className="inspiration-back-button" onClick={() => setSelected(null)}>
            <ArrowLeft aria-hidden="true" /> <span>返回灵感</span>
          </button>
          <div className="inspiration-detail-actions">
            <button type="button" className="inspiration-icon-button" aria-label="分享" title="分享" onClick={() => void shareSelected()}><Share2 aria-hidden="true" /></button>
            <button type="button" className={`inspiration-icon-button ${saved.has(selected.id) ? 'is-saved' : ''}`} aria-label="收藏" title="收藏" onClick={() => toggleSaved(selected.id)}>
              <Bookmark aria-hidden="true" fill={saved.has(selected.id) ? 'currentColor' : 'none'} />
            </button>
            <button type="button" className="inspiration-icon-button" aria-label="更多操作" title="更多操作" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal aria-hidden="true" /></button>
            {moreOpen ? <div className="inspiration-more-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void copySelectedLink()}>复制标题和链接</button>
              <a href={selected.sourceUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setMoreOpen(false)}>打开原网页 <ExternalLink aria-hidden="true" /></a>
            </div> : null}
          </div>
        </div>
        <article className="inspiration-entry">
          <aside className="inspiration-entry-rail">
            <span className="inspiration-entry-day">{selected.date.slice(-2)}</span>
            <span className="inspiration-entry-month">{selected.date.slice(0, 7).replace('.', ' / ')}</span>
            <span className="inspiration-entry-line" />
            <span className="inspiration-entry-label">网页剪藏</span>
          </aside>
          <div className="inspiration-entry-main">
            <div className="inspiration-entry-kicker"><span>{selected.category}</span><i />{selected.source}</div>
            <h1>{selected.title}</h1>
            <p className="inspiration-entry-intro">{selected.excerpt}</p>
            <figure className="inspiration-entry-figure">
              <img src={selected.image} alt={selected.imageAlt} />
              <figcaption><span>{selected.host}</span><span>{selected.readTime} 阅读</span></figcaption>
            </figure>
            <div className="inspiration-entry-copy">
              {selected.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              <blockquote>{selected.quote}</blockquote>
              <p className="inspiration-entry-note"><Sparkles aria-hidden="true" /> {selected.note}</p>
            </div>
            <footer className="inspiration-entry-footer">
              <span><Check aria-hidden="true" /> 已收录到灵感</span>
              <a href={selected.sourceUrl} target="_blank" rel="noreferrer">打开原网页 <ExternalLink aria-hidden="true" /></a>
            </footer>
          </div>
        </article>
      </main>
    )
  }

  return (
    <main className="page inspiration-page">
      <header className="inspiration-header">
        <div className="inspiration-heading">
          <div className="inspiration-eyebrow"><span className="inspiration-eyebrow-mark"><Sparkles aria-hidden="true" /></span> WEB CLIPPINGS · 2024</div>
          <h1>灵感</h1>
          <p>把在网页上遇见的好东西，留给未来的自己。</p>
        </div>
        <div className="inspiration-header-note"><span>本地已收录</span><strong>{String(items.length).padStart(2, '0')}</strong><small>片段</small></div>
      </header>
      <div className="inspiration-toolbar">
        <div className="inspiration-scope" aria-label="当前灵感范围"><span className="inspiration-scope-dot" aria-hidden="true" />全部 <small>实体分类将在进入记忆后启用</small></div>
        <label className="inspiration-search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索剪藏" aria-label="搜索剪藏" />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>×</button> : null}</label>
        <button type="button" className="inspiration-sort" title="切换收录顺序" onClick={() => setSortOrder((order) => order === 'newest' ? 'oldest' : 'newest')}><span>{sortOrder === 'newest' ? '最近收录' : '最早收录'}</span><ChevronDown aria-hidden="true" /></button>
      </div>
      <div className="inspiration-rule" />
      {loading ? <div className="inspiration-empty"><Sparkles aria-hidden="true" /><h2>正在读取本地剪藏</h2><p>正在从本地对象库加载网页内容。</p></div> : filteredItems.length > 0 ? (
        <section className="inspiration-masonry" aria-label="灵感瀑布流">
          {masonryColumns.map((column, columnIndex) => (
            <div key={`masonry-column-${columnIndex}`} className="inspiration-masonry-column">
              {column.map((item) => (
                <article key={item.id} className="inspiration-card" style={{ '--card-palette': item.palette } as CSSProperties}>
                  <button type="button" className="inspiration-card-hit" onClick={() => { setSelected(item); setMoreOpen(false) }} aria-label={`打开：${item.title}`}>
                    <div className="inspiration-card-media"><img src={item.image} alt={item.imageAlt} /><span className="inspiration-card-source">{item.source}</span><span className="inspiration-card-arrow"><ArrowUpRight aria-hidden="true" /></span></div>
                    <div className="inspiration-card-content"><div className="inspiration-card-meta"><span>{item.category}</span><span>{item.date}</span></div><h2>{item.title}</h2><p>{item.excerpt}</p><div className="inspiration-card-footer"><span>{item.readTime} 阅读</span><span className="inspiration-card-host">{item.host}</span></div></div>
                  </button>
                  <button type="button" className={`inspiration-save-button ${saved.has(item.id) ? 'is-saved' : ''}`} aria-label={saved.has(item.id) ? '取消收藏' : '收藏'} title={saved.has(item.id) ? '取消收藏' : '收藏'} onClick={() => toggleSaved(item.id)}><Heart aria-hidden="true" fill={saved.has(item.id) ? 'currentColor' : 'none'} /></button>
                </article>
              ))}
            </div>
          ))}
        </section>
      ) : <div className="inspiration-empty"><Search aria-hidden="true" /><h2>{items.length === 0 ? '还没有网页剪藏' : '没有找到匹配的灵感'}</h2><p>{items.length === 0 ? '在浏览器插件中保存网页后，它们会出现在这里。' : '换一个关键词，或试试查看全部分类。'}</p></div>}
    </main>
  )
}
