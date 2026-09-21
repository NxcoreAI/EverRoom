import type { EmergenceEdgeDto, EmergenceNodeDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';

export interface FocusTreeNode {
  id: string;
  depth: number;
  parentId: string | null;
  node: EmergenceNodeDto;
  /** 有子节点（尾节点带当前分岔选项）。 */
  hasChildren: boolean;
}

export interface FocusTree {
  rootId: string;
  nodes: FocusTreeNode[];
  byId: Map<string, FocusTreeNode>;
  childrenOf: Map<string, string[]>;
}

/** 防御上限：写作路线不限层数（用户可一直点下去），只截断异常深图防失控。 */
export const FOCUS_TREE_MAX_DEPTH = 32;

type GraphSlice = Pick<EmergenceProjectionResultDto, 'nodes' | 'edges'>;

/**
 * 以 rootId 为根建全量树（写作路线全展视图的数据底座）。
 * 边按父→子取正向；防环、限深。
 */
export function buildFocusTree(result: GraphSlice, rootId: string): FocusTree {
  const nodeOf = new Map(result.nodes.map((node) => [node.id, node]));
  const root = nodeOf.get(rootId);
  if (!root) return { rootId, nodes: [], byId: new Map(), childrenOf: new Map() };

  const childrenOf = new Map<string, string[]>();
  const inTree = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < FOCUS_TREE_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const kids: string[] = [];
      for (const edge of result.edges as EmergenceEdgeDto[]) {
        if (edge.from !== id || edge.to === id || inTree.has(edge.to)) continue;
        if (!nodeOf.has(edge.to)) continue;
        inTree.add(edge.to);
        kids.push(edge.to);
        next.push(edge.to);
      }
      if (kids.length > 0) childrenOf.set(id, kids);
    }
    frontier = next;
  }

  const nodes: FocusTreeNode[] = [];
  const byId = new Map<string, FocusTreeNode>();
  const walk = (id: string, depth: number, parentId: string | null) => {
    const node = nodeOf.get(id);
    if (!node) return;
    const entry: FocusTreeNode = { id, depth, parentId, node, hasChildren: childrenOf.has(id) };
    nodes.push(entry);
    byId.set(id, entry);
    for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1, id);
  };
  walk(rootId, 0, null);
  return { rootId, nodes, byId, childrenOf };
}

/** 根兜底链：首选 → room 节点 → 第一个节点 → 空。 */
export function resolveCenter(result: GraphSlice | null, preferred: string): string {
  if (!result || result.nodes.length === 0) return '';
  if (result.nodes.some((node) => node.id === preferred)) return preferred;
  const roomNode = result.nodes.find((node) => node.nodeType === 'room');
  return roomNode ? roomNode.id : result.nodes[0].id;
}
