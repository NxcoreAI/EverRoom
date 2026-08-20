import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  boundedGraphScale,
  drawGraphCanvas,
  fitGraphTransform,
  graphPoint,
  hitGraphNode,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type GraphCanvasTransform,
} from './graphCanvasDrawing'

export type { GraphCanvasEdge, GraphCanvasNode } from './graphCanvasDrawing'

export interface InteractiveGraphCanvasHandle {
  fitView(): void
}

interface PointerGesture {
  moved: boolean
  startOffsetX: number
  startOffsetY: number
  startX: number
  startY: number
}

interface InteractiveGraphCanvasProps {
  ariaLabel: string
  className: string
  edges: readonly GraphCanvasEdge[]
  nodes: readonly GraphCanvasNode[]
  onOpenNode?: (nodeId: string) => void
  onResize?: (width: number, height: number) => void
  onSelectNode: (nodeId: string | null) => void
  positions: Float32Array
  revision?: () => number
  selectedId: string | null
}

export const InteractiveGraphCanvas = forwardRef<
  InteractiveGraphCanvasHandle,
  InteractiveGraphCanvasProps
>(function InteractiveGraphCanvas({
  ariaLabel,
  className,
  edges,
  nodes,
  onOpenNode,
  onResize,
  onSelectNode,
  positions,
  revision,
  selectedId,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transformRef = useRef<GraphCanvasTransform>({ offsetX: 0, offsetY: 0, scale: 1 })
  const gestureRef = useRef<PointerGesture | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const dirtyRef = useRef(true)
  const fittedRef = useRef(false)
  const propsRef = useRef({ edges, nodes, onOpenNode, onResize, onSelectNode, positions, revision, selectedId })
  propsRef.current = { edges, nodes, onOpenNode, onResize, onSelectNode, positions, revision, selectedId }

  const fitView = () => {
    const canvas = canvasRef.current
    const current = propsRef.current
    if (!canvas || !current.nodes.length) return
    if (current.revision && current.revision() === 0) return
    const transform = fitGraphTransform(
      current.nodes,
      current.positions,
      canvas.clientWidth,
      canvas.clientHeight,
    )
    if (!transform) return
    transformRef.current = transform
    fittedRef.current = true
    dirtyRef.current = true
  }

  useImperativeHandle(ref, () => ({ fitView }), [])

  useEffect(() => {
    dirtyRef.current = true
    fittedRef.current = false
  }, [edges, nodes, positions])

  useEffect(() => {
    dirtyRef.current = true
  }, [selectedId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas?.clientWidth && canvas.clientHeight) {
      onResize?.(canvas.clientWidth, canvas.clientHeight)
    }
  }, [onResize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let animationFrame = 0
    let lastRevision = -1

    const draw = () => {
      const current = propsRef.current
      const startRevision = current.revision?.() ?? 0
      if ((startRevision & 1) === 1) {
        animationFrame = requestAnimationFrame(draw)
        return
      }
      if (!dirtyRef.current && startRevision === lastRevision) {
        animationFrame = requestAnimationFrame(draw)
        return
      }
      if (!fittedRef.current && (!current.revision || startRevision > 0)) fitView()
      const context = canvas.getContext('2d')
      if (!context) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const transform = transformRef.current
      const activeId = hoveredIdRef.current ?? current.selectedId
      drawGraphCanvas({
        activeId,
        context,
        edges: current.edges,
        height,
        nodes: current.nodes,
        positions: current.positions,
        transform,
        width,
      })
      const endRevision = current.revision?.() ?? startRevision
      dirtyRef.current = startRevision !== endRevision || (endRevision & 1) === 1
      lastRevision = endRevision
      animationFrame = requestAnimationFrame(draw)
    }

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      const context = canvas.getContext('2d')
      context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      propsRef.current.onResize?.(width, height)
      if (!fittedRef.current) queueMicrotask(fitView)
      dirtyRef.current = true
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(canvas)
    resize()
    animationFrame = requestAnimationFrame(draw)
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(animationFrame)
    }
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      moved: false,
      startOffsetX: transformRef.current.offsetX,
      startOffsetY: transformRef.current.offsetY,
      startX: event.clientX,
      startY: event.clientY,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current
    if (gesture) {
      const deltaX = event.clientX - gesture.startX
      const deltaY = event.clientY - gesture.startY
      if (Math.hypot(deltaX, deltaY) > 3) gesture.moved = true
      if (gesture.moved) {
        transformRef.current.offsetX = gesture.startOffsetX + deltaX
        transformRef.current.offsetY = gesture.startOffsetY + deltaY
        dirtyRef.current = true
        return
      }
    }
    const current = propsRef.current
    const hovered = hitGraphNode(event.nativeEvent, event.currentTarget, transformRef.current, current.nodes, current.positions)
    if (hoveredIdRef.current !== hovered?.id) {
      hoveredIdRef.current = hovered?.id ?? null
      event.currentTarget.style.cursor = hovered ? 'pointer' : gesture ? 'grabbing' : 'grab'
      dirtyRef.current = true
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (gesture?.moved) return
    const current = propsRef.current
    current.onSelectNode(
      hitGraphNode(event.nativeEvent, event.currentTarget, transformRef.current, current.nodes, current.positions)?.id ?? null,
    )
  }

  const onDoubleClick = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = propsRef.current
    const node = hitGraphNode(event.nativeEvent, event.currentTarget, transformRef.current, current.nodes, current.positions)
    if (node) current.onOpenNode?.(node.id)
  }

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    const before = graphPoint(event.nativeEvent, canvas, transformRef.current)
    const scale = boundedGraphScale(transformRef.current.scale * Math.exp(-event.deltaY * 0.0015))
    transformRef.current = {
      scale,
      offsetX: event.clientX - bounds.left - before.x * scale,
      offsetY: event.clientY - bounds.top - before.y * scale,
    }
    dirtyRef.current = true
  }

  return (
    <canvas
      ref={canvasRef}
      aria-label={ariaLabel}
      className={className}
      role="application"
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerLeave={() => {
        hoveredIdRef.current = null
        dirtyRef.current = true
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    />
  )
})
