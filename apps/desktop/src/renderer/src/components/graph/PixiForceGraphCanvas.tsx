import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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
  fitView(): void
}

interface PixiForceGraphCanvasProps {
  ariaLabel: string
  className: string
  edges: readonly PixiForceGraphEdge[]
  nodes: readonly PixiForceGraphCanvasNode[]
  onResize?: (width: number, height: number) => void
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
  className,
  edges,
  nodes,
  onDragNode,
  onSelectEdge,
  onOpenNode,
  onReleaseNode,
  onResize,
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
    fitView() {
      rendererRef.current?.fitView()
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let observer: ResizeObserver | null = null
    let canvas: HTMLCanvasElement | null = null
    let renderer: PixiForceGraphRenderer | null = null

    try {
      const nextRenderer = createPixiForceGraphRenderer({
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
  }, [ariaLabel, edges, nodes, positions, revision])

  useEffect(() => {
    const selectedIndex = selectedId ? nodes.findIndex((node) => node.id === selectedId) : null
    rendererRef.current?.setSelectedIndex(selectedIndex === -1 ? null : selectedIndex)
  }, [nodes, selectedId])

  useEffect(() => {
    rendererRef.current?.setSelectedEdgeId(selectedEdgeId)
  }, [selectedEdgeId])

  // 内核自带中性壳层类，领域 className 退化为纯修饰（背景/高度覆盖等）。
  return <div ref={hostRef} className={`nx-graph-canvas ${className}`} />
})
