import {
  FolderOpen,
  Maximize2,
  Minimize2,
  Minus,
  X,
} from 'lucide-react'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { EditorView } from '@/office-proto/EditorView'
import type { OfficeFile, RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'
import { cn } from '../ui/cn'
import { Hint, IconButton, Spinner } from '../ui/primitives'
import { isArtifactFile } from './fileBrowser'
import { useFileLibrary } from './useFileLibrary'
import { BUBBLE_DEFAULT_WIDTH, type BubbleExitKind, type BubbleState } from './useBubble'
import './bubble.css'

/**
 * 工作空间右侧文件气泡窗：参与 flex 布局挤压内容栏、内部多文件标签、可拖宽。
 *
 * 两种内容态：
 * - 「资料与文件」浏览态（activeFileId === null）：列出文件库，点文件在气泡内打开；
 * - 文档态：只挂载激活文件的编辑器。
 *
 * 原生编辑器（WebContentsView）永远盖在 DOM 之上：切文件/切浏览态时旧宿主卸载 → 矩形归零 →
 * 主进程隐藏旧实例；同时分发一次 resize 事件让新宿主立刻重报矩形，避免迟到的 ZERO 把新实例也藏掉。
 */
export function BubbleWindow({
  bubble, exiting = null, onResize, onMinimize, onToggleMax, onClose,
  onActivateFile, onCloseFile, onBrowse, onOpenFile, onToast, workspaceId,
}: {
  bubble: BubbleState
  /** 退场动画中：DOM 保留但禁用交互，动画结束后由宿主卸载（'close' 关闭 / 'minimize' 收起）。 */
  exiting?: BubbleExitKind | null
  onResize: (width: number) => void
  onMinimize: () => void
  onToggleMax: () => void
  onClose: () => void
  onActivateFile: (fileId: string) => void
  onCloseFile: (fileId: string) => void
  /** 切到「资料与文件」浏览态（activeFileId=null 的推导由 host 负责）。 */
  onBrowse: () => void
  /** 从浏览列表里打开文件（加进气泡标签并切到文档态）。 */
  onOpenFile: (file: OfficeFile) => void
  onToast: (message: string) => void
  /** 浏览列表按工作空间过滤（资料库/产物库独立）。 */
  workspaceId?: string
}) {
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  /**
   * 内层内容冻结宽度：
   * 面板宽度动画（展开/收起/关闭）期间，如果让内部列表跟着逐帧重排，文字会不断换行，看起来在抖。
   * 这里在动画期间把内层固定成动画开始时的宽度、由外层 overflow 裁剪，文字不再重排，只做平移/裁剪。
   */
  const sectionRef = useRef<HTMLElement>(null)
  const [freezeWidth, setFreezeWidth] = useState<number | null>(null)

  // 退场：dock 态直接用已知宽度冻结（别量，能量到动画第一帧的中间值 → 内层会跳一下）；
  // 最大化态宽度是 clamp 值，只能量一次。
  useLayoutEffect(() => {
    if (!exiting) return
    if (!bubble.maximized) {
      setFreezeWidth(bubble.width)
      return
    }
    const width = sectionRef.current?.getBoundingClientRect().width
    if (width) setFreezeWidth(width)
  }, [exiting, bubble.maximized, bubble.width])

  // 宽度过渡（展开 / 最大化 / 还原）期间把内层冻结成「目标宽度」，
  // 面板只做裁剪动画，列表/文字不逐帧重排，避免动画中的抖动。
  useEffect(() => {
    if (exiting) return
    const parentWidth = sectionRef.current?.parentElement?.getBoundingClientRect().width ?? 0
    const target = bubble.maximized
      ? Math.min(1040, Math.max(320, parentWidth - 336))
      : bubble.width
    setFreezeWidth(target)
    const timer = window.setTimeout(() => setFreezeWidth(null), 280)
    return () => window.clearTimeout(timer)
  }, [exiting, bubble.maximized, bubble.width])

  const startResize = (event: React.PointerEvent) => {
    if (bubble.maximized) return
    event.preventDefault()
    resizingRef.current = true
    setResizing(true)
    const startX = event.clientX
    const startWidth = bubble.width
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX)
      onResize(next)
    }
    const onUp = () => {
      resizingRef.current = false
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // 拖拽期间原生宿主被 CSS 隐藏；结束后让 host 重新上报矩形。
      window.setTimeout(() => window.dispatchEvent(new Event('resize')), 40)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activate = (fileId: string) => {
    onActivateFile(fileId)
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
  }

  const browse = () => {
    onBrowse()
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60)
  }

  const browsing = bubble.activeFileId === null
  const active = bubble.files.find((file) => file.id === bubble.activeFileId) ?? null

  return (
    <section
      ref={sectionRef}
      className={cn(
        'wb-bubble',
        bubble.maximized && 'is-maximized',
        resizing && 'is-resizing',
        exiting === 'close' && 'is-closing',
        exiting === 'minimize' && 'is-minimizing',
      )}
      style={bubble.maximized ? undefined : { width: bubble.width || BUBBLE_DEFAULT_WIDTH }}
      aria-label="资料与文件"
    >
      {!bubble.maximized ? (
        <div
          className="wb-bubble-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整气泡窗宽度"
          onPointerDown={startResize}
        />
      ) : null}

      <div
        className="wb-bubble-inner"
        style={freezeWidth ? { width: freezeWidth } : undefined}
      >
      <div className="wb-bubble-head">
        <Hint label={browsing ? '当前正在浏览文件库' : '浏览资料与文件'}>
          <IconButton
            label="浏览资料与文件"
            size="sm"
            icon={<FolderOpen size={14} />}
            active={browsing}
            aria-expanded={browsing}
            onClick={browse}
          />
        </Hint>
        <div className="wb-bubble-tabs" role="tablist" aria-label="气泡窗文件">
          {bubble.files.map((file) => (
            <div
              key={file.id}
              role="tab"
              aria-selected={file.id === active?.id}
              tabIndex={0}
              className={cn('wb-bubble-tab', file.id === active?.id && 'is-active')}
              title={file.name}
              onClick={() => activate(file.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activate(file.id)
                }
              }}
            >
              <FileTypeIcon kind={file.kind} size={15} />
              <span className="wb-bubble-tab-name">{file.name}</span>
              <button
                type="button"
                className="wb-bubble-tab-close"
                title="关闭文件"
                aria-label={`关闭 ${file.name}`}
                onClick={(event) => { event.stopPropagation(); onCloseFile(file.id) }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="wb-bubble-ctl">
          <Hint label="收起">
            <IconButton label="收起" size="sm" icon={<Minus size={13} />} onClick={onMinimize} />
          </Hint>
          <Hint label={bubble.maximized ? '还原' : '最大化'}>
            <IconButton
              label={bubble.maximized ? '还原' : '最大化'}
              size="sm"
              icon={bubble.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              onClick={onToggleMax}
            />
          </Hint>
          <Hint label="关闭">
            <IconButton label="关闭" size="sm" tone="danger" icon={<X size={13} />} onClick={onClose} />
          </Hint>
        </div>
      </div>

      <div className="wb-bubble-body">
        {browsing ? (
          <BubbleBrowser onOpenFile={onOpenFile} workspaceId={workspaceId} />
        ) : active ? (
          <div className="wb-bubble-doc" key={active.id}>
            <EditorView file={active} onToast={onToast} hideSideDock />
          </div>
        ) : (
          <div className="wb-bubble-empty">还没有打开文件</div>
        )}
      </div>
      </div>
    </section>
  )
}

/* ───────────────── 气泡内的「资料与文件」列表 ───────────────── */

type BrowserScope = 'all' | 'material' | 'output'

const SCOPES: ReadonlyArray<{ key: BrowserScope; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'material', label: '资料' },
  { key: 'output', label: '产物' },
]

/**
 * 窄面板里的文件库列表：资料/产物筛选 + 点开即进气泡标签。
 * workspaceId 传入时按工作空间过滤（资料库/产物库独立）；缺省拉全库。
 */
function BubbleBrowser({ onOpenFile, workspaceId }: {
  onOpenFile: (file: OfficeFile) => void
  workspaceId?: string
}) {
  const library = useFileLibrary(workspaceId)
  const [scope, setScope] = useState<BrowserScope>('all')

  const items = useMemo(() => {
    if (scope === 'all') return library.items
    return library.items.filter((item) => isArtifactFile(item) === (scope === 'output'))
  }, [library.items, scope])

  const counts = useMemo(() => ({
    all: library.items.length,
    material: library.items.filter((item) => !isArtifactFile(item)).length,
    output: library.items.filter((item) => isArtifactFile(item)).length,
  }), [library.items])

  return (
    <div className="wb-bubble-browser">
      <div className="wb-bubble-browser-scopes" role="group" aria-label="资料类型">
        {SCOPES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={scope === item.key}
            className={cn('wb-bubble-scope', scope === item.key && 'is-active')}
            onClick={() => setScope(item.key)}
          >
            {item.label}
            <span>{counts[item.key]}</span>
          </button>
        ))}
      </div>

      <div className="wb-bubble-browser-list" role="list">
        {library.state === 'loading' ? (
          <div className="wb-bubble-browser-state"><Spinner size={13} /></div>
        ) : null}
        {library.state === 'unavailable' ? (
          <div className="wb-bubble-browser-state">文件库暂不可用</div>
        ) : null}
        {library.state === 'ready' && items.length === 0 ? (
          <div className="wb-bubble-browser-state">没有匹配的文件</div>
        ) : null}
        {library.state === 'ready' ? items.map((item) => (
          <BubbleBrowserRow key={item.file.id} item={item} onOpen={onOpenFile} />
        )) : null}
      </div>

      {library.state === 'ready' && library.total > library.items.length ? (
        <div className="wb-bubble-browser-note">
          最近 {library.items.length} / 共 {library.total} 个
        </div>
      ) : null}
    </div>
  )
}

function BubbleBrowserRow({ item, onOpen }: { item: RealOfficeFile; onOpen: (file: OfficeFile) => void }) {
  const meta = [item.catalog.sourceLabel, item.file.updatedLabel, item.file.sizeLabel]
    .filter((part) => part && part !== '—')
    .join(' · ')
  return (
    <button
      type="button"
      role="listitem"
      className="wb-bubble-browser-row"
      title={item.file.name}
      onClick={() => onOpen(item.file)}
    >
      <FileTypeIcon kind={item.file.kind} size={24} />
      <span className="wb-bubble-browser-row-main">
        <span className="wb-bubble-browser-row-name">{item.file.name}</span>
        <span className="wb-bubble-browser-row-meta">{meta}</span>
      </span>
    </button>
  )
}
