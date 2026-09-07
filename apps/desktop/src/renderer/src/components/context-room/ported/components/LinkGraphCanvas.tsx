import { useMemo, useRef } from 'react'

import {
  PixiForceGraphCanvas,
  scaleForceGraphWorld,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
  type ForceGraphOptions,
  type PixiForceGraphEdge,
  useForceGraphLayout,
  type ForceGraphNode,
  type ForceGraphEdge,
} from '@/components/graph'
import { useLocale } from '../../../../i18n/LocaleContext'
import {
  LINK_GRAPH_ROOT_ID,
  linkGraphBlockNodeId,
  linkGraphBlocksByDocument,
  linkGraphDocumentNodeId,
  linkGraphMemoryNodeId,
  type LinkGraphData,
  type LinkGraphNode,
} from './linkGraphModel'

/** 详情面板小视口：布局稳定后只居中、不缩小；收敛期间相机逐帧跟随内容。 */
const SETTLE_FIT = { minScale: 1, follow: true }

const DOC_COLOR = 0x408cf0
const MEMORY_COLOR = 0xa78bfa
const BLOCK_COLOR = 0x8fb9f3
const STALE_COLOR = 0x9aa3ad
/** 文档轨道场：淡蓝半透明。 */
const FIELD_COLOR = 0x6fa8f5
const FIELD_ALPHA = 0.12

/** 轨道场半径随场内块数扩张，封顶防挤压。 */
const FIELD_BASE_RADIUS = 46
const FIELD_PER_BLOCK = 6
const FIELD_MAX_RADIUS = 110
/** 力导向：记忆被 root 连边约束在场心附近；文档互斥（物理半径=场径）防止场重叠。 */
const LAYOUT_OPTIONS: Partial<ForceGraphOptions> = {
  linkDistance: 150,
  linkStrength: 0.3,
  manyBodyStrength: -260,
  collisionPadding: 14,
}

function nodeColor(node: LinkGraphNode): number {
  if (node.stale) return STALE_COLOR
  if (node.kind === 'memory') return MEMORY_COLOR
  if (node.kind === 'block') return BLOCK_COLOR
  return DOC_COLOR
}

function nodeRadius(node: LinkGraphNode): number {
  if (node.kind === 'root') return 14
  if (node.kind === 'document') return 12
  if (node.kind === 'memory') return 7
  return 5
}

export function edgeSourceNodeId(edge: LinkGraphData['edges'][number]): string {
  return edge.sourceBlockId
    ? linkGraphBlockNodeId(edge.sourceDocumentId, edge.sourceBlockId)
    : linkGraphDocumentNodeId(edge.sourceDocumentId)
}

export function edgeTargetNodeId(edge: LinkGraphData['edges'][number]): string {
  if (edge.kind === 'memory') return linkGraphMemoryNodeId(edge.targetMemoryId)
  return edge.targetBlockId
    ? linkGraphBlockNodeId(edge.targetDocumentId, edge.targetBlockId)
    : linkGraphDocumentNodeId(edge.targetDocumentId)
}

/** 确定性伪随机（块 id 派生）：近无规则散落的偏移角与半径因子。 */
function stableHash(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

/** 确定性伪随机（mulberry32）：泊松盘采样的可复现随机流。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 圆环域蓝噪声散布（Mitchell 最佳候选）：每个新点从多个随机候选里挑
 * "离已有点最远"的那个。不依赖种子点生长扩散，点数少时也会全局铺开，
 * 不会挤在同一侧留出空洞（Bridson 泊松盘在小点数下有此缺陷）。
 */
function blueNoiseAnnulus(
  count: number,
  innerRadius: number,
  outerRadius: number,
  rand: () => number,
): Array<{ dx: number; dy: number }> {
  const randomPoint = () => {
    const angle = rand() * Math.PI * 2
    // 面积均匀：r² 在 [inner², outer²] 上线性插值（均匀 r 会向圆心聚集）。
    const r = Math.sqrt(innerRadius * innerRadius
      + rand() * (outerRadius * outerRadius - innerRadius * innerRadius))
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r }
  }
  const points: Array<{ x: number; y: number }> = []
  if (count > 0) points.push(randomPoint())
  const candidateCount = Math.max(12, Math.min(40, count * 3))
  while (points.length < count) {
    let best = randomPoint()
    let bestNearest = -Infinity
    for (let attempt = 0; attempt < candidateCount; attempt += 1) {
      const candidate = randomPoint()
      let nearest = Infinity
      for (const point of points) {
        const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
        if (distance < nearest) nearest = distance
      }
      if (nearest > bestNearest) {
        bestNearest = nearest
        best = candidate
      }
    }
    points.push(best)
  }
  return points.map((p) => ({ dx: p.x, dy: p.y }))
}

