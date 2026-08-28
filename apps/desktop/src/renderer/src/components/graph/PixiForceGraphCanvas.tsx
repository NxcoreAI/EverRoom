import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Application, Container, Graphics, ParticleContainer, Sprite, Text, Ticker } from 'pixi.js'
import { Viewport } from 'pixi-viewport'

import './graphShell.css'

import {
  createPixiForceGraphRenderer,
  type PixiForceGraphDependencies,
  type PixiForceGraphEdge,
  type PixiForceGraphNode,
  type PixiForceGraphRenderer,
} from './pixi/PixiForceGraphRenderer'

const PIXI_DEPENDENCIES = {
  Application,
  Container,
  Graphics,
  ParticleContainer,
  Sprite,
  Text,
  Ticker,
  Viewport,
} as unknown as PixiForceGraphDependencies

export interface PixiForceGraphCanvasNode extends PixiForceGraphNode {
  id: string
}

export interface PixiForceGraphCanvasHandle {
  fitView(minScale?: number): void
}

interface PixiForceGraphCanvasProps {
  ariaLabel: string
  className: string
  /** 面板只作视口：初始视野对准内容中心、保持原始缩放（世界可大于面板，拖拽平移浏览）。 */
  centerOnMount?: boolean
  /** 首帧稳定前显示加载遮罩：Worker 首次发布坐标（revision > 0）后淡出，超时兜底揭开。 */
  maskUntilStable?: boolean
  edges: readonly PixiForceGraphEdge[]
  nodes: readonly PixiForceGraphCanvasNode[]
  onResize?: (width: number, height: number) => void
  /** 用户手势（按下/滚轮）接管画布时触发：使用方用来停掉自动对准/相机跟随。 */
  onUserGesture?: () => void
  onDragNode?: (nodeId: string, x: number, y: number) => void
  onSelectEdge?: (edgeId: string) => void
  onOpenNode?: (nodeId: string) => void
  onReleaseNode?: (nodeId: string) => void
  onSelectNode: (nodeId: string | null) => void
  positions: Float32Array
  revision?: () => number
  selectedId: string | null
  selectedEdgeId?: string | null
}

