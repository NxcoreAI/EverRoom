import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { ContextRoomKind, ContextRoomRecord } from '../types'
import {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
} from '../graph/PixiForceGraphCanvas'
import type { PixiForceGraphEdge } from '../graph/PixiForceGraphRenderer'
import { ForceGraphLayoutController } from '../graph/forceGraphLayout'
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

const ROOM_KIND_COLORS: Record<ContextRoomKind, number> = {
  项目: 0x3d6ff6,
  主题: 0x7658d6,
  人物: 0x2f8a68,
  长期目标: 0xc67a25,
  议题: 0xc95b55,
  事件: 0xd06b35,
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
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const [layout, setLayout] = useState<ForceGraphLayoutController | null>(null)
  const graph = useMemo(() => createRoomGraphData(rooms), [rooms])
  const nodeIndex = useMemo(
    () => new Map(graph.nodes.map((node, index) => [node.id, index])),
    [graph.nodes],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => graph.nodes.map((room) => ({
    color: ROOM_KIND_COLORS[room.kind],
    id: room.id,
    label: room.title,
    radius: compact ? 22 : 29,
  })), [compact, graph.nodes])
  const edges = useMemo<PixiForceGraphEdge[]>(() => graph.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    return source === undefined || target === undefined
      ? []
      : [{ source, target }]
  }), [graph.edges, nodeIndex])
  const fallbackPositions = useMemo(() => {
    const result = new Float32Array(nodes.length * 2)
    nodes.forEach((_, index) => {
      result[index * 2] = ROOM_NODE_POSITIONS[index]?.[0]
        ?? 360 + (index - ROOM_NODE_POSITIONS.length) * 70
      result[index * 2 + 1] = ROOM_NODE_POSITIONS[index]?.[1] ?? 220
    })
    return result
  }, [nodes])
  const resizeLayout = useCallback(
    (width: number, height: number) => layout?.resize(width, height),
    [layout],
  )
  const readRevision = useCallback(() => layout?.revision() ?? 0, [layout])

  useEffect(() => {
    let next: ForceGraphLayoutController
    try {
      next = new ForceGraphLayoutController({
        nodes: graph.nodes.map((room, index) => ({
          id: room.id,
          radius: compact ? 22 : 29,
          x: fallbackPositions[index * 2],
          y: fallbackPositions[index * 2 + 1],
        })),
        edges: graph.edges,
        options: compact
          ? { collisionPadding: 8, linkDistance: 105, manyBodyStrength: -230 }
          : undefined,
      })
    } catch (error) {
      console.error('Failed to initialize Room force graph layout', error)
      setLayout(null)
      return
    }
    setLayout(next)
    void next.ready.catch((error) => {
      console.error('Room force graph worker failed', error)
    })
    return () => next.dispose()
  }, [compact, fallbackPositions, graph.edges, graph.nodes])

  useImperativeHandle(ref, () => ({
    async fitView() {
      canvasRef.current?.fitView()
    },
  }), [])

  return (
    <div className="context-room-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel="Room 关系图谱画布"
        className="context-room-graph-canvas"
        edges={edges}
        nodes={nodes}
        positions={layout?.snapshot.positions ?? fallbackPositions}
        revision={layout ? readRevision : undefined}
        selectedId={selectedId}
        onResize={resizeLayout}
        onDragNode={(nodeId, x, y) => layout?.drag(nodeId, x, y)}
        onReleaseNode={(nodeId) => layout?.release(nodeId)}
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
