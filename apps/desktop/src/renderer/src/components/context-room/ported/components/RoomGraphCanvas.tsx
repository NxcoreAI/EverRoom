import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'

import type { ContextRoomKind, ContextRoomRecord } from '../types'
import type { KnowledgeRoomRelationDto } from '../../../../../../shared/knowledge'
import {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
  type PixiForceGraphEdge,
  useForceGraphLayout,
} from '@/components/graph'
import {
  roomGraphLayoutDimensions,
  roomGraphLayoutOptions,
  roomRelationTypeColor,
} from './roomGraphVisuals'
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
  /**
   * 「无操作自动复位」的空闲阈值（毫秒）；不传 = 关闭。
   *
   * 语义：用户改过视口（缩放 / 平移拖拽）之后，鼠标**离开画布**满 N 毫秒 →
   * 弹性补间回到自适应视野。画布内图谱保持不动；只点击节点（没移动、视口没变）
   * 不会武装；移回画布会取消待触发的复位并停掉在播补间。
   */
  autoFitOnIdleMs?: number
}

const ROOM_KIND_COLORS: Record<ContextRoomKind, number> = {
  项目: 0x3d6ff6,
  机构: 0x2a6fbd,
  主题: 0x7658d6,
  人物: 0x2f8a68,
  长期目标: 0xc67a25,
  议题: 0xc95b55,
  事件: 0xd06b35,
}

