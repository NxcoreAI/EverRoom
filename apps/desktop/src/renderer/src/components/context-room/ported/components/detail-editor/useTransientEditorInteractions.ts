import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

const SCROLLBAR_HIDE_DELAY = 700

export function useTransientEditorInteractions(editor: Editor | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollbarTimer = useRef<number | null>(null)
  const [scrolling, setScrolling] = useState(false)

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!editor || !scrollElement) return

    const handleScroll = () => {
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

  return { scrollRef, scrolling }
}
