import type { Editor } from '@tiptap/react'
import type { RefObject } from 'react'
import { useEffect } from 'react'

function isTopLevelBlockHit(editorElement: HTMLElement, target: Element | null): boolean {
  if (!target || target === editorElement || !editorElement.contains(target)) return false

  let block = target
  while (block.parentElement && block.parentElement !== editorElement) {
    block = block.parentElement
  }

  return block.parentElement === editorElement
}

export function useTiptapBlockHandleVisibility(
  editor: Editor,
  controlsRef: RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    const editorElement = editor.view.dom
    const scrollElement = editorElement.closest<HTMLElement>('.context-room-tiptap-scroll')
    let pointerFrame: number | null = null

    const setHandleVisible = (visible: boolean) => {
      const handleElement = controlsRef.current?.parentElement
      if (!handleElement || (visible && handleElement.dataset.dragging === 'true')) return
      handleElement.style.visibility = visible ? '' : 'hidden'
      handleElement.style.pointerEvents = visible ? 'auto' : 'none'
    }

    const handleMouseMove = (event: MouseEvent) => {
      const { clientX, clientY } = event
      if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = null
        const target = document.elementFromPoint(clientX, clientY)
        setHandleVisible(isTopLevelBlockHit(editorElement, target))
      })
    }

    const hideHandle = () => setHandleVisible(false)
    const hideForOutsidePointer = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null
      const handleElement = controlsRef.current?.parentElement
      if (
        target &&
        !editorElement.contains(target) &&
        !handleElement?.contains(target)
      ) {
        hideHandle()
      }
    }

    editorElement.addEventListener('mousemove', handleMouseMove)
    scrollElement?.addEventListener('scroll', hideHandle, { passive: true })
    scrollElement?.addEventListener('pointerdown', hideForOutsidePointer, true)

    return () => {
      if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
      editorElement.removeEventListener('mousemove', handleMouseMove)
      scrollElement?.removeEventListener('scroll', hideHandle)
      scrollElement?.removeEventListener('pointerdown', hideForOutsidePointer, true)
    }
  }, [controlsRef, editor])
}
