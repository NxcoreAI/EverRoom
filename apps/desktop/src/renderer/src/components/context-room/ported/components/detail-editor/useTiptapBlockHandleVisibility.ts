import type { Editor } from '@tiptap/react'
import type { RefObject } from 'react'
import { useEffect } from 'react'

const BLOCK_HANDLE_HIT_SLOP = {
  top: 14,
  bottom: 14,
  left: 20,
} as const
const BLOCK_SWITCH_SLOP = 4

function getTopLevelBlock(editorElement: HTMLElement, target: Element | null): HTMLElement | null {
  if (!target || target === editorElement || !editorElement.contains(target)) return null

  let block = target
  while (block.parentElement && block.parentElement !== editorElement) {
    block = block.parentElement
  }

  return block instanceof HTMLElement && block.parentElement === editorElement ? block : null
}

function findBlockInExpandedArea(
  editorElement: HTMLElement,
  x: number,
  y: number,
  handleElement: HTMLElement | null,
  direction: -1 | 0 | 1,
): HTMLElement | null {
  const handleWidth = handleElement?.getBoundingClientRect().width ?? 49
  const candidates: Array<{ element: HTMLElement; rect: DOMRect }> = []

  for (const child of editorElement.children) {
    if (!(child instanceof HTMLElement)) continue
    const rect = child.getBoundingClientRect()
    if (
      x < rect.left - handleWidth - BLOCK_HANDLE_HIT_SLOP.left ||
      x > rect.right
    ) continue
    candidates.push({ element: child, rect })
  }

  const firstRect = candidates[0]?.rect
  const lastRect = candidates[candidates.length - 1]?.rect
  if (
    !firstRect ||
    !lastRect ||
    y < firstRect.top - BLOCK_HANDLE_HIT_SLOP.top ||
    y > lastRect.bottom + BLOCK_HANDLE_HIT_SLOP.bottom
  ) return null

  if (direction > 0) {
    return candidates.find(({ rect }) => y <= rect.bottom + BLOCK_SWITCH_SLOP)?.element ?? null
  }
  if (direction < 0) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (y >= candidates[index].rect.top - BLOCK_SWITCH_SLOP) {
        return candidates[index].element
      }
    }
    return null
  }

  return candidates.sort((a, b) => {
    const distanceA = y < a.rect.top ? a.rect.top - y : y > a.rect.bottom ? y - a.rect.bottom : 0
    const distanceB = y < b.rect.top ? b.rect.top - y : y > b.rect.bottom ? y - b.rect.bottom : 0
    return distanceA - distanceB
  })[0]?.element ?? null
}

function forwardMouseMoveToBlock(editorElement: HTMLElement, block: HTMLElement, source: MouseEvent) {
  const rect = block.getBoundingClientRect()
  editorElement.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true,
    clientX: Math.min(rect.right - 1, rect.left + 1),
    clientY: Math.max(rect.top + 1, Math.min(source.clientY, rect.bottom - 1)),
    view: window,
  }))
}

export function useTiptapBlockHandleVisibility(
  editor: Editor,
  controlsRef: RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    const editorElement = editor.view.dom
    const scrollElement = editorElement.closest<HTMLElement>('.context-room-tiptap-scroll')
    let pointerFrame: number | null = null
    let lastPointerY: number | null = null

    const setHandleVisible = (visible: boolean) => {
      const handleElement = controlsRef.current?.parentElement
      if (!handleElement || (visible && handleElement.dataset.dragging === 'true')) return
      handleElement.dataset.hoverVisible = String(visible)
      handleElement.style.visibility = visible ? '' : 'hidden'
      handleElement.style.pointerEvents = visible ? 'auto' : 'none'
    }

    const handleMouseMove = (event: MouseEvent) => {
      if (!event.isTrusted) return
      const { clientX, clientY } = event
      const target = document.elementFromPoint(clientX, clientY)
      const handleElement = controlsRef.current?.parentElement ?? null
      const directBlock = getTopLevelBlock(editorElement, target)
      const isHandleHit = Boolean(target && handleElement?.contains(target))
      const isControlsHit = Boolean(target && controlsRef.current?.contains(target))
      const direction = lastPointerY === null || clientY === lastPointerY
        ? 0
        : clientY > lastPointerY ? 1 : -1
      lastPointerY = clientY
      const expandedBlock = directBlock ?? (
        isControlsHit
          ? null
          : findBlockInExpandedArea(editorElement, clientX, clientY, handleElement, direction)
      )

      if (!directBlock && expandedBlock) {
        forwardMouseMoveToBlock(editorElement, expandedBlock, event)
      }

      if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = null
        setHandleVisible(Boolean(directBlock || isHandleHit || expandedBlock))
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
  }, [controlsRef, editor])
}
