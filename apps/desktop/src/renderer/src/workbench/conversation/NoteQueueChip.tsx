/**
 * Office「AI 修改」待发送批注小徽章（对话区输入框上方一行）。
 *
 * 形态：默认只是「N 条注释」的小 pill，不占行宽；hover/点击展开一个卡片列表
 * 浮层（原文摘录 + 我的注释，行内改写/删除，底部「全部发送」）。
 *
 * 事实来源仍是 store.askDrafts（宿主唯一队列）；「全部发送」用 nonce 通知对话
 * 面板（真正的发送要 useAgentSession hook，且排队语义由它处理）。
 */
import { Pencil, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { PendingAskDraft } from '@/components/agent/askDrafts'

import { useWorkbenchStore } from '../state/store'
import './conversation.css'

/** hover 展开后离开的收起延迟：给「从徽章挪到浮层」的鼠标路径留缓冲。 */
const CLOSE_DELAY_MS = 150

export interface NoteQueueChipProps {
  /** 只显示这个工作空间的批注（其它空间的留给各自对话）。 */
  workspaceId: string | null
  /** 队列已由调用方按 workspaceId 过滤好；传 null 交给组件自己过滤。 */
  drafts?: PendingAskDraft[] | null
}

export function NoteQueueChip({ workspaceId, drafts: draftsProp }: NoteQueueChipProps) {
  const storeDrafts = useWorkbenchStore((state) => state.askDrafts)
  const removeAskDraft = useWorkbenchStore((state) => state.removeAskDraft)
  const updateAskDraft = useWorkbenchStore((state) => state.updateAskDraft)
  const requestAskQueueSend = useWorkbenchStore((state) => state.requestAskQueueSend)

  const drafts = draftsProp
    ?? (workspaceId ? storeDrafts.filter((draft) => draft.workspaceId === workspaceId) : [])

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
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const openNow = () => {
    cancelClose()
    setOpen(true)
  }
  const togglePin = () => {
    setPinned((current) => {
      if (current) {
        // 取消 pin = 收起。
        setOpen(false)
        return false
      }
      cancelClose()
      setOpen(true)
      return true
    })
  }

  return (
    <div
      className="wb-note-chip"
      data-open={open ? 'true' : undefined}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="wb-note-chip-pill"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={togglePin}
      >
        <StickyNote aria-hidden="true" />
        {drafts.length} 条注释
      </button>

      {open ? (
        <div className="wb-note-chip-popover" role="dialog" aria-label="待发送注释">
          <ul className="wb-note-chip-list">
            {drafts.map((draft) => (
              <li key={draft.id} className="wb-note-chip-item">
                {editingId === draft.id ? (
                  <NoteChipEditor
                    draft={draft}
                    onSave={(instruction) => {
                      updateAskDraft(draft.id, instruction)
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="wb-note-chip-copy">
                      {draft.excerpt ? (
                        <span className="wb-note-chip-excerpt">{clip(draft.excerpt, 42)}</span>
                      ) : null}
                      <span className="wb-note-chip-note">
                        {draft.instruction ?? draft.displayMessage ?? draft.message}
                      </span>
                    </div>
                    <span className="wb-note-chip-actions">
                      <button
                        type="button"
                        className="wb-note-chip-iconbtn"
                        aria-label="修改这条注释"
                        title="修改"
                        onClick={() => setEditingId(draft.id)}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="wb-note-chip-iconbtn is-danger"
                        aria-label="删除这条注释"
                        title="删除"
                        onClick={() => removeAskDraft(draft.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="wb-note-chip-foot">
            <button
              type="button"
              className="wb-note-chip-sendall"
              onClick={() => {
                setPinned(false)
                setOpen(false)
                requestAskQueueSend()
              }}
            >
              全部发送
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 行内改写：预填原话，回车保存、Esc 取消；空文本不保存（等于取消）。 */
function NoteChipEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: PendingAskDraft
  onSave: (instruction: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(draft.instruction ?? draft.displayMessage ?? draft.message)
  const inputRef = useRef<HTMLInputElement>(null)

  // 挂载即聚焦并全选：改写通常是从头重写。
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (value.trim()) onSave(value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="wb-note-chip-edit">
      <input
        ref={inputRef}
        value={value}
        aria-label="修改注释"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (value.trim()) onSave(value) }}
      />
      <span className="wb-note-chip-edit-hint">回车保存 · Esc 取消</span>
    </div>
  )
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
