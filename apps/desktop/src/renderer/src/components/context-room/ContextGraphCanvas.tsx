import { Graph, type IElementEvent, type NodeData } from '@antv/g6'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import type { ContextGraphData, RoomKind } from './types'

export interface ContextGraphCanvasHandle {
  fitView(): Promise<void>
}

interface ContextGraphCanvasProps {
  data: ContextGraphData
  selectedId: string | null
  compact?: boolean
  onSelect: (id: string | null) => void
  onOpen?: (id: string) => void
}

const NODE_COLORS: Record<RoomKind | 'fact', { fill: string; stroke: string }> = {
  项目: { fill: '#eef3ff', stroke: '#3d6ff6' },
  主题: { fill: '#f3efff', stroke: '#7658d6' },
  人物: { fill: '#eaf7f1', stroke: '#2f8a68' },
  长期目标: { fill: '#fff5e8', stroke: '#c67a25' },
  议题: { fill: '#fff1f0', stroke: '#c95b55' },
  事件: { fill: '#fff3e8', stroke: '#d06b35' },
  fact: { fill: '#f7f8fa', stroke: '#8791a1' },
}

const POSITIONS = [
  [0.5, 0.5],
  [0.19, 0.22],
  [0.78, 0.2],
  [0.18, 0.76],
  [0.8, 0.75],
  [0.5, 0.13],
  [0.47, 0.86],
  [0.9, 0.45],
] as const

function nodeKind(datum: NodeData): RoomKind | 'fact' {
  const kind = datum.data?.kind
  return typeof kind === 'string' && kind in NODE_COLORS ? (kind as RoomKind | 'fact') : '主题'
}

function nodeColor(datum: NodeData) {
  return NODE_COLORS[nodeKind(datum)]
}

function nodeStates(data: ContextGraphData, activeId: string | null, state: 'hover' | 'selected') {
  const states: Record<string, string[]> = {}
  if (!activeId) {
    data.nodes.forEach((node) => { states[node.id] = [] })
    data.edges.forEach((edge) => { states[edge.id] = [] })
    return states
  }
  const adjacent = data.edges.filter((edge) => edge.source === activeId || edge.target === activeId)
  const neighbors = new Set(adjacent.map((edge) => edge.source === activeId ? edge.target : edge.source))
  data.nodes.forEach((node) => {
    states[node.id] = node.id === activeId ? [state] : neighbors.has(node.id) ? ['neighbor'] : ['dim']
  })
  data.edges.forEach((edge) => {
    states[edge.id] = adjacent.some((candidate) => candidate.id === edge.id) ? ['neighbor'] : ['dim']
  })
  return states
}

function positionedNodes(data: ContextGraphData, width: number, height: number) {
  return data.nodes.map((node, index) => {
    const position = POSITIONS[index] ?? [0.5 + ((index % 2) * 0.18), 0.5]
    return {
      id: node.id,
      data: { kind: node.kind, label: node.label },
      style: { x: position[0] * width, y: position[1] * height },
    }
  })
}

