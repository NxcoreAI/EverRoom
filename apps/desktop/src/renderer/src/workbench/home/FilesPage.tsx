import { FolderOpen, LayoutGrid, List, RotateCw, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'

import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { workbenchToast } from '../shell/toast'
import { cn } from '../ui/cn'
import { Button, EmptyState, PageHeader, Segmented } from '../ui/primitives'
import { HomeSkeleton } from './parts'
import { useFileLibrary } from './useFileLibrary'

type ViewMode = 'list' | 'grid'

interface SourceFilter {
  key: string
  label: string
  count: number
}

const ALL_SOURCES = 'all'

/** 所有文件页：真实文件库（一页 200 条）+ 搜索 + 来源筛选 + 列表/网格切换 + 导入。 */
export function FilesPage() {
  const openFileTab = useWorkbenchStore((state) => state.openFileTab)
  const files = useFileLibrary(200)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<string>(ALL_SOURCES)
  const [view, setView] = useState<ViewMode>('list')
  const [importing, setImporting] = useState(false)

  const sources = useMemo<SourceFilter[]>(() => {
    const byKind = new Map<string, SourceFilter>()
    for (const item of files.items) {
      const key = item.catalog.sourceKind
      const existing = byKind.get(key)
      if (existing) {
        existing.count += 1
        continue
      }
      byKind.set(key, { key, label: item.catalog.sourceLabel || '其他来源', count: 1 })
    }
    return [...byKind.values()].sort((left, right) => right.count - left.count)
  }, [files.items])

  // 刷新后来源消失时回落「全部」，避免筛选到空集。
  const activeSource = source === ALL_SOURCES || sources.some((item) => item.key === source) ? source : ALL_SOURCES

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.items.filter((item) => {
      if (activeSource !== ALL_SOURCES && item.catalog.sourceKind !== activeSource) return false
      return !keyword || item.file.name.toLowerCase().includes(keyword)
    })
  }, [activeSource, files.items, query])

  const canImport = typeof window.nxcore?.files?.pickAndImport === 'function'
  const filtering = query.trim().length > 0 || activeSource !== ALL_SOURCES

  const handleImport = async () => {
    if (importing || !canImport) return
    setImporting(true)
    try {
      const outcomes = await window.nxcore!.files.pickAndImport()
      const imported = outcomes?.length ?? 0
      if (imported > 0) {
        workbenchToast(`已导入 ${imported} 个文件`)
        files.reload()
      }
    } catch (error) {
      workbenchToast(error instanceof Error && error.message ? error.message : '导入文件失败')
    } finally {
      setImporting(false)
    }
  }

  const subtitle = files.state === 'ready'
    ? files.total > 0
      ? `文件库共 ${files.total} 个文件；可打开文档按最近更新排序。`
      : '文件库还没有文件，导入后会出现在这里。'
    : files.state === 'loading'
      ? '正在读取文件库…'
      : '文件库暂不可用。'

  return (
    <div className="wb-home-scroll">
      <PageHeader
        eyebrow="文件库"
        title="所有文件"
        subtitle={subtitle}
        actions={(
          <Button
            variant="primary"
            icon={<Upload size={15} />}
            disabled={!canImport || importing}
            title={canImport ? '导入本地文件' : '桌面文件服务未就绪，暂时无法导入'}
            onClick={() => { void handleImport() }}
          >
            {importing ? '导入中…' : '导入文件'}
          </Button>
        )}
      />

      <div className="wb-home-toolbar">
        <label className="wb-home-search">
          <input
            className="ui-input"
            type="search"
            aria-label="搜索文件"
            placeholder="搜索文件名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {files.state === 'ready' && sources.length > 0 ? (
          <div className="wb-home-chips" role="group" aria-label="按来源筛选">
            <button
              type="button"
              className={cn('wb-chip', activeSource === ALL_SOURCES && 'is-active')}
              aria-pressed={activeSource === ALL_SOURCES}
              onClick={() => setSource(ALL_SOURCES)}
            >
              全部
              <span className="wb-chip-count">{files.items.length}</span>
            </button>
            {sources.map((item) => (
              <button
                key={item.key}
                type="button"
                className={cn('wb-chip', activeSource === item.key && 'is-active')}
                aria-pressed={activeSource === item.key}
                onClick={() => setSource(item.key)}
              >
                {item.label}
                <span className="wb-chip-count">{item.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="wb-home-toolbar-right">
          {files.state === 'ready' ? (
            <span className="wb-home-toolbar-meta">
              {filtering ? `匹配 ${filtered.length} / ${files.items.length}` : `${files.items.length} 个可打开文档`}
            </span>
          ) : null}
          <Segmented<ViewMode>
            ariaLabel="文件视图"
            value={view}
            onChange={setView}
            items={[
              { key: 'list', label: '列表', icon: <List size={13} /> },
              { key: 'grid', label: '网格', icon: <LayoutGrid size={13} /> },
            ]}
          />
        </div>
      </div>

      {files.state === 'loading' ? <HomeSkeleton rows={5} /> : null}

      {files.state === 'unavailable' ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title="文件库暂不可用"
          description="当前无法连接桌面文件服务（浏览器预览或网关未就绪时属预期）。"
          action={<Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={files.reload}>重试</Button>}
        />
      ) : null}

      {files.state === 'ready' && files.items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={18} />}
          title="文件库还没有文件"
          description="导入本地文档或从连接器同步资料，之后就能在这里打开。"
          action={canImport ? (
            <Button variant="primary" size="sm" icon={<Upload size={13} />} onClick={() => { void handleImport() }}>
              导入文件
            </Button>
          ) : null}
        />
      ) : null}

      {files.state === 'ready' && files.items.length > 0 && filtered.length === 0 ? (
        <div className="wb-home-empty">没有匹配的文件 · 换个关键词或来源试试。</div>
      ) : null}

      {files.state === 'ready' && filtered.length > 0 && view === 'list' ? (
        <div className="wb-home-list">
          {filtered.map((item) => (
            <button
              key={item.file.id}
              type="button"
              className="wb-home-row"
              title={item.file.name}
              onClick={() => openFileTab(item.file)}
            >
              <FileTypeIcon kind={item.file.kind} size={28} />
              <span className="wb-home-row-main">
                <span className="wb-home-row-title">
                  <span className="wb-home-truncate">{item.file.name}</span>
                </span>
                <span className="wb-home-row-sub">
                  {[item.catalog.sourceLabel, item.file.updatedLabel, item.file.sizeLabel]
                    .filter((part) => part && part !== '—')
                    .join(' · ')}
                </span>
              </span>
              <span className="wb-home-row-meta">{item.file.kind.toUpperCase()}</span>
            </button>
          ))}
        </div>
      ) : null}

      {files.state === 'ready' && filtered.length > 0 && view === 'grid' ? (
        <div className="wb-home-file-grid">
          {filtered.map((item) => (
            <button
              key={item.file.id}
              type="button"
              className="wb-home-file-tile"
              title={item.file.name}
              onClick={() => openFileTab(item.file)}
            >
              <FileTypeIcon kind={item.file.kind} size={38} />
              <span className="wb-home-file-tile-name">{item.file.name}</span>
              <span className="wb-home-file-tile-meta">
                {[item.catalog.sourceLabel, item.file.updatedLabel].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {files.state === 'ready' && filtered.length > 0 && files.total > files.items.length ? (
        <p className="wb-home-footnote">
          当前加载最近 {files.items.length} 个可打开文档（文件库共 {files.total} 个条目）。
        </p>
      ) : null}
    </div>
  )
}
