import { useMemo, useRef } from 'react'

import type { RoomAppliedEntityStatus } from '@nxcore/agent-contract'
import {
  PixiForceGraphCanvas,
  scaleForceGraphWorld,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
  type ForceGraphOptions,
  type PixiForceGraphEdge,
  useForceGraphLayout,
} from '@/components/graph'
import { useLocale } from '../../../../i18n/LocaleContext'
import type { EntityFactGraphData, EntityFactGraphNode } from './entityFactGraphModel'

/** 详情面板小视口：布局稳定后只居中、不缩小；收敛期间相机逐帧跟随内容。 */
const SETTLE_FIT = { minScale: 1, follow: true }

interface EntityFactGraphCanvasProps {
  data: EntityFactGraphData
  onSelect: (nodeId: string | null) => void
  selectedId: string | null
}

/** 固定点位改记为相对世界中心的偏移：世界随节点数缩放，中心随之移动。 */
const ENTITY_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-130, -78],
  [130, -78],
  [-156, 78],
  [156, 78],
  [0, 106],
]

const FACT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -90],
  [-166, 0],
  [166, 0],
  [0, 42],
]

/** 应用实体状态配色：静态实体保持默认蓝。 */
const APPLIED_STATUS_COLORS: Record<RoomAppliedEntityStatus, number> = {
  room: 0x2fb380,
  ready: 0x408cf0,
  promoting: 0xf0a03c,
  weak: 0x7a9cc9,
  archived: 0x9aa3ad,
  suppressed: 0x9aa3ad,
}

/** 固定点位放不下时的确定性黄金角螺旋兜底，任意数量节点两两错开（围绕世界中心）。 */
function fallbackPosition(centerX: number, centerY: number, index: number, ring: number): [number, number] {
  const angle = index * Math.PI * (3 - Math.sqrt(5))
  const distance = ring * Math.sqrt((index + 1) / 12)
  return [centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance]
}

/** 紧凑小图：近距斥力 + 短连线，常量引用保证布局不因渲染重建。 */
const LAYOUT_OPTIONS: Partial<ForceGraphOptions> = {
  collisionPadding: 8,
  linkDistance: 82,
  manyBodyStrength: -140,
}

export function EntityFactGraphCanvas({ data, onSelect, selectedId }: EntityFactGraphCanvasProps) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((node, index) => [node.id, index])),
    [data.nodes],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => data.nodes.map((node) => ({
    color: node.kind === 'entity'
      ? (node.status ? APPLIED_STATUS_COLORS[node.status] : 0x408cf0)
      : 0x8fb9f3,
    id: node.id,
    label: node.label,
    radius: node.kind === 'entity' ? 12 : 6,
  })), [data.nodes])
  const edges = useMemo<PixiForceGraphEdge[]>(() => data.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    return source === undefined || target === undefined ? [] : [{ source, target }]
  }), [data.edges, nodeIndex])
  // 布局世界随节点数缩放（每节点约 96×96 活动面积）：节点多时不被塞进
  // 固定矩形里互相挤压；面板只是视口，resize 以此为自然下限。
  const layoutDimensions = useMemo(
    () => scaleForceGraphWorld(data.nodes.length, { spacing: 96 }),
    [data.nodes.length],
  )
  const positions = useMemo(() => {
    const centerX = layoutDimensions.width / 2
    const centerY = layoutDimensions.height / 2
    const minDimension = Math.min(layoutDimensions.width, layoutDimensions.height)
    let entityIndex = 0
    let factIndex = 0
    const result = new Float32Array(data.nodes.length * 2)
    data.nodes.forEach((node, index) => {
      let position: readonly [number, number]
      if (node.kind === 'entity') {
        const offset = ENTITY_OFFSETS[entityIndex]
        position = offset
          ? [centerX + offset[0], centerY + offset[1]]
          : fallbackPosition(centerX, centerY, entityIndex, minDimension * 0.4)
        entityIndex += 1
      } else {
        const offset = FACT_OFFSETS[factIndex]
        position = offset
          ? [centerX + offset[0], centerY + offset[1]]
          : fallbackPosition(centerX, centerY, factIndex, minDimension * 0.226)
        factIndex += 1
      }
      result[index * 2] = position[0]
      result[index * 2 + 1] = position[1]
    })
    return result
  }, [data.nodes, layoutDimensions])
  const layoutNodes = useMemo(() => data.nodes.map((node, index) => ({
    id: node.id,
    radius: node.kind === 'entity' ? 12 : 6,
    x: positions[index * 2],
    y: positions[index * 2 + 1],
  })), [data.nodes, positions])
  const layoutEdges = useMemo(
    () => data.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    [data.edges],
  )
  const layoutOptions = useMemo(
    () => ({ ...LAYOUT_OPTIONS, ...layoutDimensions }),
    [layoutDimensions],
  )
  const layout = useForceGraphLayout({
    nodes: layoutNodes,
    edges: layoutEdges,
    options: layoutOptions,
    label: 'Entity/fact force graph',
    canvasRef,
    settleFit: SETTLE_FIT,
  })

  return (
    <div className="context-room-entity-fact-graph-shell nx-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:graphs.entityFactCanvas')}
        centerOnMount
        className="context-room-entity-fact-graph-canvas"
        edges={edges}
        maskUntilStable
        nodes={nodes}
        positions={layout.positions ?? positions}
        revision={layout.revision}
        selectedId={selectedId}
        onResize={layout.resize}
        onUserGesture={layout.cancelAutoFit}
        onDragNode={layout.drag}
        onReleaseNode={layout.release}
        onSelectNode={onSelect}
      />
      <div className="context-room-visually-hidden" aria-label={t('contextRoom:graphs.entityFactNodes')}>
        {data.nodes.map((node: EntityFactGraphNode) => (
          <button
            type="button"
            key={node.id}
            aria-label={t(
              node.kind === 'entity' ? 'contextRoom:graphs.entityNode' : 'contextRoom:graphs.factNode',
              { label: node.label },
            )}
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
