import type {
  EmergenceCardDto,
  EmergenceEdgeDto,
  EmergenceNodeDto,
  RouteGraphDto,
  RouteNodeDto,
} from '../../../../../../../shared/knowledge';

/**
 * 写作路线展示投影（纯函数）：
 * 全图 + 已选路径 → 只保留「路径链 + 尾节点下整个已生成子树」的显示树
 * （回退后所有已展开的子级及其更深的已生成层都露出，可断点续选）；
 * 中间路径节点的其余子级不下发（未选分支不显示），全图留在服务端
 * route_mindmaps.graph，点路径上级回退后由 selectionPath 重新驱动露出。
 */

/** 全图深度上限（含根，根下最多三层选项；与网关 ROUTE_MAX_DEPTH 双份维护）。 */
export const ROUTE_MAX_DEPTH = 4;

export interface RoutePathNode {
  ref: string;
  label: string;
  note: string | null;
  depth: number;
  /** 路径上该节点的子级=当前分岔选项（含已选项，由 children 链继续表达）。 */
  children: RouteNodeDto[];
}

function findNode(root: RouteNodeDto, ref: string): RouteNodeDto | null {
  if (root.ref === ref) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, ref);
    if (hit) return hit;
  }
  return null;
}

/** 全图里根→目标节点的链（含目标自身）；不在图中返回 null。已拍板后的只读浏览用它换层。 */
export function routePathTo(root: RouteNodeDto, ref: string): RouteNodeDto[] | null {
  if (root.ref === ref) return [root];
  for (const child of root.children ?? []) {
    const sub = routePathTo(child, ref);
    if (sub) return [root, ...sub];
  }
  return null;
}

/**
 * 全图沿 selectionPath 压成线性链；尾节点（当前所在层）带其全部子级。
 * selectionPath 缺失或不在图中时回退为「根 + 第一层选项」。
 */
export function routePathProjection(
  graph: RouteGraphDto | null,
  selectionPath: string[] | null,
): { path: RoutePathNode[] } | null {
  if (!graph) return null;
  const refs = selectionPath && selectionPath.length > 0 && findNode(graph.root, selectionPath[0])
    ? selectionPath
    : [graph.root.ref];
  const path: RoutePathNode[] = [];
  let cursor: RouteNodeDto | null = graph.root;
  for (let depth = 0; depth < refs.length && cursor; depth += 1) {
    if (cursor.ref !== refs[depth]) break;
    path.push({
      ref: cursor.ref,
      label: cursor.label,
      note: cursor.note,
      depth,
      children: cursor.children ?? [],
    });
    const next = refs[depth + 1];
    cursor = next ? (cursor.children ?? []).find((child) => child.ref === next) ?? null : null;
  }
  if (path.length === 0) {
    path.push({
      ref: graph.root.ref,
      label: graph.root.label,
      note: graph.root.note,
      depth: 0,
      children: graph.root.children ?? [],
    });
  }
  return { path };
}

/** 尾节点（用户当前所在层）；无图返回 null。 */
export function routeTailNode(projection: { path: RoutePathNode[] } | null): RoutePathNode | null {
  return projection?.path[projection.path.length - 1] ?? null;
}

/** 投影内任意节点的深度（根=0）；不在投影中返回 null。 */
export function routeNodeDepth(projection: { path: RoutePathNode[] } | null, ref: string): number | null {
  if (!projection) return null;
  const inPath = projection.path.find((node) => node.ref === ref);
  if (inPath) return inPath.depth;
  const tail = projection.path[projection.path.length - 1];
  const walk = (node: RouteNodeDto, depth: number): number | null => {
    for (const child of node.children ?? []) {
      if (child.ref === ref) return depth + 1;
      const hit = walk(child, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(tail, tail.depth);
}

/**
 * 路径投影 → FocusTreeCanvas 可吃的合成图谱：路径链逐级相连 +
 * 尾节点下整个已生成子树逐级下发（回退后已展开的子级及其子级全部可见）。
 * 中间路径节点的其余子级不下发（未选分支不显示）。
 */
export function routeProjectionToGraph(projection: { path: RoutePathNode[] } | null): {
  nodes: EmergenceNodeDto[];
  edges: EmergenceEdgeDto[];
} | null {
  if (!projection || projection.path.length === 0) return null;
  const nodes = new Map<string, EmergenceNodeDto>();
  const edges: EmergenceEdgeDto[] = [];
  const push = (node: RouteNodeDto) => {
    if (!nodes.has(node.ref)) {
      nodes.set(node.ref, {
        id: node.ref,
        nodeType: 'document',
        label: node.label,
        sourceGraph: 'roomGraph',
        roomRef: null,
        updatedAt: null,
      });
    }
  };
  const link = (from: string, to: string) => {
    edges.push({ id: `${from}->${to}`, from, to, relationType: 'route', edgeLevel: 'composed', confidence: null });
  };
  const path = projection.path;
  for (let index = 0; index < path.length; index += 1) {
    push(path[index]);
    if (index > 0) link(path[index - 1].ref, path[index].ref);
  }
  const seen = new Set(path.map((node) => node.ref));
  const walkFork = (parent: RouteNodeDto) => {
    for (const child of parent.children ?? []) {
      if (seen.has(child.ref)) continue;
      seen.add(child.ref);
      push(child);
      link(parent.ref, child.ref);
      walkFork(child);
    }
  };
  walkFork(path[path.length - 1]);
  return { nodes: [...nodes.values()], edges };
}

/** 带 note 的显示节点 → 详情条卡片（底部小字显示路线理由）。 */
export function routeProjectionCards(projection: { path: RoutePathNode[] } | null): EmergenceCardDto[] {
  if (!projection) return [];
  const cards: EmergenceCardDto[] = [];
  const push = (node: RouteNodeDto) => {
    if (!node.note) return;
    cards.push({
      id: `route:${node.ref}`,
      kind: 'viewpoint',
      title: node.label,
      summary: node.note,
      sourceType: 'route',
      occurredAt: null,
      roomRef: null,
      reason: '',
      quote: null,
      path: null,
      confidence: 1,
      nodeRef: node.ref,
    });
  };
  for (const node of projection.path) push(node);
  const seen = new Set(projection.path.map((node) => node.ref));
  const walkFork = (parent: RouteNodeDto) => {
    for (const child of parent.children ?? []) {
      if (seen.has(child.ref)) continue;
      seen.add(child.ref);
      push(child);
      walkFork(child);
    }
  };
  walkFork(projection.path[projection.path.length - 1]);
  return cards;
}
