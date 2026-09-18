import type {
  EmergenceEdgeDto,
  EmergenceNodeDto,
  EmergenceProjectionResultDto,
} from '../../../../../../shared/knowledge'

type EmergenceEdgeLevel = EmergenceEdgeDto['edgeLevel']

/** 安全上限（投影结果本已限量，双保险防极端规模冻结画布）。 */
export const VEIN_GRAPH_NODE_LIMIT = 80
export const VEIN_GRAPH_EDGE_LIMIT = 160

/** nodeType → 默认图标词表（target/book/user/flag/message/zap）内的图标名。 */
const NODE_TYPE_ICON: Record<EmergenceNodeDto['nodeType'], string> = {
  room: 'flag',
  entity: 'user',
  fact: 'message',
  document: 'book',
  block: 'message',
  memory: 'zap',
  wikiPage: 'target',
  wikiTopic: 'target',
}

/** nodeType → 基础色（与建联图谱/图谱内核既有用色同族）。 */
const NODE_TYPE_COLOR: Record<EmergenceNodeDto['nodeType'], number> = {
  room: 0x5b8ff9,
  entity: 0x61ddaa,
  fact: 0xf6bf47,
  document: 0x7262fd,
  block: 0xaeb7c4,
  memory: 0xf08bb4,
  wikiPage: 0x9b8bff,
  wikiTopic: 0x9b8bff,
}

/** PRD 8.3 关系分级 → 线的强弱（渲染层无虚线能力，用透明度/宽度表达）。 */
const EDGE_LEVEL_STYLE: Record<EmergenceEdgeLevel, { color: number; alpha: number; width: number }> = {
  original: { color: 0x5b8ff9, alpha: 0.55, width: 1.6 },
  composed: { color: 0x8ca3c0, alpha: 0.38, width: 1.2 },
  semantic: { color: 0xaeb7c4, alpha: 0.22, width: 1 },
}

export interface VeinGraphNode {
  id: string
  nodeType: EmergenceNodeDto['nodeType']
  label: string
  icon: string
  color: number
  radius: number
  labelTier: number
  labelPinned: boolean
  roomRef: EmergenceNodeDto['roomRef']
}

export interface VeinGraphEdge {
  source: string
  target: string
  edgeLevel: EmergenceEdgeLevel
}

export interface VeinGraphData {
  /** 中心节点（当前焦点：doc:{id} 或 room:{id}）。 */
  centerId: string
  nodes: VeinGraphNode[]
  edges: VeinGraphEdge[]
}

/**
 * 涌现投影 → 脉络画布模型（纯读侧投影）：
 * 卡片引用的节点优先保留（卡片⇄脉络联动），其余按服务端顺序截断；
 * 悬边（端点不在图内）直接丢弃。
 */
export function buildVeinGraphData(
  result: Pick<EmergenceProjectionResultDto, 'nodes' | 'edges' | 'cards'>,
  centerNodeRef: string,
): VeinGraphData {
  const cardNodeRefs = new Set(result.cards.map((card) => card.nodeRef).filter((ref): ref is string => Boolean(ref)))
  const kept = result.nodes.slice(0, VEIN_GRAPH_NODE_LIMIT)
  const hasCenter = kept.some((node) => node.id === centerNodeRef)
  if (!hasCenter) {
    // 焦点节点不在投影里（如伴随区文档不在图内）：补一个中心锚点
    const centerType = centerNodeRef.startsWith('doc:') ? 'document' : 'room'
    kept.unshift({
      id: centerNodeRef,
      nodeType: centerType,
      label: centerNodeRef,
      sourceGraph: 'linkGraph',
      roomRef: null,
      updatedAt: null,
    })
  }

  const nodes: VeinGraphNode[] = kept.map((node) => {
    const isCenter = node.id === centerNodeRef
    return {
      id: node.id,
      nodeType: node.nodeType,
      label: node.label,
      icon: NODE_TYPE_ICON[node.nodeType],
      color: NODE_TYPE_COLOR[node.nodeType],
      radius: isCenter ? 26 : cardNodeRefs.has(node.id) ? 19 : 13,
      labelTier: isCenter ? 0 : cardNodeRefs.has(node.id) ? 1 : 2,
      labelPinned: isCenter,
      roomRef: node.roomRef,
    }
  })

  const indexById = new Map(nodes.map((node, index) => [node.id, index]))
  const edges: VeinGraphEdge[] = []
  for (const edge of result.edges) {
    if (edges.length >= VEIN_GRAPH_EDGE_LIMIT) break
    if (!indexById.has(edge.from) || !indexById.has(edge.to)) continue
    if (edge.from === edge.to) continue
    edges.push({ source: edge.from, target: edge.to, edgeLevel: edge.edgeLevel })
  }

  return { centerId: centerNodeRef, nodes, edges }
}

export function veinEdgeStyle(edgeLevel: EmergenceEdgeLevel) {
  return EDGE_LEVEL_STYLE[edgeLevel]
}