/** 每篇文档的块偏移表：蓝噪声散布，点按块 id 稳定哈希序分配（可复现）。 */
function poissonOffsetsByDocument(
  blocksByDoc: Map<string, string[]>,
  fieldRadiusByDoc: Map<string, number>,
): Map<string, Map<string, { dx: number; dy: number }>> {
  const result = new Map<string, Map<string, { dx: number; dy: number }>>()
  for (const [docId, blocks] of blocksByDoc) {
    const fieldRadius = fieldRadiusByDoc.get(docId) ?? FIELD_BASE_RADIUS
    const outer = Math.max(20, fieldRadius - 10)
    const inner = 16
    const points = blueNoiseAnnulus(blocks.length, inner, outer, mulberry32(stableHash(docId)))
    const ordered = [...blocks].sort((left, right) =>
      stableHash(`${docId}:${left}`) - stableHash(`${docId}:${right}`) || left.localeCompare(right))
    const per = new Map<string, { dx: number; dy: number }>()
    ordered.forEach((blockId, index) => per.set(blockId, points[index] ?? { dx: inner, dy: 0 }))
    result.set(docId, per)
  }
  return result
}

export function LinkGraphCanvas({
  data,
  onSelect,
  selectedId,
}: {
  data: LinkGraphData
  onSelect: (nodeId: string | null) => void
  selectedId: string | null
}) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((node, index) => [node.id, index])),
    [data.nodes],
  )
  const blocksByDoc = useMemo(() => linkGraphBlocksByDocument(data), [data])
  const fieldRadiusByDoc = useMemo(() => {
    const radii = new Map<string, number>()
    for (const node of data.nodes) {
      if (node.kind !== 'document' || !node.documentId) continue
      radii.set(node.documentId, Math.min(
        FIELD_MAX_RADIUS,
        FIELD_BASE_RADIUS + FIELD_PER_BLOCK * (blocksByDoc.get(node.documentId)?.length ?? 0),
      ))
    }
    return radii
  }, [data.nodes, blocksByDoc])
  const offsetsByDoc = useMemo(
    () => poissonOffsetsByDocument(blocksByDoc, fieldRadiusByDoc),
    [blocksByDoc, fieldRadiusByDoc],
  )

  // 全节点表：文档节点带淡蓝半透明轨道场；块节点为锚点（不进模拟，位置=文档+散落偏移）。
  // 标签层级：根=0（最醒目）、文档主节点=1、块/记忆=2（缺省）；根与文档标签常显。
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => data.nodes.map((node) => {
    if (node.kind === 'root') {
      return { color: nodeColor(node), id: node.id, label: node.label, radius: nodeRadius(node), labelPinned: true, labelTier: 0 }
    }
    if (node.kind === 'document' && node.documentId) {
      const fieldRadius = fieldRadiusByDoc.get(node.documentId) ?? FIELD_BASE_RADIUS
      return {
        color: nodeColor(node),
        id: node.id,
        label: node.label,
        radius: nodeRadius(node),
        labelPinned: true,
        labelTier: 1,
        field: { radius: fieldRadius, color: node.stale ? STALE_COLOR : FIELD_COLOR, alpha: FIELD_ALPHA },
      }
    }
    if (node.kind === 'block' && node.parentDocumentId && node.blockId) {
      const parentNodeId = linkGraphDocumentNodeId(node.parentDocumentId)
      const fieldRadius = fieldRadiusByDoc.get(node.parentDocumentId) ?? FIELD_BASE_RADIUS
      const offset = offsetsByDoc.get(node.parentDocumentId)?.get(node.blockId) ?? { dx: 16, dy: 0 }
      return {
        color: nodeColor(node),
        id: node.id,
        label: node.label,
        radius: nodeRadius(node),
        anchor: { parentId: parentNodeId, dx: offset.dx, dy: offset.dy, maxDistance: Math.max(8, fieldRadius - 10) },
      }
    }
    return { color: nodeColor(node), id: node.id, label: node.label, radius: nodeRadius(node) }
  }), [data.nodes, fieldRadiusByDoc, offsetsByDoc])

  // 可见边：块→目标块 / 块→记忆（记忆边紫色、文档边蓝色）；
  // 记忆/文档 ⇄ Room 根画淡色细线（归属约束的可见形态，弱于建联边）。
  const edges = useMemo<PixiForceGraphEdge[]>(() => {
    const citationEdges = data.edges.flatMap((edge) => {
      const source = nodeIndex.get(edgeSourceNodeId(edge))
      const target = nodeIndex.get(edgeTargetNodeId(edge))
      return source === undefined || target === undefined
        ? []
        : [{
          source,
          target,
          color: edge.kind === 'memory' ? MEMORY_COLOR : 0x5b8ff9,
          alpha: 0.45,
          width: 1.1,
        }]
    })
    const rootIndex = nodeIndex.get(LINK_GRAPH_ROOT_ID)
    const membershipEdges = rootIndex === undefined ? [] : data.nodes.flatMap((node) => {
      if (node.kind !== 'memory' && node.kind !== 'document') return []
      const target = nodeIndex.get(node.id)
      return target === undefined ? [] : [{
        source: rootIndex,
        target,
        color: node.kind === 'memory' ? MEMORY_COLOR : FIELD_COLOR,
        alpha: 0.18,
        width: 0.8,
      }]
    })
    return [...citationEdges, ...membershipEdges]
  }, [data.edges, data.nodes, nodeIndex])

  // 力导向只跑中心节点（root/文档/记忆）：文档物理半径=场径（互斥防场重叠），
  // 记忆用 root 连边约束在 Room 中心附近；引用关系连文档对让相关文档靠拢。
  const simNodes = useMemo<ForceGraphNode[]>(() => {
    const result: ForceGraphNode[] = []
    let docOrder = 0
    let memoryOrder = 0
    for (const node of data.nodes) {
      if (node.kind === 'document' && node.documentId) {
        const fieldRadius = fieldRadiusByDoc.get(node.documentId) ?? FIELD_BASE_RADIUS
        const angle = docOrder * Math.PI * (3 - Math.sqrt(5))
        const distance = 180 + 14 * Math.sqrt(docOrder + 1)
        result.push({
          id: node.id,
          radius: fieldRadius + 10,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
        })
        docOrder += 1
      } else if (node.kind === 'memory') {
        const angle = memoryOrder * Math.PI * (3 - Math.sqrt(5))
        result.push({ id: node.id, radius: 8, x: Math.cos(angle) * 120, y: Math.sin(angle) * 120 })
        memoryOrder += 1
      } else if (node.kind === 'root') {
        result.push({ id: node.id, radius: 16, x: 0, y: 0 })
      }
    }
    return result
  }, [data.nodes, fieldRadiusByDoc])

  const simNodeIds = useMemo(() => new Set(simNodes.map((node) => node.id)), [simNodes])
  const simEdges = useMemo<ForceGraphEdge[]>(() => {
    const seen = new Set<string>()
    const result: ForceGraphEdge[] = []
    // 记忆/文档 ⇄ root：归属约束——记忆聚在 Room 中心附近，文档环在外圈。
    for (const node of data.nodes) {
      if (node.kind !== 'memory' && node.kind !== 'document') continue
      if (!simNodeIds.has(node.id) || !simNodeIds.has(LINK_GRAPH_ROOT_ID)) continue
      const key = `${LINK_GRAPH_ROOT_ID}|${node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ source: LINK_GRAPH_ROOT_ID, target: node.id })
    }
    // 文档 ⇄ 文档（引用去重）：相关文档靠拢成簇。
    for (const edge of data.edges) {
      if (edge.kind !== 'document' || !edge.targetDocumentId) continue
      if (edge.sourceDocumentId === edge.targetDocumentId) continue
      const sourceId = linkGraphDocumentNodeId(edge.sourceDocumentId)
      const targetId = linkGraphDocumentNodeId(edge.targetDocumentId)
      if (!simNodeIds.has(sourceId) || !simNodeIds.has(targetId)) continue
      const key = [sourceId, targetId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ source: sourceId, target: targetId })
    }
    return result
  }, [data.edges, data.nodes, simNodeIds])

  // 世界尺寸随中心节点数扩张（场占 200×200 活动面积）。
  const layoutDimensions = useMemo(
    () => scaleForceGraphWorld(simNodes.length, { spacing: 200 }),
    [simNodes.length],
  )
  const layoutOptions = useMemo(
    () => ({ ...LAYOUT_OPTIONS, ...layoutDimensions }),
    [layoutDimensions],
  )
  // Worker 不可用时的静态兜底（非锚点次序；锚点由渲染层按 父+偏移 解析）。
  const fallbackPositions = useMemo(() => {
    const positions = new Float32Array(simNodes.length * 2)
    simNodes.forEach((node, index) => {
      positions[index * 2] = node.x ?? 0
      positions[index * 2 + 1] = node.y ?? 0
    })
    return positions
  }, [simNodes])

  const layout = useForceGraphLayout({
    nodes: simNodes,
    edges: simEdges,
    options: layoutOptions,
    label: 'Room link force graph',
    canvasRef,
    settleFit: SETTLE_FIT,
  })

  return (
    <div className="context-room-entity-fact-graph-shell nx-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:graphs.linkGraphCanvas')}
        centerOnMount
        className="context-room-entity-fact-graph-canvas"
        edges={edges}
        maskUntilStable
        nodes={nodes}
        positions={layout.positions ?? fallbackPositions}
        revision={layout.revision}
        selectedId={selectedId}
        onResize={layout.resize}
        onUserGesture={layout.cancelAutoFit}
        onDragNode={layout.drag}
        onReleaseNode={layout.release}
        onSelectNode={onSelect}
      />
      <div className="context-room-visually-hidden" aria-label={t('contextRoom:graphs.linkGraphNodes')}>
        {data.nodes.map((node: LinkGraphNode) => (
          <button
            type="button"
            key={node.id}
            aria-label={t(
              node.kind === 'memory'
                ? 'contextRoom:graphs.linkMemoryNode'
                : node.kind === 'block'
                  ? 'contextRoom:graphs.linkBlockNode'
                  : 'contextRoom:graphs.linkDocumentNode',
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