function ContextGraphCanvasComponent(
  { data, selectedId, compact = false, onSelect, onOpen }: ContextGraphCanvasProps,
  ref: React.ForwardedRef<ContextGraphCanvasHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const dataRef = useRef(data)
  const selectedIdRef = useRef(selectedId)
  const onSelectRef = useRef(onSelect)
  const onOpenRef = useRef(onOpen)
  const renderPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const renderRevisionRef = useRef(0)
  const renderedIdsRef = useRef<Set<string>>(new Set())
  dataRef.current = data
  selectedIdRef.current = selectedId
  onSelectRef.current = onSelect
  onOpenRef.current = onOpen

  useImperativeHandle(ref, () => ({
    fitView: async () => {
      await graphRef.current?.fitView()
    },
  }), [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const graph = new Graph({
      container,
      width: container.clientWidth || 680,
      height: container.clientHeight || 390,
      animation: false,
      behaviors: ['drag-canvas', 'zoom-canvas'],
      node: {
        style: {
          size: (datum: NodeData) => nodeKind(datum) === 'fact' ? (compact ? 22 : 28) : (compact ? 38 : 48),
          fill: (datum: NodeData) => nodeColor(datum).fill,
          stroke: (datum: NodeData) => nodeColor(datum).stroke,
          lineWidth: 1.8,
          shadowColor: 'rgba(17, 24, 39, 0.12)',
          shadowBlur: 8,
          cursor: 'pointer',
          labelText: (datum: NodeData) => typeof datum.data?.label === 'string' ? datum.data.label : '',
          labelFill: '#394150',
          labelFontSize: compact ? 9 : 11,
          labelFontWeight: 520,
          labelPlacement: 'bottom',
          labelOffsetY: 7,
          labelMaxWidth: compact ? 82 : 116,
          labelWordWrap: true,
        },
        state: {
          selected: { stroke: '#3d6ff6', lineWidth: 3, halo: true, haloStroke: '#3d6ff6', haloLineWidth: 7, haloStrokeOpacity: 0.15 },
          hover: { stroke: '#3d6ff6', lineWidth: 3, shadowColor: 'rgba(61, 111, 246, 0.2)', shadowBlur: 15 },
          neighbor: { stroke: '#3d6ff6', lineWidth: 2.4, opacity: 1 },
          dim: { opacity: 0.23 },
        },
      },
      edge: {
        style: {
          stroke: '#b8c0cc',
          lineWidth: 1.25,
          opacity: 0.82,
          labelText: (datum: { data?: { label?: unknown } }) => typeof datum.data?.label === 'string' ? datum.data.label : '',
          labelFill: '#7b8491',
          labelFontSize: compact ? 8 : 9,
          labelBackground: true,
          labelBackgroundFill: '#ffffff',
          labelBackgroundOpacity: 0.9,
          labelBackgroundPadding: [2, 4, 2, 4],
        },
        state: {
          neighbor: { stroke: '#3d6ff6', lineWidth: 1.9, opacity: 1 },
          dim: { opacity: 0.1 },
        },
      },
    })
    graphRef.current = graph

    const applyState = (states: Record<string, string[]>) => {
      void renderPromiseRef.current.then(async () => {
        if (graphRef.current !== graph) return
        const renderedStates = Object.fromEntries(
          Object.entries(states).filter(([id]) => renderedIdsRef.current.has(id)),
        )
        if (Object.keys(renderedStates).length) await graph.setElementState(renderedStates)
      }).catch(() => undefined)
    }

    graph.on('node:click', (event: IElementEvent) => {
      if (event.target.id) onSelectRef.current(event.target.id)
    })
    graph.on('node:dblclick', (event: IElementEvent) => {
      if (event.target.id) onOpenRef.current?.(event.target.id)
    })
    graph.on('node:pointerenter', (event: IElementEvent) => {
      if (event.target.id) applyState(nodeStates(dataRef.current, event.target.id, 'hover'))
    })
    graph.on('node:pointerleave', () => {
      applyState(nodeStates(dataRef.current, selectedIdRef.current, 'selected'))
    })
    graph.on('canvas:click', () => onSelectRef.current(null))

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return
      graph.resize(container.clientWidth, container.clientHeight)
      const current = dataRef.current
      void renderPromiseRef.current.then(async () => {
        if (graphRef.current !== graph) return
        graph.updateNodeData(positionedNodes(current, container.clientWidth, container.clientHeight))
        await graph.draw()
      }).catch(() => undefined)
    })
    resizeObserver?.observe(container)

    return () => {
      resizeObserver?.disconnect()
      renderRevisionRef.current += 1
      renderedIdsRef.current.clear()
      graphRef.current = null
      void renderPromiseRef.current.finally(() => graph.destroy())
    }
  }, [compact])

  useEffect(() => {
    const graph = graphRef.current
    const container = containerRef.current
    if (!graph || !container) return
    const revision = renderRevisionRef.current + 1
    renderRevisionRef.current = revision
    const ids = new Set([...data.nodes.map((node) => node.id), ...data.edges.map((edge) => edge.id)])
    graph.setData({
      nodes: positionedNodes(data, container.clientWidth || 680, container.clientHeight || 390),
      edges: data.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: { label: edge.label },
      })),
    })
    const renderPromise = graph.render().then(async () => {
      if (graphRef.current !== graph || renderRevisionRef.current !== revision) return
      renderedIdsRef.current = ids
      await graph.fitView()
      await graph.setElementState(nodeStates(data, selectedIdRef.current, 'selected'))
    }).catch(() => undefined)
    renderPromiseRef.current = renderPromise
  }, [compact, data])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    void renderPromiseRef.current.then(async () => {
      if (graphRef.current !== graph) return
      const states = Object.fromEntries(
        Object.entries(nodeStates(data, selectedId, 'selected')).filter(([id]) => renderedIdsRef.current.has(id)),
      )
      if (Object.keys(states).length) await graph.setElementState(states)
    }).catch(() => undefined)
  }, [data, selectedId])

  return (
    <div className="cr-graph-shell">
      <div ref={containerRef} className="cr-graph-canvas" role="application" aria-label="Context Room 关系图谱" />
      <div className="cr-visually-hidden" aria-label="图谱节点">
        {data.nodes.map((node) => (
          <button key={node.id} type="button" aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)}>
            {node.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export const ContextGraphCanvas = forwardRef(ContextGraphCanvasComponent)
