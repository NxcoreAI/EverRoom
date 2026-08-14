import type { Editor } from '@tiptap/react'
import type { RefObject } from 'react'
import { useEffect } from 'react'

const BLOCK_HANDLE_HIT_SLOP = {
  top: 14,
  bottom: 14,
  left: 20,
} as const

function getTopLevelBlock(editorElement: HTMLElement, target: Element | null): HTMLElement | null {
  if (!target || target === editorElement || !editorElement.contains(target)) return null

  let block = target
  while (block.parentElement && block.parentElement !== editorElement) {
    block = block.parentElement
  }

  return block instanceof HTMLElement && block.parentElement === editorElement ? block : null
}

function getBlockAtPos(editor: Editor, editorElement: HTMLElement, pos: number): HTMLElement | null {
  if (pos < 0) return null
  const node = editor.view.nodeDOM(pos)
  const element = node instanceof HTMLElement ? node : node?.parentElement
  return getTopLevelBlock(editorElement, element ?? null)
}

function isInsideExpandedHandleArea(
  x: number,
  y: number,
  blockElement: HTMLElement | null,
  handleElement: HTMLElement | null,
): boolean {
  if (!blockElement || !handleElement) return false
  const blockRect = blockElement.getBoundingClientRect()
  const handleRect = handleElement.getBoundingClientRect()

  return (
    x >= handleRect.left - BLOCK_HANDLE_HIT_SLOP.left &&
    x <= blockRect.right &&
    y >= Math.min(blockRect.top, handleRect.top) - BLOCK_HANDLE_HIT_SLOP.top &&
    y <= Math.max(blockRect.bottom, handleRect.bottom) + BLOCK_HANDLE_HIT_SLOP.bottom
  )
}

export function useTiptapBlockHandleVisibility(
  editor: Editor,
  controlsRef: RefObject<HTMLDivElement>,
  activePosRef: RefObject<number>,
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
        const handleElement = controlsRef.current?.parentElement ?? null
        const isDirectBlockHit = getTopLevelBlock(editorElement, target) !== null
        const isHandleHit = Boolean(target && handleElement?.contains(target))
        const activeBlock = getBlockAtPos(editor, editorElement, activePosRef.current ?? -1)
        setHandleVisible(
          isDirectBlockHit ||
          isHandleHit ||
          isInsideExpandedHandleArea(clientX, clientY, activeBlock, handleElement),
        )
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

    scrollElement?.addEventListener('mousemove', handleMouseMove)
    scrollElement?.addEventListener('scroll', hideHandle, { passive: true })
    scrollElement?.addEventListener('pointerdown', hideForOutsidePointer, true)

    return () => {
      if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
      scrollElement?.removeEventListener('mousemove', handleMouseMove)
      scrollElement?.removeEventListener('scroll', hideHandle)
      scrollElement?.removeEventListener('pointerdown', hideForOutsidePointer, true)
    }
  }, [activePosRef, controlsRef, editor])
}
