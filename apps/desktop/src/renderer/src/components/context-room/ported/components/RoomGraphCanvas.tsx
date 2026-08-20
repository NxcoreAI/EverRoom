import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'

import type { ContextRoomKind, ContextRoomRecord } from '../types'
import {
  InteractiveGraphCanvas,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type InteractiveGraphCanvasHandle,
} from '../graph/InteractiveGraphCanvas'
import { createRoomGraphData } from './roomGraphModel'

export interface RoomGraphCanvasHandle {
  fitView(): Promise<void>
}

interface RoomGraphCanvasProps {
  compact?: boolean
  rooms: ContextRoomRecord[]
  selectedId: string | null
  onOpenRoom: (roomId: string) => void
  onSelectRoom: (roomId: string | null) => void
}

const ROOM_KIND_COLORS: Record<ContextRoomKind, { fill: string; stroke: string }> = {
  项目: { fill: '#eef3ff', stroke: '#3d6ff6' },
  主题: { fill: '#f2efff', stroke: '#7658d6' },
  人物: { fill: '#e9f7f0', stroke: '#2f8a68' },
  长期目标: { fill: '#fff5e8', stroke: '#c67a25' },
  议题: { fill: '#fff1f0', stroke: '#c95b55' },
  事件: { fill: '#fff3e8', stroke: '#d06b35' },
}

const ROOM_NODE_POSITIONS = [
  [360, 220],
  [140, 130],
  [590, 120],
  [180, 350],
  [550, 355],
  [360, 70],
  [70, 255],
  [655, 250],
] as const

function RoomGraphCanvasComponent(
  { compact = false, rooms, selectedId, onOpenRoom, onSelectRoom }: RoomGraphCanvasProps,
  ref: React.ForwardedRef<RoomGraphCanvasHandle>,
) {
  const canvasRef = useRef<InteractiveGraphCanvasHandle>(null)
  const graph = useMemo(() => createRoomGraphData(rooms), [rooms])
  const nodeIndex = useMemo(
    () => new Map(graph.nodes.map((node, index) => [node.id, index])),
    [graph.nodes],
  )
  const nodes = useMemo<GraphCanvasNode[]>(() => graph.nodes.map((room) => ({
    ...ROOM_KIND_COLORS[room.kind],
    id: room.id,
    label: room.title,
    radius: compact ? 22 : 29,
  })), [compact, graph.nodes])
  const edges = useMemo<GraphCanvasEdge[]>(() => graph.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    return source === undefined || target === undefined
      ? []
      : [{ source, target, label: edge.relation }]
  }), [graph.edges, nodeIndex])
  const positions = useMemo(() => {
    const result = new Float32Array(nodes.length * 2)
    nodes.forEach((_, index) => {
      result[index * 2] = ROOM_NODE_POSITIONS[index]?.[0]
        ?? 360 + (index - ROOM_NODE_POSITIONS.length) * 70
      result[index * 2 + 1] = ROOM_NODE_POSITIONS[index]?.[1] ?? 220
    })
    return result
  }, [nodes])

  useImperativeHandle(ref, () => ({
    async fitView() {
      canvasRef.current?.fitView()
    },
  }), [])

  return (
    <div className="context-room-graph-shell">
      <InteractiveGraphCanvas
        ref={canvasRef}
        ariaLabel="Room 关系图谱画布"
        className="context-room-graph-canvas"
        edges={edges}
        nodes={nodes}
        positions={positions}
        selectedId={selectedId}
        onOpenNode={onOpenRoom}
        onSelectNode={onSelectRoom}
      />
      <div className="context-room-visually-hidden" aria-label="Room 图谱节点">
        {graph.nodes.map((room) => (
          <button
            type="button"
            key={room.id}
            aria-label={`${room.kind} Room：${room.title}`}
            aria-pressed={selectedId === room.id}
            onClick={() => onSelectRoom(room.id)}
            onDoubleClick={() => onOpenRoom(room.id)}
          >
            查看关系 {room.kind} Room {room.title}
          </button>
        ))}
      </div>
    </div>
  )
}

export const RoomGraphCanvas = forwardRef(RoomGraphCanvasComponent)
