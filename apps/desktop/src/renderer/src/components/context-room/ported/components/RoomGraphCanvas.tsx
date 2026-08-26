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
import type { KnowledgeRoomRelationDto } from '../../../../../../shared/knowledge'
import {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
} from '../graph/PixiForceGraphCanvas'
import type { PixiForceGraphEdge } from '../graph/PixiForceGraphRenderer'
import { ForceGraphLayoutController } from '../graph/forceGraphLayout'
import {
  roomGraphLayoutDimensions,
  roomGraphLayoutOptions,
  roomRelationTypeColor,
} from '../graph/roomGraphVisuals'
import { useLocale } from '../../../../i18n/LocaleContext'
import { uiText } from '../adapters'
import { relationTypeLabel } from './RoomRelationControls'

export interface RoomGraphCanvasHandle {
  fitView(): Promise<void>
}

interface RoomGraphCanvasProps {
  compact?: boolean
  rooms: ContextRoomRecord[]
  relations: KnowledgeRoomRelationDto[]
  selectedId: string | null
  selectedRelationId?: string | null
  onOpenRoom: (roomId: string) => void
  onSelectRelation?: (relationId: string) => void
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

const ROOM_KIND_GRAPH_ICONS: Record<ContextRoomKind, PixiForceGraphCanvasNode['icon']> = {
  项目: 'target',
  主题: 'book',
  人物: 'user',
  长期目标: 'flag',
  议题: 'message',
  事件: 'zap',
}

function RoomGraphCanvasComponent(
  {
    compact = false,
    rooms,
    relations,
    selectedId,
    selectedRelationId = null,
    onOpenRoom,
    onSelectRelation,
    onSelectRoom,
  }: RoomGraphCanvasProps,
  ref: React.ForwardedRef<RoomGraphCanvasHandle>,
) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const fitTimerRef = useRef<number | null>(null)
  const [layout, setLayout] = useState<ForceGraphLayoutController | null>(null)
  const nodeIndex = useMemo(
    () => new Map(rooms.map((node, index) => [node.id, index])),
    [rooms],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => rooms.map((room) => ({
    color: ROOM_KIND_COLORS[room.kind],
    id: room.id,
    icon: ROOM_KIND_GRAPH_ICONS[room.kind],
    label: room.title,
    radius: compact ? 22 : 29,
  })), [compact, rooms])
  const edges = useMemo<PixiForceGraphEdge[]>(() => relations.flatMap((edge) => {
    const source = nodeIndex.get(edge.sourceRoomId)
    const target = nodeIndex.get(edge.targetRoomId)
    const color = roomRelationTypeColor(edge.type)
    return source === undefined || target === undefined
      ? []
      : [{
          id: edge.id,
          source,
          target,
          label: edge.label?.trim() || relationTypeLabel(edge.type, t),
          labelColor: color,
          directed: edge.directed,
          color,
          width: edge.strength === 'strong' ? 3 : edge.strength === 'medium' ? 2.1 : 1.25,
          alpha: edge.strength === 'strong' ? 0.92 : edge.strength === 'medium' ? 0.72 : 0.5,
        }]
  }), [relations, nodeIndex, t])
  const layoutEdges = useMemo(() => relations.flatMap((edge) => (
    nodeIndex.has(edge.sourceRoomId) && nodeIndex.has(edge.targetRoomId)
      ? [{ source: edge.sourceRoomId, target: edge.targetRoomId }]
      : []
  )), [nodeIndex, relations])
  const initialLayoutDimensions = useMemo(() => roomGraphLayoutDimensions({
    compact,
    nodeCount: nodes.length,
    relationCount: relations.length,
    screenHeight: 420,
    screenWidth: 640,
  }), [compact, nodes.length, relations.length])
  const fallbackPositions = useMemo(() => {
    const result = new Float32Array(nodes.length * 2)
    nodes.forEach((_, index) => {
      const angle = index * Math.PI * (3 - Math.sqrt(5))
      const distance = Math.min(initialLayoutDimensions.width, initialLayoutDimensions.height)
        * 0.38 * Math.sqrt(index / Math.max(1, nodes.length - 1))
      result[index * 2] = initialLayoutDimensions.width / 2 + Math.cos(angle) * distance
      result[index * 2 + 1] = initialLayoutDimensions.height / 2 + Math.sin(angle) * distance
    })
    return result
  }, [initialLayoutDimensions, nodes])
  const resizeLayout = useCallback((width: number, height: number) => {
    const dimensions = roomGraphLayoutDimensions({
      compact,
      nodeCount: nodes.length,
      relationCount: relations.length,
      screenHeight: height,
      screenWidth: width,
    })
    layout?.resize(dimensions.width, dimensions.height)
    if (dimensions.width > width || dimensions.height > height) {
      if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current)
      fitTimerRef.current = window.setTimeout(() => canvasRef.current?.fitView(), 500)
    }
  }, [compact, layout, nodes.length, relations.length])
  const readRevision = useCallback(() => layout?.revision() ?? 0, [layout])

  useEffect(() => {
    let next: ForceGraphLayoutController
    try {
      next = new ForceGraphLayoutController({
        nodes: rooms.map((room, index) => ({
          id: room.id,
          radius: compact ? 22 : 29,
          x: fallbackPositions[index * 2],
          y: fallbackPositions[index * 2 + 1],
        })),
        edges: layoutEdges,
        options: {
          ...roomGraphLayoutOptions({ compact, nodeCount: rooms.length, relationCount: relations.length }),
          ...initialLayoutDimensions,
        },
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
  }, [compact, fallbackPositions, initialLayoutDimensions, layoutEdges, relations.length, rooms])

  useEffect(() => () => {
    if (fitTimerRef.current !== null) window.clearTimeout(fitTimerRef.current)
  }, [])

  useImperativeHandle(ref, () => ({
    async fitView() {
      canvasRef.current?.fitView()
    },
  }), [])

  return (
    <div className="context-room-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:graphs.roomRelationsCanvas')}
        className="context-room-graph-canvas"
        edges={edges}
        nodes={nodes}
        positions={layout?.snapshot.positions ?? fallbackPositions}
        revision={layout ? readRevision : undefined}
        selectedId={selectedId}
        selectedEdgeId={selectedRelationId}
        onResize={resizeLayout}
        onDragNode={(nodeId, x, y) => layout?.drag(nodeId, x, y)}
        onReleaseNode={(nodeId) => layout?.release(nodeId)}
        onOpenNode={onOpenRoom}
        onSelectEdge={onSelectRelation}
        onSelectNode={onSelectRoom}
      />
      <div className="context-room-visually-hidden" aria-label={t('contextRoom:graphs.roomNodes')}>
        {rooms.map((room) => (
          <button
            type="button"
            key={room.id}
            aria-label={t('contextRoom:graphs.roomNode', { kind: t(uiText(room.kind)), title: room.title })}
            aria-pressed={selectedId === room.id}
            onClick={() => onSelectRoom(room.id)}
            onDoubleClick={() => onOpenRoom(room.id)}
          >
            {t('contextRoom:graphs.viewRelatedRoom', { kind: t(uiText(room.kind)), title: room.title })}
          </button>
        ))}
      </div>
    </div>
  )
}

export const RoomGraphCanvas = forwardRef(RoomGraphCanvasComponent)
