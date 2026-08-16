import type { Editor } from '@tiptap/react'
import { useCallback, useEffect, useRef, useState } from 'react'

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

export function useTransientEditorInteractions(editor: Editor | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollbarTimer = useRef<number | null>(null)
  const followingDocumentStream = useRef(true)
  const previousScrollTop = useRef(0)
  const [scrolling, setScrolling] = useState(false)

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
      followingDocumentStream.current = nextDocumentStreamFollowState({
        wasFollowing: followingDocumentStream.current,
        previousScrollTop: previousScrollTop.current,
        scrollTop: scrollElement.scrollTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
      })
      previousScrollTop.current = scrollElement.scrollTop
      setScrolling(true)
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollbarTimer.current = window.setTimeout(() => {
        scrollbarTimer.current = null
        setScrolling(false)
      }, SCROLLBAR_HIDE_DELAY)
    }
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [editor])

  return { scrollRef, scrolling, shouldFollowDocumentStream, followDocumentStream }
}
