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
  const [layout, setLayout] = useState<ForceGraphLayoutController | null>(null)
  const nodeIndex = useMemo(
    () => new Map(rooms.map((node, index) => [node.id, index])),
    [rooms],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => rooms.map((room) => ({
    color: ROOM_KIND_COLORS[room.kind],
    id: room.id,
    label: room.title,
    radius: compact ? 22 : 29,
  })), [compact, rooms])
  const edges = useMemo<PixiForceGraphEdge[]>(() => relations.flatMap((edge) => {
    const source = nodeIndex.get(edge.sourceRoomId)
    const target = nodeIndex.get(edge.targetRoomId)
    return source === undefined || target === undefined
      ? []
      : [{
          id: edge.id,
          source,
          target,
          label: edge.label?.trim() || relationTypeLabel(edge.type, t),
          directed: edge.directed,
          color: edge.origin === 'auto' ? 0x929ba8 : 0x3d6ff6,
          width: edge.strength === 'strong' ? 3 : edge.strength === 'medium' ? 2.1 : 1.25,
          alpha: edge.strength === 'strong' ? 0.92 : edge.strength === 'medium' ? 0.72 : 0.5,
        }]
  }), [relations, nodeIndex, t])
  const layoutEdges = useMemo(() => relations.flatMap((edge) => (
    nodeIndex.has(edge.sourceRoomId) && nodeIndex.has(edge.targetRoomId)
      ? [{ source: edge.sourceRoomId, target: edge.targetRoomId }]
      : []
  )), [nodeIndex, relations])
  const fallbackPositions = useMemo(() => {
    const result = new Float32Array(nodes.length * 2)
    nodes.forEach((_, index) => {
      const ring = Math.floor(Math.sqrt(index))
      const ringStart = ring * ring
      const ringSize = Math.max(1, (ring + 1) * (ring + 1) - ringStart)
      const angle = ((index - ringStart) / ringSize) * Math.PI * 2
      const radius = ring === 0 ? 0 : 88 + ring * 70
      result[index * 2] = 360 + Math.cos(angle) * radius
      result[index * 2 + 1] = 220 + Math.sin(angle) * radius
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
        nodes: rooms.map((room, index) => ({
          id: room.id,
          radius: compact ? 22 : 29,
          x: fallbackPositions[index * 2],
          y: fallbackPositions[index * 2 + 1],
        })),
        edges: layoutEdges,
        options: compact
          ? {
              collisionPadding: 8,
              collisionStrength: 0.72,
              linkDistance: 105,
              linkStrength: 0.22,
              manyBodyStrength: -105,
              velocityDecay: 0.56,
            }
          : {
              collisionPadding: 10,
              collisionStrength: 0.78,
              linkDistance: 118,
              linkStrength: 0.24,
              manyBodyStrength: -135,
              velocityDecay: 0.54,
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
  }, [compact, fallbackPositions, layoutEdges, rooms])

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
