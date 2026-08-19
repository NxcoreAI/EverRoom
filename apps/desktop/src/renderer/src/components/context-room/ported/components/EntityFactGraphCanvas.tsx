import { useMemo } from 'react'

import {
  InteractiveGraphCanvas,
  type GraphCanvasEdge,
  type GraphCanvasNode,
} from '../graph/InteractiveGraphCanvas'
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
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((node, index) => [node.id, index])),
    [data.nodes],
  )
  const nodes = useMemo<GraphCanvasNode[]>(() => data.nodes.map((node) => ({
    fill: node.kind === 'entity' ? '#408cf0' : '#8fb9f3',
    id: node.id,
    label: node.label,
    radius: node.kind === 'entity' ? 12 : 6,
    stroke: node.kind === 'entity' ? '#408cf0' : '#8fb9f3',
  })), [data.nodes])
  const edges = useMemo<GraphCanvasEdge[]>(() => data.edges.flatMap((edge) => {
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

  return (
    <div className="context-room-entity-fact-graph-shell">
      <InteractiveGraphCanvas
        ariaLabel="Room 实体与事实图谱画布"
        className="context-room-entity-fact-graph-canvas"
        edges={edges}
        nodes={nodes}
        positions={positions}
        selectedId={selectedId}
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
