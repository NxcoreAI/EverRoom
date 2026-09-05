import type { ExternalDocumentCommentView } from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { Check, MessageSquare, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import type { LocalDocumentComment } from '../../../../../../../shared/sources'
import { SourceIcon } from '../../../../pages/sources/SourceIcon'
import {
  COMMENT_ANCHOR_CLICKED_EVENT,
  resolveCommentRanges,
  setCommentAnchorRanges,
} from './commentAnchorDecorations'
import './ExternalDocumentDialogs.css'

/**
 * 评论面板（飞书式锚定）：本地划词评论与导入的飞书评论统一按 quotedText 锚定
 * 在正文对应高度；卡片层与编辑器共用同一滚动坐标系（translateY 跟随编辑器
 * scrollTop），正文滚动时卡片同步移动。悬停卡片高亮锚定文本，点击卡片滚动
 * 编辑器到锚点；未命中锚点的评论固定在面板底部"未定位评论"区。
 * 收起态（collapsed）不渲染停靠栏，但仍标记有评论的正文文本，点击标记展开面板。
 */

const HOVER_HIGHLIGHT_CLASS = 'context-room-comment-anchor-hovering'

interface ThreadAnchor {
  id: string
  kind: 'local' | 'imported'
  /** 相对编辑器滚动内容顶部的 offset；null = 未定位。 */
  top: number | null
  host: Element | null
}

export function ImportedCommentsPanel({
  editor,
  roomId,
  documentId,
  onClose,
  collapsed = false,
  onOpen,
}: {
  editor: Editor | null
  roomId: string
  documentId: string
  onClose: () => void
  /** 收起态：不渲染停靠栏，但仍在正文标记有评论的文本，点击标记展开面板。 */
  collapsed?: boolean
  onOpen?: () => void
}) {
  const { t, locale } = useLocale()
  const [comments, setComments] = useState<ExternalDocumentCommentView[] | null>(null)
  const [localComments, setLocalComments] = useState<LocalDocumentComment[] | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const hoverHostRef = useRef<Element | null>(null)
  const pendingFlashRef = useRef<string | null>(null)
  const [anchors, setAnchors] = useState<ThreadAnchor[]>([])
  const [laidTops, setLaidTops] = useState<Record<string, number>>({})
  const [contentHeight, setContentHeight] = useState(0)
  const [dockHeight, setDockHeight] = useState(0)

  /** 编辑器真正的滚动祖先：向上找第一个 overflow 可滚动且内容超出的元素。 */
  const scrollerOf = useCallback((): HTMLElement | null => {
    const dom = editor?.view?.dom
    if (!dom) return null
    let element: HTMLElement | null = dom.parentElement
    while (element) {
      const style = window.getComputedStyle(element)
      const scrollable = /(auto|scroll|overlay)/.test(`${style.overflowY}${style.overflow}`)
      if (scrollable && element.scrollHeight > element.clientHeight + 1) return element
      if (element === document.body) break
      element = element.parentElement
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.body
  }, [editor])

  const reloadLocalComments = useCallback(() => {
    void window.nxcore?.documents.listDocumentComments(documentId)
      .then((result) => setLocalComments(result.items))
      .catch(() => setLocalComments([]))
  }, [documentId])

  useEffect(() => {
    let cancelled = false
    setComments(null)
    void window.nxcore?.externalDocuments.importHistory(roomId, documentId)
      .then((result) => {
        if (!cancelled) setComments(result.comments)
      })
      .catch(() => {
        if (!cancelled) setComments([])
      })
    return () => {
      cancelled = true
    }
  }, [roomId, documentId])

  useEffect(() => {
    reloadLocalComments()
  }, [reloadLocalComments])

  // 划词气泡等入口新增/变更评论时实时刷新（documentId 匹配才刷）。
  useEffect(() => {
    const onCommentsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ documentId?: string }>).detail
      if (detail?.documentId && detail.documentId !== documentId) return
      reloadLocalComments()
    }
    window.addEventListener('everroom:document-comments-changed', onCommentsChanged)
    return () => window.removeEventListener('everroom:document-comments-changed', onCommentsChanged)
  }, [documentId, reloadLocalComments])

  const formatTime = (value: string | null): string => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  /** quotedText → 锚点（layer 坐标 + scrollTop 滚动不变量），本地/导入统一；失败归未定位。 */
  const computeAnchors = useCallback((): ThreadAnchor[] => {
    const dom = editor?.view?.dom
    const scroller = scrollerOf()
    const layer = layerRef.current
    const fallbackFor = (id: string, kind: ThreadAnchor['kind']): ThreadAnchor => ({ id, kind, top: null, host: null })
    if (!dom || !scroller) {
      const result: ThreadAnchor[] = []
      for (const comment of localComments ?? []) {
        if (comment.parentId === null) result.push(fallbackFor(comment.id, 'local'))
      }
      for (const comment of comments ?? []) {
        if (comment.parentId === null) result.push(fallbackFor(comment.id, 'imported'))
      }
      return result
    }
    const normalize = (value: string): string => value.replace(/[\s　]+/g, '')
    const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let full = ''
    let node: Node | null
    while ((node = walker.nextNode()) !== null) {
      const text = node as Text
      nodes.push(text)
      full += text.nodeValue ?? ''
    }
    const normalizedFull = normalize(full)
    const starts: number[] = []
    let acc = 0
    for (const text of nodes) {
      starts.push(acc)
      acc += normalize(text.nodeValue ?? '').length
    }
    const nodeAtNormalized = (position: number): Element | null => {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        if (starts[index]! <= position) return nodes[index]!.parentElement
      }
      return nodes[0]?.parentElement ?? null
    }
    // 停靠栏未渲染（收起态）时 layer 为空：只定位 host 不算坐标，标记仍然成立。
    const layerTop = layer ? layer.getBoundingClientRect().top : 0
    const toAnchor = (host: Element | null): { top: number; host: Element } | null => {
      if (!host || !layer) return null
      // layer 坐标 + 当前 scrollTop：滚动不变量（滚动时只更新 translateY）。
      const top = host.getBoundingClientRect().top - layerTop + scroller.scrollTop
      return { top, host }
    }
    // 同一段文字出现多次时按出现顺序依次锚定：第二条同文评论锚到第二处，避免全挤到首处。
    const quoteCursor = new Map<string, number>()
    const anchorOf = (
      id: string,
      kind: ThreadAnchor['kind'],
      quotedText: string | null,
      blockId: string | null,
    ): ThreadAnchor => {
      // 优先按稳定块 id 定位（data-block-id，随块移动，正文编辑后仍有效），失败退化到引用文本匹配。
      let host: Element | null = null
      if (blockId) {
        host = dom.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
      }
      if (!host) {
        const quote = quotedText ? normalize(quotedText).slice(0, 80) : ''
        if (quote.length >= 2) {
          const hit = normalizedFull.indexOf(quote, quoteCursor.get(quote) ?? 0)
          if (hit >= 0) {
            quoteCursor.set(quote, hit + quote.length)
            host = nodeAtNormalized(hit)
          }
        }
      }
      if (!host) return fallbackFor(id, kind)
      const anchored = toAnchor(host)
      if (anchored) return { id, kind, ...anchored }
      return { id, kind, top: null, host }
    }
    const result: ThreadAnchor[] = []
    for (const comment of localComments ?? []) {
      if (comment.parentId !== null) continue
      result.push(anchorOf(comment.id, 'local', comment.quotedText, comment.blockId))
    }
    for (const comment of comments ?? []) {
      if (comment.parentId !== null) continue
      result.push(anchorOf(comment.id, 'imported', comment.quotedText, null))
    }
    return result
  }, [comments, editor, localComments, scrollerOf])

  // 锚点重算时机：评论变化 / 编辑器内容更新 / 窗口缩放。
  useEffect(() => {
    const recompute = (): void => {
      const next = computeAnchors()
      setAnchors(next)
      const scroller = scrollerOf()
      setContentHeight(scroller ? scroller.scrollHeight : 0)
      setDockHeight(scroller ? scroller.clientHeight : 0)
    }
    recompute()
    const onResize = (): void => recompute()
    window.addEventListener('resize', onResize)
    let onUpdate: (() => void) | null = null
    if (editor) {
      onUpdate = () => recompute()
      editor.on('update', onUpdate)
    }
    // 图片异步加载/字体替换等纯布局变化不触发 editor update，ResizeObserver 兜底重算。
    let resizeObserver: ResizeObserver | null = null
    const editorDom = editor?.view?.dom ?? null
    if (editorDom && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => recompute())
      resizeObserver.observe(editorDom)
      const scroller = scrollerOf()
      if (scroller) resizeObserver.observe(scroller)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      if (editor && onUpdate) editor.off('update', onUpdate)
      resizeObserver?.disconnect()
    }
  }, [computeAnchors, editor, scrollerOf, collapsed])

  // 滚动跟随：卡片层与编辑器共用滚动坐标系，只平移不重排。
  useEffect(() => {
    const scroller = scrollerOf()
    if (!scroller) return
    const onScroll = (): void => {
      if (trackRef.current) trackRef.current.style.transform = `translateY(${String(-scroller.scrollTop)}px)`
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scrollerOf, anchors])

  // 评论 → PM 行内装饰（黄色下划线，与手动 <u> 区分）：装饰随文档编辑自动映射，
  // 不再需要 DOM 涂标记与自愈观察器；评论列表变化或正文更新时重新解析范围。
  useEffect(() => {
    if (!editor) return
    const sync = (): void => {
      const threads = [
        ...(localComments ?? []).filter((comment) => comment.parentId === null)
          .map((comment) => ({ id: comment.id, blockId: comment.blockId, quotedText: comment.quotedText })),
        ...(comments ?? []).filter((comment) => comment.parentId === null)
          .map((comment) => ({ id: comment.id, blockId: null, quotedText: comment.quotedText })),
      ]
      setCommentAnchorRanges(editor, resolveCommentRanges(editor.state.doc, threads))
    }
    sync()
    const onUpdate = (): void => sync()
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
      if (!editor.isDestroyed) setCommentAnchorRanges(editor, [])
    }
  }, [editor, comments, localComments])

  // 点击正文评论装饰：收起态展开面板（展开后闪亮对应卡片），展开态直接闪亮卡片。
  const flashCard = useCallback((threadId: string): void => {
    const card = cardRefs.current.get(threadId)
    if (!card) return
    card.classList.add('is-flash')
    window.setTimeout(() => card.classList.remove('is-flash'), 1200)
  }, [])

  useEffect(() => {
    if (!collapsed && pendingFlashRef.current) {
      const threadId = pendingFlashRef.current
      pendingFlashRef.current = null
      const timer = window.setTimeout(() => flashCard(threadId), 200)
      return () => window.clearTimeout(timer)
    }
  }, [collapsed, flashCard])

  useEffect(() => {
    const onAnchorClicked = (event: Event): void => {
      const commentId = (event as CustomEvent<{ commentId?: string }>).detail?.commentId
      if (!commentId) return
      if (collapsed) {
        pendingFlashRef.current = commentId
        onOpen?.()
      } else {
        flashCard(commentId)
      }
    }
    window.addEventListener(COMMENT_ANCHOR_CLICKED_EVENT, onAnchorClicked)
    return () => window.removeEventListener(COMMENT_ANCHOR_CLICKED_EVENT, onAnchorClicked)
  }, [collapsed, onOpen, flashCard])

  const anchored = useMemo(
    () => anchors.filter((anchor) => anchor.top !== null).sort((a, b) => (a.top ?? 0) - (b.top ?? 0)),
    [anchors],
  )
  const unanchored = useMemo(() => anchors.filter((anchor) => anchor.top === null), [anchors])

  // 防重叠排布：锚点位置起，自上而下错开（飞书同款行为）。
  useLayoutEffect(() => {
    const next: Record<string, number> = {}
    let cursor = -Infinity
    for (const anchor of anchored) {
      const card = cardRefs.current.get(anchor.id)
      const height = card ? card.offsetHeight : 0
      const desired = anchor.top ?? 0
      const top = Math.max(desired, cursor + 10)
      next[anchor.id] = top
      cursor = top + height
    }
    setLaidTops((current) => {
      const ids = new Set([...Object.keys(current), ...Object.keys(next)])
      for (const id of ids) {
        if (Math.abs((current[id] ?? -1) - (next[id] ?? -1)) > 0.5) return next
      }
      return current
    })
  }, [anchored])

  const setHoverHost = (host: Element | null): void => {
    if (hoverHostRef.current === host) return
    hoverHostRef.current?.classList.remove(HOVER_HIGHLIGHT_CLASS)
    hoverHostRef.current = host
    host?.classList.add(HOVER_HIGHLIGHT_CLASS)
  }

  useEffect(() => () => {
    setHoverHost(null)
  }, [])


  const scrollToAnchor = (anchor: ThreadAnchor): void => {
    if (anchor.top === null) return
    const scroller = scrollerOf()
    scroller?.scrollTo({ top: Math.max(0, anchor.top - 80), behavior: 'smooth' })
  }

  const repliesOf = (parentId: string): ExternalDocumentCommentView[] =>
    comments?.filter((reply) => reply.parentId === parentId) ?? []
  const localRepliesOf = (parentId: string): LocalDocumentComment[] =>
    localComments?.filter((reply) => reply.parentId === parentId) ?? []

  const resolveLocal = async (commentId: string, resolved: boolean) => {
    try {
      await window.nxcore?.documents.resolveDocumentComment(documentId, commentId, resolved)
      reloadLocalComments()
    } catch {
      // 失败时下一轮打开面板会重新拉取。
    }
  }

  const deleteLocal = async (commentId: string) => {
    try {
      await window.nxcore?.documents.deleteDocumentComment(documentId, commentId)
      reloadLocalComments()
    } catch {
      // 同上。
    }
  }

  const renderCard = (anchor: ThreadAnchor): ReactNode => {
    if (anchor.kind === 'local') {
      const comment = localComments?.find((item) => item.id === anchor.id)
      if (!comment) return null
      return (
        <article
          key={anchor.id}
          ref={(element) => {
            if (element) cardRefs.current.set(anchor.id, element)
            else cardRefs.current.delete(anchor.id)
          }}
          className="context-room-imported-comment context-room-imported-comment-floating"
          data-resolved={String(comment.resolved)}
          style={{ top: `${String(laidTops[anchor.id] ?? anchor.top ?? 0)}px` }}
          onMouseEnter={() => setHoverHost(anchor.host)}
          onMouseLeave={() => setHoverHost(null)}
          onClick={() => scrollToAnchor(anchor)}
        >
          <header>
                        <time>{formatTime(comment.createdAt)}</time>
            {comment.resolved && (
              <em className="context-room-imported-comment-resolved">
                <Check size={11} aria-hidden="true" />
                {t('contextRoom:importedComments.resolved')}
              </em>
            )}
            <button type="button" className="context-room-imported-comment-action" title={t('contextRoom:importedComments.resolve')} onClick={(event) => { event.stopPropagation(); void resolveLocal(comment.id, !comment.resolved) }}>
              <Check size={12} aria-hidden="true" />
            </button>
            <button type="button" className="context-room-imported-comment-action danger" title={t('contextRoom:importedComments.delete')} onClick={(event) => { event.stopPropagation(); void deleteLocal(comment.id) }}>
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </header>
          <p>{comment.body}</p>
          {localRepliesOf(comment.id).length > 0 && (
            <div className="context-room-imported-comment-replies">
              {localRepliesOf(comment.id).map((reply) => (
                <div key={reply.id} className="context-room-imported-comment-reply">
                                    <p>{reply.body}</p>
                </div>
              ))}
            </div>
          )}
        </article>
      )
    }
    const comment = comments?.find((item) => item.id === anchor.id)
    if (!comment) return null
    return (
      <article
        key={anchor.id}
        ref={(element) => {
          if (element) cardRefs.current.set(anchor.id, element)
          else cardRefs.current.delete(anchor.id)
        }}
        className="context-room-imported-comment context-room-imported-comment-floating"
        data-resolved={String(comment.resolved === true)}
        style={{ top: `${String(laidTops[anchor.id] ?? anchor.top ?? 0)}px` }}
        onMouseEnter={() => setHoverHost(anchor.host)}
        onMouseLeave={() => setHoverHost(null)}
        onClick={() => scrollToAnchor(anchor)}
      >
        <header>
          <SourceIcon kind="feishu" className="context-room-imported-comment-source" />
                    <time>{formatTime(comment.createdAt)}</time>
          {comment.resolved === true && (
            <em className="context-room-imported-comment-resolved">
              <Check size={11} aria-hidden="true" />
              {t('contextRoom:importedComments.resolved')}
            </em>
          )}
        </header>
        <p>{comment.body}</p>
        {repliesOf(comment.id).length > 0 && (
          <div className="context-room-imported-comment-replies">
            {repliesOf(comment.id).map((reply) => (
              <div key={reply.id} className="context-room-imported-comment-reply">
                                <p>{reply.body}</p>
              </div>
            ))}
          </div>
        )}
      </article>
    )
  }

  const total = (comments?.length ?? 0) + (localComments?.length ?? 0)

  // 收起态：不渲染停靠栏，锚点装饰与点击展开逻辑在上面的 effects 里继续工作。
  if (collapsed) return null

  return (
    <aside
      className="context-room-imported-comments-dock"
      style={dockHeight > 0 ? { height: `${String(dockHeight)}px` } : undefined}
      aria-label={t('contextRoom:importedComments.panelTitle')}
    >
      <header>
        <strong>{t('contextRoom:importedComments.panelTitle')}</strong>
        <span className="context-room-imported-comments-count">
          {total > 0 ? t('contextRoom:importedComments.count', { count: String(total) }) : ''}
        </span>
        <button type="button" aria-label={t('contextRoom:importedComments.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div ref={layerRef} className="context-room-imported-comments-layer">
        {comments === null || localComments === null ? (
          <p className="context-room-imported-comments-empty">{t('contextRoom:importedComments.loading')}</p>
        ) : total === 0 ? (
          <div className="context-room-imported-comments-empty">
            <MessageSquare aria-hidden="true" />
            <p>{t('contextRoom:importedComments.empty')}</p>
            <small>{t('contextRoom:importedComments.emptyHint')}</small>
          </div>
        ) : (
          <>
            <div
              ref={trackRef}
              className="context-room-imported-comments-track"
              style={{ height: `${String(Math.max(contentHeight, 1))}px` }}
            >
              {anchored.map((anchor) => renderCard(anchor))}
            </div>
            {anchored.length === 0 && (
              <div className="context-room-imported-comments-no-anchor-hint">
                {t('contextRoom:importedComments.anchorUnavailable')}
              </div>
            )}
            {unanchored.length > 0 && (
              <div className="context-room-imported-comments-unanchored">
                <div className="context-room-imported-comments-section-label">
                  {t('contextRoom:importedComments.unlocatedSection')}
                </div>
                {unanchored.map((anchor) => (
                  <div key={anchor.id} data-kind={anchor.kind}>
                    {anchor.kind === 'local'
                      ? (() => {
                          const comment = localComments?.find((item) => item.id === anchor.id)
                          if (!comment) return null
                          return (
                            <article className="context-room-imported-comment" data-resolved={String(comment.resolved)}>
                              <header>
                                                                <time>{formatTime(comment.createdAt)}</time>
                                {comment.resolved && (
                                  <em className="context-room-imported-comment-resolved">
                                    <Check size={11} aria-hidden="true" />
                                    {t('contextRoom:importedComments.resolved')}
                                  </em>
                                )}
                                <button type="button" className="context-room-imported-comment-action" title={t('contextRoom:importedComments.resolve')} onClick={() => void resolveLocal(comment.id, !comment.resolved)}>
                                  <Check size={12} aria-hidden="true" />
                                </button>
                                <button type="button" className="context-room-imported-comment-action danger" title={t('contextRoom:importedComments.delete')} onClick={() => void deleteLocal(comment.id)}>
                                  <Trash2 size={12} aria-hidden="true" />
                                </button>
                              </header>
                              <p>{comment.body}</p>
                            </article>
                          )
                        })()
                      : (() => {
                          const comment = comments?.find((item) => item.id === anchor.id)
                          if (!comment) return null
                          return (
                            <article className="context-room-imported-comment" data-resolved={String(comment.resolved === true)}>
                              <header>
                                <SourceIcon kind="feishu" className="context-room-imported-comment-source" />
                                                                <time>{formatTime(comment.createdAt)}</time>
                              </header>
                              <p>{comment.body}</p>
                            </article>
                          )
                        })()}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
