/**
 * Office「AI 修改」待发送批注小徽章（对话区输入框上方一行）。
 *
 * 形态：默认只是「N 条评论」的小 pill，不占行宽；hover/点击展开一个卡片列表
 * 浮层（原文摘录 + 我的评论，行内改写/删除）。浮层只读浏览 + 单条管理，
 * 发送统一走输入框的发送按钮（批注等价于一条消息）。
 *
 * EverRoom 版：事实来源是 App.tsx 的 agentNoteDrafts 队列（props 注入），
 * 按 Room 过滤；无 workbench store。
 */
import { Pencil, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import './noteQueueChip.css'

export interface NoteQueueDraft {
  id: string
  roomId: string
  fileId?: string
  title?: string
  instruction?: string
  excerpt?: string
  anchor?: Record<string, unknown>
  message: string
  displayMessage?: string
}

/** hover 展开后离开的收起延迟：给「从徽章挪到浮层」的鼠标路径留缓冲。 */
const CLOSE_DELAY_MS = 150

export interface NoteQueueChipProps {
  /** 只显示这个 Room 的批注（其它 Room 的留给各自对话）。 */
  roomId: string | null
  /** 调用方按 roomId 过滤好的队列。 */
  drafts: NoteQueueDraft[]
  onRemove: (id: string) => void
  onUpdate: (id: string, instruction: string) => void
  /** 文档内锚点动作回灌（send-all/remove/update）→ 编辑器侧同步。 */
  onAskQueueAction?: (listener: (event: { fileId: string | null; roomId: string; action: { kind: 'send-all' } | { kind: 'remove'; draftId: string } | { kind: 'update'; draftId: string; instruction: string } }) => void) => () => void
}

export function NoteQueueChip({ roomId, drafts: draftsProp, onRemove, onUpdate }: NoteQueueChipProps) {
  const { t } = useLocale()

  const drafts = roomId ? draftsProp.filter((draft) => draft.roomId === roomId) : []

  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const closeTimer = useRef<number | null>(null)

  // 卸载时清掉未触发的收起定时器。
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  // 队列清空（删光/发出）时收起浮层并复位：否则新批注进来会带着陈旧的展开态直接弹出。
  useEffect(() => {
    if (drafts.length === 0) {
      setOpen(false)
      setPinned(false)
      setEditingId(null)
    }
  }, [drafts.length])

  if (drafts.length === 0) return null

  const scheduleClose = () => {
    if (pinned) return
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const toggleOpen = () => {
    cancelClose()
    setPinned((value) => {
      const next = !value
      setOpen(next || !open)
      return next
    })
  }

  const commitEdit = (id: string, next: string) => {
    onUpdate(id, next)
    setEditingId(null)
  }
  const editKeyDown = (event: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(id, event.currentTarget.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditingId(null)
    }
  }

  return (
    <div
      className="wb-note-chip"
      data-open={String(open)}
      onMouseEnter={() => { cancelClose(); setOpen(true) }}
      onMouseLeave={scheduleClose}
    >
      <button type="button" className="wb-note-chip-pill" onClick={toggleOpen}>
        <StickyNote aria-hidden="true" />
        <span>{t('surface:noteQueue.annotationsCount', { count: drafts.length })}</span>
      </button>
      {open ? (
        <div className="wb-note-chip-popover" role="dialog" aria-label={t('surface:noteQueue.annotationsPending')}>
          <ul className="wb-note-chip-list">
            {drafts.map((draft) => (
              <li key={draft.id} className="wb-note-chip-item">
                <div className="wb-note-chip-copy">
                  {draft.excerpt ? <div className="wb-note-chip-excerpt">{draft.excerpt}</div> : null}
                  {editingId === draft.id ? (
                    <input
                      className="wb-note-chip-edit"
                      type="text"
                      defaultValue={draft.instruction ?? ''}
                      autoFocus
                      aria-label={t('surface:noteQueue.editAnnotation')}
                      onKeyDown={(event) => editKeyDown(event, draft.id)}
                      onBlur={(event) => commitEdit(draft.id, event.currentTarget.value)}
                    />
                  ) : (
                    <div
                      className="wb-note-chip-note"
                      title={t('surface:noteQueue.editAnnotationNamed')}
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditingId(draft.id)}
                      onKeyDown={(event) => { if (event.key === 'Enter') setEditingId(draft.id) }}
                    >
                      {draft.instruction ?? draft.displayMessage ?? draft.message}
                    </div>
                  )}
                </div>
                <div className="wb-note-chip-actions">
                  <button
                    type="button"
                    className="wb-note-chip-iconbtn"
                    aria-label={t('surface:noteQueue.editAnnotation')}
                    onClick={() => setEditingId(draft.id)}
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="wb-note-chip-iconbtn"
                    aria-label={t('surface:noteQueue.deleteAnnotationNamed')}
                    onClick={() => onRemove(draft.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="wb-note-chip-hint">{t('surface:noteQueue.noteEditorHint')}</div>
        </div>
      ) : null}
    </div>
  )
}
