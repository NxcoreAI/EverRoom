import type { EmergenceEdgeDto, EmergenceNodeDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';

export interface FocusTreeNode {
  id: string;
  depth: number;
  parentId: string | null;
  node: EmergenceNodeDto;
  /** 有子节点（点击=展开/收起；叶子点击=选中看详情）。 */
  hasChildren: boolean;
}

export interface FocusTree {
  rootId: string;
  nodes: FocusTreeNode[];
  byId: Map<string, FocusTreeNode>;
  childrenOf: Map<string, string[]>;
}

/** 防御上限：agent 树承诺 ≤3 层，投影异常时截断防失控。 */
export const FOCUS_TREE_MAX_DEPTH = 4;

type GraphSlice = Pick<EmergenceProjectionResultDto, 'nodes' | 'edges'>;

/**
 * 以 rootId 为根建全量树（NotebookLM 式展开/收起的数据底座）。
 * 边按父→子取正向（投影的 relationType=分支）；防环、限深。
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

/**
 * 默认收起集（NotebookLM 首屏）：根展开，其余有子节点的全部收起 ——
 * 首屏只见根和一级分支。
 */
export function defaultCollapsed(tree: FocusTree): Set<string> {
  const collapsed = new Set<string>();
  for (const node of tree.nodes) {
    if (node.hasChildren && node.id !== tree.rootId) collapsed.add(node.id);
  }
  return collapsed;
}

/**
 * 选中即保证邻居可见：叶子上溯把父链展开（父节点跟着亮相），根节点保持
 * 展开（子节点不消失）；被选节点自身的收起态不动（中间节点的展开/收起
 * 交互不变）。无可展开时返回 null。
 */
export function revealAncestors(tree: FocusTree, collapsed: Set<string>, nodeId: string): Set<string> | null {
  const node = tree.byId.get(nodeId);
  if (!node) return null;
  const next = new Set(collapsed);
  let changed = false;
  for (let cur = node.id === tree.rootId ? node.id : node.parentId; cur !== null; cur = tree.byId.get(cur)?.parentId ?? null) {
    if (next.delete(cur)) changed = true;
  }
  return changed ? next : null;
}

/** 根兜底链：首选 → room 节点 → 第一个节点 → 空。 */
export function resolveCenter(result: GraphSlice | null, preferred: string): string {
  if (!result || result.nodes.length === 0) return '';
  if (result.nodes.some((node) => node.id === preferred)) return preferred;
  const roomNode = result.nodes.find((node) => node.nodeType === 'room');
  return roomNode ? roomNode.id : result.nodes[0].id;
}