const ROOM_KIND_GRAPH_ICONS: Record<ContextRoomKind, PixiForceGraphCanvasNode['icon']> = {
  项目: 'target',
  机构: 'landmark',
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
    autoFitOnIdleMs = 0,
  }: RoomGraphCanvasProps,
  ref: React.ForwardedRef<RoomGraphCanvasHandle>,
) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
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
  // 标称屏幕尺寸决定布局世界的自然下限：紧凑详情面板用更小的标称宽度，
  // 让初始世界（以及 resize 下限）比首页全图小一圈。
  const initialLayoutDimensions = useMemo(() => roomGraphLayoutDimensions({
    compact,
    nodeCount: nodes.length,
    relationCount: relations.length,
    screenHeight: 420,
    screenWidth: compact ? 480 : 640,
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
  const layoutNodes = useMemo(() => rooms.map((room, index) => ({
    id: room.id,
    radius: compact ? 22 : 29,
    x: fallbackPositions[index * 2],
    y: fallbackPositions[index * 2 + 1],
  })), [compact, fallbackPositions, rooms])
  const layoutOptions = useMemo(() => ({
    ...roomGraphLayoutOptions({ compact, nodeCount: rooms.length, relationCount: relations.length }),
    ...initialLayoutDimensions,
  }), [compact, initialLayoutDimensions, relations.length, rooms.length])
  // 布局开跑或世界随面板变化后，等力导向稳定再把视野对准内容：
  // 紧凑面板只居中不缩小（minScale 1），全屏总览整体适配；
  // 收敛期间相机逐帧跟随内容，避免首帧与稳定后的视野跳变。
  const settleFit = useMemo(
    () => ({ minScale: compact ? 1 : undefined, follow: true }),
    [compact],
  )
  const layout = useForceGraphLayout({
    nodes: layoutNodes,
    edges: layoutEdges,
    options: layoutOptions,
    label: 'Room force graph',
    canvasRef,
    settleFit,
  })
  // 「无操作自动复位」：只有视口真被用户改动过（缩放 / 平移拖拽）才武装；
  // 复位时机：鼠标**离开**关系图谱画布满 autoFitOnIdleMs → 弹性补间回自适应视野。
  // 鼠标在画布内时图谱必须保持不动（不排倒计时）；回进画布会取消待触发的复位和正在播放的补间。
  const autoFitTimer = useRef<number | null>(null)
  const autoFitArmed = useRef(false)
  const pointerInside = useRef(false)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const pointerMoved = useRef(false)
  const draggingNode = useRef(false)
  const autoFitFire = useCallback(() => {
    autoFitTimer.current = null
    autoFitArmed.current = false
    const canvas = canvasRef.current
    // 1s 慢弹簧（一大一小交替）补间归位；不支持补间的画布退回瞬时对准。
    if (canvas?.animateFitView) canvas.animateFitView({ durationMs: 1000 })
    else canvas?.fitView()
  }, [])
  const clearAutoFitTimer = useCallback(() => {
    if (autoFitTimer.current === null) return
    window.clearTimeout(autoFitTimer.current)
    autoFitTimer.current = null
  }, [])
  const armAutoFit = useCallback(() => {
    // 只武装，不排倒计时：倒计时一律等鼠标离开画布才开始
    autoFitArmed.current = true
  }, [])
  useEffect(() => clearAutoFitTimer, [clearAutoFitTimer])

  const handlePointerEnter = useCallback(() => {
    pointerInside.current = true
    // 鼠标回到画布内：取消待触发的复位；正在播放的补间也立刻停（画布内图谱必须静止）。
    // 若确实停掉了一段在播的补间，重新武装——等下次离开时把它补完。
    clearAutoFitTimer()
    if (canvasRef.current?.cancelFitAnimation?.()) autoFitArmed.current = true
  }, [clearAutoFitTimer])
  const handlePointerLeave = useCallback(() => {
    pointerInside.current = false
    pointerStart.current = null
    // 离开画布才开始倒计时（视口被改过才需要复位）
    clearAutoFitTimer()
    if (autoFitOnIdleMs <= 0 || !autoFitArmed.current) return
    autoFitTimer.current = window.setTimeout(autoFitFire, autoFitOnIdleMs)
  }, [autoFitFire, autoFitOnIdleMs, clearAutoFitTimer])
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointerInside.current = true
    pointerStart.current = { x: event.clientX, y: event.clientY }
    pointerMoved.current = false
    draggingNode.current = false
    // 用户伸手了：正在播放的复位补间立刻停（否则会跟拖拽抢镜头）
    canvasRef.current?.cancelFitAnimation?.()
  }, [])
  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointerInside.current = true
    const start = pointerStart.current
    if (start && !pointerMoved.current) {
      // 3px 死区：点击节点时的轻微抖动不算「改动视口」
      if (Math.abs(event.clientX - start.x) > 3 || Math.abs(event.clientY - start.y) > 3) {
        pointerMoved.current = true
        // 拖的是节点（不是平移画布）→ 视口没变，不武装
        if (!draggingNode.current) armAutoFit()
      }
    }
  }, [armAutoFit])
  const handlePointerEnd = useCallback(() => {
    pointerStart.current = null
  }, [])
  const handleWheel = useCallback(() => {
    // 滚轮 = 缩放，视口一定变了；正在播放的补间同样让位
    canvasRef.current?.cancelFitAnimation?.()
    armAutoFit()
  }, [armAutoFit])

  const resizeLayout = useCallback((width: number, height: number) => {
    const dimensions = roomGraphLayoutDimensions({
      compact,
      nodeCount: nodes.length,
      relationCount: relations.length,
      screenHeight: height,
      screenWidth: width,
    })
    // layout.resize 以初始自适应尺寸为下限：面板（视口）再小也不压缩布局世界；
    // 世界变化后的视野对准由 settleFit 策略负责。
    layout.resize(dimensions.width, dimensions.height)
  }, [compact, layout.resize, nodes.length, relations.length])

  useImperativeHandle(ref, () => ({
    async fitView() {
      canvasRef.current?.fitView()
    },
  }), [])

  return (
    <div
      className="context-room-graph-shell nx-graph-shell"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onWheel={handleWheel}
    >
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:graphs.roomRelationsCanvas')}
        centerOnMount
        className="context-room-graph-canvas"
        edges={edges}
        maskUntilStable
        nodes={nodes}
        positions={layout.positions ?? fallbackPositions}
        revision={layout.revision}
        selectedId={selectedId}
        selectedEdgeId={selectedRelationId}
        onResize={resizeLayout}
        onUserGesture={layout.cancelAutoFit}
        onDragNode={(nodeId, x, y) => {
          draggingNode.current = true
          layout.drag(nodeId, x, y)
        }}
        onReleaseNode={layout.release}
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
