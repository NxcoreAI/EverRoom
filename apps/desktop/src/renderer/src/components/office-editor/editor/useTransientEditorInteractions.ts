import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useRef } from 'react'

const SCROLLBAR_HIDE_DELAY = 700
const DOCUMENT_STREAM_FOLLOW_THRESHOLD = 96

export function isNearDocumentStreamEnd({
  scrollTop,
  scrollHeight,
  clientHeight,
}: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= DOCUMENT_STREAM_FOLLOW_THRESHOLD
}

export function nextDocumentStreamFollowState({
  wasFollowing,
  previousScrollTop,
  scrollTop,
  scrollHeight,
  clientHeight,
}: {
  wasFollowing: boolean
  previousScrollTop: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): boolean {
  if (scrollTop < previousScrollTop) return false
  return wasFollowing || isNearDocumentStreamEnd({ scrollTop, scrollHeight, clientHeight })
}

export function isSelectionOutsideViewport({
  startTop,
  startBottom,
  endTop,
  endBottom,
  viewportTop,
  viewportBottom,
}: {
  startTop: number
  startBottom: number
  endTop: number
  endBottom: number
  viewportTop: number
  viewportBottom: number
}): boolean {
  const selectionTop = Math.min(startTop, endTop)
  const selectionBottom = Math.max(startBottom, endBottom)
  return selectionBottom <= viewportTop || selectionTop >= viewportBottom
}

export function setScrollElementScrolling(scrollElement: HTMLElement, scrolling: boolean): void {
  scrollElement.dataset.scrolling = String(scrolling)
}

export function useTransientEditorInteractions(
  editor: Editor | null,
  onSelectionCleared?: () => void,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollbarTimer = useRef<number | null>(null)
  const followingDocumentStream = useRef(true)
  const previousScrollTop = useRef(0)

  const shouldFollowDocumentStream = useCallback(() => followingDocumentStream.current, [])
  const followDocumentStream = useCallback(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement || !followingDocumentStream.current) return
    scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: 'auto' })
  }, [])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!editor || !scrollElement) return
    followingDocumentStream.current = isNearDocumentStreamEnd(scrollElement)
    previousScrollTop.current = scrollElement.scrollTop

    const handleScroll = () => {
      const selection = editor.state.selection
      if (selection instanceof TextSelection && !selection.empty) {
        try {
          const start = editor.view.coordsAtPos(selection.from)
          const end = editor.view.coordsAtPos(selection.to)
          const viewport = scrollElement.getBoundingClientRect()
          if (isSelectionOutsideViewport({
            startTop: start.top,
            startBottom: start.bottom,
            endTop: end.top,
            endBottom: end.bottom,
            viewportTop: viewport.top,
            viewportBottom: viewport.bottom,
          })) {
            editor.view.dispatch(editor.state.tr.setSelection(
              TextSelection.create(editor.state.doc, selection.from),
            ))
            onSelectionCleared?.()
          }
        } catch {
          // The editor can be between document updates while a scroll event fires.
        }
      }
      followingDocumentStream.current = nextDocumentStreamFollowState({
        wasFollowing: followingDocumentStream.current,
        previousScrollTop: previousScrollTop.current,
        scrollTop: scrollElement.scrollTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
      })
      previousScrollTop.current = scrollElement.scrollTop
      setScrollElementScrolling(scrollElement, true)
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollbarTimer.current = window.setTimeout(() => {
        scrollbarTimer.current = null
        setScrollElementScrolling(scrollElement, false)
      }, SCROLLBAR_HIDE_DELAY)
    }
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [editor, onSelectionCleared])

  return { scrollRef, shouldFollowDocumentStream, followDocumentStream }
}
