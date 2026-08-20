import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasNode,
} from '../graph/PixiForceGraphCanvas'
import type { PixiForceGraphEdge } from '../graph/PixiForceGraphRenderer'
import { ForceGraphLayoutController } from '../graph/forceGraphLayout'
import type { EntityFactGraphData, EntityFactGraphNode } from './entityFactGraphModel'

interface EntityFactGraphCanvasProps {
  data: EntityFactGraphData
  onSelect: (nodeId: string | null) => void
  selectedId: string | null
}

const ENTITY_POSITIONS = [
  [260, 140],
  [130, 62],
  [390, 62],
  [104, 218],
  [416, 218],
  [260, 246],
] as const

const FACT_POSITIONS = [
  [260, 50],
  [94, 140],
  [426, 140],
  [260, 182],
] as const

export function EntityFactGraphCanvas({ data, onSelect, selectedId }: EntityFactGraphCanvasProps) {
  const [layout, setLayout] = useState<ForceGraphLayoutController | null>(null)
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((node, index) => [node.id, index])),
    [data.nodes],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => data.nodes.map((node) => ({
    color: node.kind === 'entity' ? 0x408cf0 : 0x8fb9f3,
    id: node.id,
    label: node.label,
    radius: node.kind === 'entity' ? 12 : 6,
  })), [data.nodes])
  const edges = useMemo<PixiForceGraphEdge[]>(() => data.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    return source === undefined || target === undefined ? [] : [{ source, target }]
  }), [data.edges, nodeIndex])
  const positions = useMemo(() => {
    let entityIndex = 0
    let factIndex = 0
    const result = new Float32Array(data.nodes.length * 2)
    data.nodes.forEach((node, index) => {
      const position = node.kind === 'entity'
        ? ENTITY_POSITIONS[entityIndex++] ?? ENTITY_POSITIONS[0]
        : FACT_POSITIONS[factIndex++] ?? FACT_POSITIONS[0]
      result[index * 2] = position[0]
      result[index * 2 + 1] = position[1]
    })
    return result
  }, [data.nodes])
  const resizeLayout = useCallback(
    (width: number, height: number) => layout?.resize(width, height),
    [layout],
  )
  const readRevision = useCallback(() => layout?.revision() ?? 0, [layout])

  useEffect(() => {
    let next: ForceGraphLayoutController
    try {
      next = new ForceGraphLayoutController({
        nodes: data.nodes.map((node, index) => ({
          id: node.id,
          radius: node.kind === 'entity' ? 12 : 6,
          x: positions[index * 2],
          y: positions[index * 2 + 1],
        })),
        edges: data.edges.map((edge) => ({ source: edge.source, target: edge.target })),
        options: {
          collisionPadding: 8,
          linkDistance: 82,
          manyBodyStrength: -140,
        },
      })
    } catch (error) {
      console.error('Failed to initialize entity/fact force graph layout', error)
      setLayout(null)
      return
    }
    setLayout(next)
    void next.ready.catch((error) => {
      console.error('Entity/fact force graph worker failed', error)
    })
    return () => next.dispose()
  }, [data.edges, data.nodes, positions])

  return (
    <div className="context-room-entity-fact-graph-shell">
      <PixiForceGraphCanvas
        ariaLabel="Room 实体与事实图谱画布"
        className="context-room-entity-fact-graph-canvas"
        edges={edges}
        nodes={nodes}
        positions={layout?.snapshot.positions ?? positions}
        revision={layout ? readRevision : undefined}
        selectedId={selectedId}
        onResize={resizeLayout}
        onDragNode={(nodeId, x, y) => layout?.drag(nodeId, x, y)}
        onReleaseNode={(nodeId) => layout?.release(nodeId)}
        onSelectNode={onSelect}
      />
      <div className="context-room-visually-hidden" aria-label="实体与事实节点">
        {data.nodes.map((node: EntityFactGraphNode) => (
          <button
            type="button"
            key={node.id}
            aria-label={`${node.kind === 'entity' ? '实体' : '事实'}：${node.label}`}
            aria-pressed={selectedId === node.id}
            onClick={() => onSelect(node.id)}
          >
            {node.label}
          </button>
        ))}
      </div>
    </div>
  )
}
