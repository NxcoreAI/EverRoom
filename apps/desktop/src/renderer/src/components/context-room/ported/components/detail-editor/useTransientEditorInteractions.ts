import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

const SCROLLBAR_HIDE_DELAY = 700
const SELECTION_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
])

export function useTransientEditorInteractions(editor: Editor | null) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollbarTimer = useRef<number | null>(null)
  const [scrolling, setScrolling] = useState(false)
  const [selecting, setSelecting] = useState(false)

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!editor || !scrollElement) return

    const stopSelecting = () => setSelecting(false)
    const handleScroll = () => {
      setScrolling(true)
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollbarTimer.current = window.setTimeout(() => {
        scrollbarTimer.current = null
        setScrolling(false)
      }, SCROLLBAR_HIDE_DELAY)
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (event.button === 0 && target instanceof Node && editor.view.dom.contains(target)) {
        setSelecting(true)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey && SELECTION_KEYS.has(event.key)) setSelecting(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || SELECTION_KEYS.has(event.key)) stopSelecting()
    }

    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    scrollElement.addEventListener('pointerdown', handlePointerDown, true)
    editor.view.dom.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerup', stopSelecting, true)
    window.addEventListener('pointercancel', stopSelecting, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', stopSelecting)

    return () => {
      if (scrollbarTimer.current !== null) window.clearTimeout(scrollbarTimer.current)
      scrollElement.removeEventListener('scroll', handleScroll)
      scrollElement.removeEventListener('pointerdown', handlePointerDown, true)
      editor.view.dom.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerup', stopSelecting, true)
      window.removeEventListener('pointercancel', stopSelecting, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', stopSelecting)
    }
  }, [editor])

  return { scrollRef, scrolling, selecting }
}
