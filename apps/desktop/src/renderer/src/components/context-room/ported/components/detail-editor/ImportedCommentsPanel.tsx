import type { ExternalDocumentCommentView } from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { Check, CornerDownLeft, MessageSquare, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import type { LocalDocumentComment } from '../../../../../../../shared/sources'
import { SourceIcon } from '../../../../pages/sources/SourceIcon'
import { showToast } from '../../../../../state/toast'
import './ExternalDocumentDialogs.css'

/**
 * 外部导入评论面板（方案 §5.2）——飞书式停靠布局：
 * 面板与编辑器内容并排成列（挤压编辑器宽度，不遮挡）；评论卡按锚点定位在
 * 正文对应高度（quotedText 命中处），随编辑器滚动同步移动；未命中的归入
 * 底部"未定位评论"堆叠区。
 */
export function ImportedCommentsPanel({
  editor,
  roomId,
  documentId,
  onClose,
}: {
  editor: Editor | null
  roomId: string
  documentId: string
  onClose: () => void
}) {
  const { t, locale } = useLocale()
  const [comments, setComments] = useState<ExternalDocumentCommentView[] | null>(null)
  const [localComments, setLocalComments] = useState<LocalDocumentComment[] | null>(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const layerRef = useRef<HTMLDivElement | null>(null)

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

  const formatTime = (value: string | null): string => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  /** quotedText → 正文 DOM 命中元素的 offsetTop（相对编辑器滚动内容）。 */
  const locateAnchors = useCallback((): Map<string, number> => {
    const anchors = new Map<string, number>()
    const dom = editor?.view?.dom
    if (!dom || !comments) return anchors
    const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let full = ''
    let node: Node | null
    while ((node = walker.nextNode()) !== null) {
      const text = node as Text
      nodes.push(text)
      full += text.nodeValue ?? ''
    }
    const normalize = (value: string): string => value.replace(/[\s\u3000]+/g, '')
    const normalizedFull = normalize(full)
    // 每个文本节点在 normalized 串中的起点
    const starts: number[] = []
    let acc = 0
    for (const text of nodes) {
      starts.push(acc)
      acc += normalize(text.nodeValue ?? '').length
    }
    const nodeAtNormalized = (position: number): Element | null => {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        if (starts[index]! <= position) {
          return nodes[index]!.parentElement
        }
      }
      return nodes[0]?.parentElement ?? null
    }
    const scrollTopRoot = editor.view.dom.closest('.context-room-embedded-cloud-doc')
      ?? editor.view.dom.parentElement
    for (const comment of comments) {
      const quote = comment.quotedText ? normalize(comment.quotedText).slice(0, 80) : ''
      if (quote.length < 4) continue
      const hit = normalizedFull.indexOf(quote)
      if (hit < 0) continue
      const host = nodeAtNormalized(hit)
      if (!host) continue
      const top = host.getBoundingClientRect().top - (scrollTopRoot?.getBoundingClientRect().top ?? 0)
      anchors.set(comment.id, top)
    }
    return anchors
  }, [comments, editor])

  // 命中的锚点 + 滚动/尺寸变化时重算卡片位置（卡片在面板内绝对定位跟随）。
  const [anchors, setAnchors] = useState<Map<string, number>>(new Map())
  useEffect(() => {
    if (!comments) return
    const recompute = (): void => setAnchors(new Map(locateAnchors()))
    recompute()
    const scroller = editor?.view?.dom?.closest('.context-room-embedded-cloud-doc')
    if (!scroller) return
    scroller.addEventListener('scroll', recompute, { passive: true })
    window.addEventListener('resize', recompute)
    return () => {
      scroller.removeEventListener('scroll', recompute)
      window.removeEventListener('resize', recompute)
    }
  }, [comments, editor, locateAnchors])

  const threads = useMemo(() => {
    if (!comments) return { anchored: [], unanchored: [] }
    const anchored: ExternalDocumentCommentView[] = []
    const unanchored: ExternalDocumentCommentView[] = []
    for (const comment of comments) {
      if (comment.parentId !== null) continue
      if (anchors.has(comment.id)) anchored.push(comment)
      else unanchored.push(comment)
    }
    anchored.sort((a, b) => (anchors.get(a.id) ?? 0) - (anchors.get(b.id) ?? 0))
    return { anchored, unanchored }
  }, [comments, anchors])

  const repliesOf = (parentId: string): ExternalDocumentCommentView[] =>
    comments?.filter((reply) => reply.parentId === parentId) ?? []

  const localRepliesOf = (parentId: string): LocalDocumentComment[] =>
    localComments?.filter((reply) => reply.parentId === parentId) ?? []

  const submitComment = async () => {
    const documents = window.nxcore?.documents
    if (!documents || !draft.trim() || submitting) return
    setSubmitting(true)
    try {
      await documents.createDocumentComment(documentId, {
        body: draft.trim(),
        parentId: replyTo,
      })
      setDraft('')
      setReplyTo(null)
      reloadLocalComments()
    } catch (error) {
      showToast({
        title: t('contextRoom:importedComments.submitFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

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

  return (
    <aside className="context-room-imported-comments-dock" aria-label={t('contextRoom:importedComments.title')}>
      <header>
        <strong>{t('contextRoom:importedComments.panelTitle')}</strong>
        <span className="context-room-imported-comments-count">
          {(comments?.length ?? 0) + (localComments?.length ?? 0) > 0
            ? t('contextRoom:importedComments.count', { count: String((comments?.length ?? 0) + (localComments?.length ?? 0)) })
            : ''}
        </span>
        <button type="button" aria-label={t('contextRoom:importedComments.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {replyTo && (
        <div className="context-room-imported-comments-replying">
          {t('contextRoom:importedComments.replyingTo')}
          <button type="button" onClick={() => setReplyTo(null)} aria-label={t('contextRoom:importedComments.cancelReply')}><X size={11} aria-hidden="true" /></button>
        </div>
      )}
      <div className="context-room-imported-comments-composer">
        <textarea
          value={draft}
          rows={2}
          maxLength={4000}
          placeholder={t('contextRoom:importedComments.composerPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submitComment()
            }
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={submitting || !draft.trim()}
          onClick={() => void submitComment()}
        >
          {submitting ? '…' : <CornerDownLeft size={13} aria-hidden="true" />}
          {t('contextRoom:importedComments.submit')}
        </button>
      </div>
      <div ref={layerRef} className="context-room-imported-comments-layer">
        {localComments !== null && localComments.filter((comment) => comment.parentId === null).length > 0 && (
          <div className="context-room-imported-comments-local-list">
            <div className="context-room-imported-comments-section-label">{t('contextRoom:importedComments.localSection')}</div>
            {localComments.filter((comment) => comment.parentId === null).map((comment) => (
              <article key={comment.id} className="context-room-imported-comment" data-resolved={String(comment.resolved)}>
                <header>
                  <strong>{comment.authorName}</strong>
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
                {localRepliesOf(comment.id).length > 0 && (
                  <div className="context-room-imported-comment-replies">
                    {localRepliesOf(comment.id).map((reply) => (
                      <div key={reply.id} className="context-room-imported-comment-reply">
                        <strong>{reply.authorName}</strong>
                        <p>{reply.body}</p>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" className="context-room-imported-comment-reply-button" onClick={() => setReplyTo(comment.id)}>
                  {t('contextRoom:importedComments.reply')}
                </button>
              </article>
            ))}
          </div>
        )}
        {comments === null ? (
          <p className="context-room-imported-comments-empty">{t('contextRoom:importedComments.loading')}</p>
        ) : comments.length === 0 && (localComments?.length ?? 0) === 0 ? (
          <div className="context-room-imported-comments-empty">
            <MessageSquare aria-hidden="true" />
            <p>{t('contextRoom:importedComments.empty')}</p>
            <small>{t('contextRoom:importedComments.emptyHint')}</small>
          </div>
        ) : (
          <>
            {threads.anchored.map((comment) => (
              <div
                key={comment.id}
                className="context-room-imported-comment-floating"
                style={{ top: `${String(Math.max(0, anchors.get(comment.id) ?? 0))}px` }}
              >
                <CommentThread comment={comment} replies={repliesOf(comment.id)} formatTime={formatTime} t={t} />
              </div>
            ))}
            {threads.unanchored.length > 0 && (
              <div className="context-room-imported-comments-unanchored">
                <div className="context-room-imported-comments-unanchored-label">
                  {t('contextRoom:importedComments.unlocatedSection')}
                </div>
                {threads.unanchored.map((comment) => (
                  <CommentThread key={comment.id} comment={comment} replies={repliesOf(comment.id)} formatTime={formatTime} t={t} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function CommentThread({
  comment,
  replies,
  formatTime,
  t,
}: {
  comment: ExternalDocumentCommentView
  replies: ExternalDocumentCommentView[]
  formatTime: (value: string | null) => string
  t: (key: string) => string
}) {
  return (
    <article className="context-room-imported-comment" data-resolved={String(comment.resolved === true)}>
      <header>
        <SourceIcon kind="feishu" className="context-room-imported-comment-source" />
        <strong>{comment.authorName ?? t('contextRoom:importedComments.anonymous')}</strong>
        <time>{formatTime(comment.createdAt)}</time>
        {comment.resolved === true && (
          <em className="context-room-imported-comment-resolved">
            <Check size={11} aria-hidden="true" />
            {t('contextRoom:importedComments.resolved')}
          </em>
        )}
      </header>
      {comment.quotedText && (
        <blockquote className="context-room-imported-comment-quote">{comment.quotedText}</blockquote>
      )}
      <p>{comment.body}</p>
      {replies.length > 0 && (
        <div className="context-room-imported-comment-replies">
          {replies.map((reply) => (
            <div key={reply.id} className="context-room-imported-comment-reply">
              <strong>{reply.authorName ?? t('contextRoom:importedComments.anonymous')}</strong>
              <p>{reply.body}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
