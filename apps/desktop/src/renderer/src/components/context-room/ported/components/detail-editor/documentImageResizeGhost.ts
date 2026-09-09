import { NodeSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'

/**
 * 图片缩放（幽灵模式）：不实时改图片尺寸——拖动手柄时原图原地占位，
 * 半透明幽灵框按拖动尺寸叠加显示（左/上方向拖动时对侧边钉住、被拖边
 * 跟随鼠标），松手才把最终尺寸 setNodeMarkup 一次性落库（可撤销，
 * ESC 取消）。手柄覆盖层挂在编辑器根上、跟随选中的图片（NodeSelection
 * → nodeDOM），未选中时不渲染。
 */

const MIN_WIDTH = 96
const MIN_HEIGHT = 48

type Direction = 'top' | 'right' | 'bottom' | 'left' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
const DIRECTIONS: Direction[] = ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right']

function cursorFor(direction: Direction): string {
  switch (direction) {
    case 'top':
    case 'bottom':
      return 'ns-resize'
    case 'left':
    case 'right':
      return 'ew-resize'
    case 'top-left':
    case 'bottom-right':
      return 'nwse-resize'
    default:
      return 'nesw-resize'
  }
}

interface DragState {
  direction: Direction
  baseWidth: number
  baseHeight: number
  anchorLeft: number
  anchorTop: number
  pointerX: number
  pointerY: number
}

export function installImageResizeGhost(editor: Editor): () => void {
  // 覆盖层挂编辑器根（position:relative），坐标按视口差值计算即可。
  const host = editor.view.dom.closest<HTMLElement>('.context-room-tiptap-editor') ?? editor.view.dom

  const layer = document.createElement('div')
  layer.className = 'cr-img-resize-layer'
  const box = document.createElement('div')
  box.className = 'cr-img-resize-box'
  const badge = document.createElement('span')
  badge.className = 'cr-img-resize-badge'
  const handles = DIRECTIONS.map((direction) => {
    const handle = document.createElement('div')
    handle.dataset.direction = direction
    handle.style.cursor = cursorFor(direction)
    handle.addEventListener('pointerdown', (event) => beginDrag(event, direction))
    box.appendChild(handle)
    return handle
  })
  box.appendChild(badge)
  layer.appendChild(box)

  let drag: DragState | null = null
  let selectedImg: HTMLElement | null = null
  let mounted = false

  function contentOffset(el: HTMLElement): { left: number; top: number } {
    const hostRect = host.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    return {
      left: rect.left - hostRect.left + host.scrollLeft,
      top: rect.top - hostRect.top + host.scrollTop,
    }
  }

  function findSelectedImage(): HTMLElement | null {
    const selection = editor.state.selection
    if (!(selection instanceof NodeSelection)) return null
    if (selection.node.type.name !== 'image') return null
    const dom = editor.view.nodeDOM(selection.from)
    return dom instanceof HTMLElement ? dom : null
  }

  function frame(): void {
    const img = findSelectedImage()
    selectedImg = img
    if (img) {
      if (!mounted) {
        host.appendChild(layer)
        mounted = true
      }
      if (!drag) {
        const offset = contentOffset(img)
        box.style.left = `${String(offset.left)}px`
        box.style.top = `${String(offset.top)}px`
        box.style.width = `${String(img.offsetWidth)}px`
        box.style.height = `${String(img.offsetHeight)}px`
      }
    } else if (mounted && !drag) {
      layer.remove()
      mounted = false
    }
    window.requestAnimationFrame(frame)
  }
  window.requestAnimationFrame(frame)

  function beginDrag(event: PointerEvent, direction: Direction): void {
    if (!selectedImg || drag) return
    event.preventDefault()
    const offset = contentOffset(selectedImg)
    drag = {
      direction,
      baseWidth: selectedImg.offsetWidth,
      baseHeight: selectedImg.offsetHeight,
      anchorLeft: offset.left,
      anchorTop: offset.top,
      pointerX: event.clientX,
      pointerY: event.clientY,
    }
    box.classList.add('is-dragging')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    onMove(event)
  }

  function onMove(event: PointerEvent): void {
    if (!drag) return
    const dx = event.clientX - drag.pointerX
    const dy = event.clientY - drag.pointerY
    const hasLeft = drag.direction.includes('left')
    const hasTop = drag.direction.includes('top')
    const hasRight = drag.direction.includes('right') || !hasLeft
    const hasBottom = drag.direction.includes('bottom') || !hasTop
    const columnWidth = selectedImg?.closest('.tiptap')?.clientWidth ?? 4096
    const width = Math.min(Math.max(Math.round(drag.baseWidth + (hasRight ? dx : -dx)), MIN_WIDTH), columnWidth)
    const height = Math.max(Math.round(drag.baseHeight + (hasBottom ? dy : -dy)), MIN_HEIGHT)
    box.style.width = `${String(width)}px`
    box.style.height = `${String(height)}px`
    if (hasLeft) box.style.left = `${String(drag.anchorLeft + drag.baseWidth - width)}px`
    if (hasTop) box.style.top = `${String(drag.anchorTop + drag.baseHeight - height)}px`
    badge.textContent = `${String(width)} × ${String(height)}`
  }

  function finish(commit: boolean): void {
    if (!drag) return
    drag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKey)
    box.classList.remove('is-dragging')
    if (!commit) return
    const selection = editor.state.selection
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return
    const pos = selection.from
    const node = editor.state.doc.nodeAt(pos)
    if (!node) return
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      width: box.offsetWidth,
      height: box.offsetHeight,
    }))
  }

  function onUp(): void {
    finish(true)
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') finish(false)
  }

  return () => {
    finish(false)
    layer.remove()
  }
}
