import { useMemo, useRef } from 'react'

import {
  PixiForceGraphCanvas,
  scaleForceGraphWorld,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
  type PixiForceGraphEdge,
  useForceGraphLayout,
} from '@/components/graph'
import { useLocale } from '../../../../i18n/LocaleContext'

import { buildVeinGraphData, veinEdgeStyle, type VeinGraphData } from './veinGraphModel'
import type { EmergenceProjectionResultDto } from '../../../../../../shared/knowledge'

const SETTLE_FIT = { minScale: 1, follow: true }

/** 从中心生长：全部节点初始挤在世界中心的小半径上，力导向散开 + 相机收敛跟随。 */
function initialPositions(count: number, width: number, height: number) {
  const positions = new Float32Array(count * 2)
  const centerX = width / 2
  const centerY = height / 2
  for (let index = 0; index < count; index += 1) {
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    const distance = 18 * Math.sqrt(index)
    positions[index * 2] = centerX + Math.cos(angle) * distance
    positions[index * 2 + 1] = centerY + Math.sin(angle) * distance
  }
  return positions
}

/**
 * 知识脉络画布：与卡片流同源（同一个投影结果），点节点=打开对应卡片，
 * 卡片展开=高亮节点（selectedId 联动）。
 */
export function VeinGraphCanvas({ result, centerNodeRef, selectedNodeRef, onSelectNode }: {
  result: Pick<EmergenceProjectionResultDto, 'nodes' | 'edges' | 'cards'>
  centerNodeRef: string
  selectedNodeRef: string | null
  onSelectNode: (nodeRef: string) => void
}) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const data: VeinGraphData = useMemo(
    () => buildVeinGraphData(result, centerNodeRef),
    [result, centerNodeRef],
  )
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((node, index) => [node.id, index])),
    [data.nodes],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(
    () => data.nodes.map((node) => ({
      color: node.color,
      icon: node.icon,
      id: node.id,
      label: node.label,
      labelPinned: node.labelPinned,
      labelTier: node.labelTier,
      radius: node.radius,
    })),
    [data.nodes],
  )
  const edges = useMemo<PixiForceGraphEdge[]>(() => data.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    if (source === undefined || target === undefined) return []
    const style = veinEdgeStyle(edge.edgeLevel)
    return [{ source, target, color: style.color, alpha: style.alpha, width: style.width }]
  }), [data.edges, nodeIndex])
  const layoutDimensions = useMemo(
    () => scaleForceGraphWorld(data.nodes.length, { spacing: 110 }),
    [data.nodes.length],
  )
  const fallbackPositions = useMemo(
    () => initialPositions(nodes.length, layoutDimensions.width, layoutDimensions.height),
    [layoutDimensions, nodes.length],
  )
  // useForceGraphLayout 以数组身份为重建依赖，必须 memo，内联 .map() 会死循环。
  const layoutNodes = useMemo(
    () => data.nodes.map((node) => ({ id: node.id, radius: node.radius })),
    [data.nodes],
  )
  const layoutEdges = useMemo(
    () => data.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    [data.edges],
  )
  const layout = useForceGraphLayout({
    nodes: layoutNodes,
    edges: layoutEdges,
    options: layoutDimensions,
    label: 'Emergence vein graph',
    canvasRef,
    settleFit: SETTLE_FIT,
  })

  return (
    <div className="context-room-graph-shell context-room-vein-graph nx-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:emergence.veinCanvas')}
        centerOnMount
        className="context-room-graph-canvas"
        edges={edges}
        maskUntilStable
        nodes={nodes}
        positions={layout.positions ?? fallbackPositions}
        revision={layout.revision}
        selectedId={selectedNodeRef}
        onResize={layout.resize}
        onUserGesture={layout.cancelAutoFit}
        onDragNode={layout.drag}
        onReleaseNode={layout.release}
        onSelectNode={(nodeId) => {
          if (nodeId) onSelectNode(nodeId)
        }}
      />
      <div className="context-room-visually-hidden" aria-label={t('contextRoom:emergence.veinNodes')}>
        {data.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-label={node.label}
            aria-pressed={node.id === selectedNodeRef}
            onClick={() => onSelectNode(node.id)}
          >
            {node.label}
          </button>
        ))}
      </div>
    </div>
  )
}