/** React lifecycle shell for the PIXI force-graph renderer. */
export const PixiForceGraphCanvas = forwardRef<PixiForceGraphCanvasHandle, PixiForceGraphCanvasProps>(function PixiForceGraphCanvas({
  ariaLabel,
  centerOnMount = false,
  className,
  edges,
  maskUntilStable = false,
  nodes,
  onDragNode,
  onSelectEdge,
  onOpenNode,
  onReleaseNode,
  onResize,
  onUserGesture,
  onSelectNode,
  positions,
  revision,
  selectedId,
  selectedEdgeId = null,
}, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PixiForceGraphRenderer | null>(null)
  const propsRef = useRef({ nodes, onDragNode, onOpenNode, onReleaseNode, onResize, onSelectEdge, onSelectNode })
  propsRef.current = { nodes, onDragNode, onOpenNode, onReleaseNode, onResize, onSelectEdge, onSelectNode }

  useImperativeHandle(ref, () => ({
    fitView(minScale?: number) {
      rendererRef.current?.fitView(minScale)
    },
  }), [])

  // 首帧遮罩：Worker 发布首个有效布局（revision > 0）前盖住画布，避免
  // 兜底坐标与原点帧闪现；就绪后不立刻揭开——按住一小段等相机跟随把
  // 视野收敛稳，且保底一段最短时长，避免遮罩一闪而过反而显得闪烁；
  // 无 Worker 或初始化卡死时超时兜底揭开。揭开后不再重盖——数据更新
  // 引起的渲染器重建不会闪回加载态。
  const [revealed, setRevealed] = useState(() => !maskUntilStable)
  useEffect(() => {
    if (!maskUntilStable) return
    const HOLD_AFTER_READY_MS = 300 // 坐标就绪后再捂：相机跟随收敛后才淡出
    const MIN_MASK_MS = 500 // 最短遮罩时长
    const TIMEOUT_MS = 2500 // 兜底：Worker 不可用/卡死时也要揭开
    const startedAt = Date.now()
    let readyAt: number | null = null
    let revealAt = startedAt + TIMEOUT_MS
    let raf = 0
    const check = () => {
      const now = Date.now()
      if (readyAt === null && (revision?.() ?? 0) > 0) {
        readyAt = now
        revealAt = Math.max(now + HOLD_AFTER_READY_MS, startedAt + MIN_MASK_MS)
      }
      if (now >= revealAt) {
        setRevealed(true)
        return
      }
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [maskUntilStable, revision])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let observer: ResizeObserver | null = null
    let canvas: HTMLCanvasElement | null = null
    let renderer: PixiForceGraphRenderer | null = null

    try {
      const nextRenderer = createPixiForceGraphRenderer({
        centerOnMount,
        dependencies: PIXI_DEPENDENCIES,
        edges,
        host: host as unknown as Parameters<typeof createPixiForceGraphRenderer>[0]['host'],
        nodes,
        positions,
        revision,
        selectedIndex: selectedId ? nodes.findIndex((node) => node.id === selectedId) : null,
        selectedEdgeId,
        onEdgeSelect: (edgeId) => propsRef.current.onSelectEdge?.(edgeId),
        onNodeDrag: (index, x, y) => {
          const nodeId = propsRef.current.nodes[index]?.id
          if (nodeId) propsRef.current.onDragNode?.(nodeId, x, y)
        },
        onNodeOpen: (index) => {
          const nodeId = propsRef.current.nodes[index]?.id
          if (nodeId) propsRef.current.onOpenNode?.(nodeId)
        },
        onNodeRelease: (index) => {
          const nodeId = propsRef.current.nodes[index]?.id
          if (nodeId) propsRef.current.onReleaseNode?.(nodeId)
        },
        onNodeSelect: (index) => {
          propsRef.current.onSelectNode(propsRef.current.nodes[index]?.id ?? null)
        },
      })
      renderer = nextRenderer
      rendererRef.current = nextRenderer
      canvas = (nextRenderer.app.canvas ?? nextRenderer.app.view) as HTMLCanvasElement
      canvas.setAttribute('aria-label', ariaLabel)
      canvas.setAttribute('role', 'application')
      canvas.tabIndex = 0

      const resize = () => {
        const width = Math.max(1, host.clientWidth)
        const height = Math.max(1, host.clientHeight)
        nextRenderer.resize(width, height)
        propsRef.current.onResize?.(width, height)
      }
      observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
      observer?.observe(host)
      resize()
    } catch (error) {
      console.error('Failed to initialize PIXI force graph renderer', error)
    }

    return () => {
      observer?.disconnect()
      if (rendererRef.current === renderer) rendererRef.current = null
      renderer?.destroy()
    }
  }, [ariaLabel, centerOnMount, edges, nodes, positions, revision])

  useEffect(() => {
    const selectedIndex = selectedId ? nodes.findIndex((node) => node.id === selectedId) : null
    rendererRef.current?.setSelectedIndex(selectedIndex === -1 ? null : selectedIndex)
  }, [nodes, selectedId])

  useEffect(() => {
    rendererRef.current?.setSelectedEdgeId(selectedEdgeId)
  }, [selectedEdgeId])

  // 内核自带中性壳层类，领域 className 退化为纯修饰（背景/高度覆盖等）。
  // 捕获阶段监听按下/滚轮：用户接管画布的第一时间通知使用方停掉相机自动化，
  // 否则平移/缩放会与收敛期的自动对准互相拉扯。
  return (
    <div
      ref={hostRef}
      className={`nx-graph-canvas ${className}`}
      onPointerDownCapture={onUserGesture}
      onWheelCapture={onUserGesture}
    >
      <div aria-hidden="true" className={`nx-graph-loading${revealed ? ' is-revealed' : ''}`} />
    </div>
  )
})
