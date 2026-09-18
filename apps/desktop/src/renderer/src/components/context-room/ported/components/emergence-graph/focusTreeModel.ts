import type { EmergenceEdgeDto, EmergenceNodeDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';

export interface FocusTreeNode {
  id: string;
  depth: number;
  parentId: string | null;
  via: EmergenceEdgeDto | null;
  node: EmergenceNodeDto;
  /** 窗口外仍有邻居（点它=换中心重挖）。 */
  expandable: boolean;
  /** 回程框：钻取前所在的上一层节点，放根左侧，点击=后退。 */
  isReturn: boolean;
}

export interface FocusSubtree {
  center: string;
  nodes: FocusTreeNode[];
}

export const FOCUS_TREE_MAX_DEPTH = 2;

type GraphSlice = Pick<EmergenceProjectionResultDto, 'nodes' | 'edges'>;

function neighborsOf(edges: EmergenceEdgeDto[], id: string): Array<{ other: string; edge: EmergenceEdgeDto }> {
  const found: Array<{ other: string; edge: EmergenceEdgeDto }> = [];
  for (const edge of edges) {
    if (edge.from === id && edge.to !== id) found.push({ other: edge.to, edge });
    else if (edge.to === id && edge.from !== id) found.push({ other: edge.from, edge });
  }
  return found;
}

/**
 * 以 centerId 为根的两层邻域树（沿 edges 无向 BFS）。
 * returnToId 是钻取前的中心：不作为子节点重挖，而是作为回程框挂回根上。
 */
export function buildFocusSubtree(
  result: GraphSlice,
  centerId: string,
  returnToId: string | null = null,
  maxDepth: number = FOCUS_TREE_MAX_DEPTH,
): FocusSubtree {
  const nodeOf = new Map(result.nodes.map((node) => [node.id, node]));
  const center = nodeOf.get(centerId);
  if (!center) return { center: centerId, nodes: [] };

  const nodes: FocusTreeNode[] = [];
  const seen = new Set<string>([centerId]);
  let frontier: Array<{ id: string; depth: number; parentId: string | null; via: EmergenceEdgeDto | null }> = [
    { id: centerId, depth: 0, parentId: null, via: null },
  ];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      const node = nodeOf.get(item.id);
      if (!node) continue;
      nodes.push({ id: item.id, depth: item.depth, parentId: item.parentId, via: item.via, node, expandable: false, isReturn: false });
      if (item.depth >= maxDepth) continue;
      for (const { other, edge } of neighborsOf(result.edges, item.id)) {
        if (seen.has(other) || other === returnToId) continue;
        const otherNode = nodeOf.get(other);
        if (!otherNode) continue;
        seen.add(other);
        next.push({ id: other, depth: item.depth + 1, parentId: item.id, via: edge });
      }
    }
    frontier = next;
  }

  if (returnToId) {
    const returnNode = nodeOf.get(returnToId);
    if (returnNode) {
      const via = result.edges.find(
        (edge) => (edge.from === centerId && edge.to === returnToId) || (edge.from === returnToId && edge.to === centerId),
      ) ?? null;
      nodes.push({ id: returnToId, depth: 1, parentId: centerId, via, node: returnNode, expandable: false, isReturn: true });
      seen.add(returnToId);
    }
  }

  // 兜底：结果里带着、但一条边都没有的孤立节点（投影按评分选出、中间无真实边）挂到中心一层，不凭空消失。
  // 只收零度节点：有边但不通向中心的子图属于窗外内容，正常被窗口裁掉。
  const connected = new Set<string>();
  for (const edge of result.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of result.nodes) {
    if (seen.has(node.id) || connected.has(node.id)) continue;
    nodes.push({ id: node.id, depth: 1, parentId: centerId, via: null, node, expandable: false, isReturn: false });
    seen.add(node.id);
  }

  for (const item of nodes) {
    if (item.isReturn) continue;
    item.expandable = neighborsOf(result.edges, item.id).some(({ other }) => !seen.has(other) && nodeOf.has(other));
  }

  return { center: centerId, nodes };
}

/** 中心兜底链：首选 → room 节点 → 第一个节点 → 空。 */
export function resolveCenter(result: GraphSlice | null, preferred: string): string {
  if (!result || result.nodes.length === 0) return '';
  if (result.nodes.some((node) => node.id === preferred)) return preferred;
  const roomNode = result.nodes.find((node) => node.nodeType === 'room');
  return roomNode ? roomNode.id : result.nodes[0].id;
}
