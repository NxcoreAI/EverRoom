import type { FocusTreeNode } from './focusTreeModel';
import type { WalkHop, WalkStation } from './walkModel';

export interface Box { width: number; height: number; }
export interface Point { x: number; y: number; }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

// 尺寸常量是布局唯一数据源：CSS 只管配色/字体/边框，不参与定位
// （emergence-graph 样式块与这里互相引用，改尺寸两处同步）。
export const NODE_SIZES = {
  center: { width: 168, height: 36 },
  branch: { width: 148, height: 30 },
  leaf: { width: 128, height: 28 },
  return: { width: 148, height: 30 },
  walkCurrent: { width: 178, height: 96 },
  walkPrev: { width: 152, height: 84 },
  walkNext: { width: 152, height: 84 },
} as const;

export const GAPS = {
  treeH: 48,
  treeV: 14,
  walkH: 56,
  walkV: 16,
} as const;

export type TreeRole = 'center' | 'branch' | 'leaf' | 'return';

export function treeRoleOf(node: FocusTreeNode): TreeRole {
  if (node.isReturn) return 'return';
  if (node.depth === 0) return 'center';
  return node.depth === 1 ? 'branch' : 'leaf';
}

export const TREE_ROLE_SIZE: Record<TreeRole, Box> = {
  center: NODE_SIZES.center,
  branch: NODE_SIZES.branch,
  leaf: NODE_SIZES.leaf,
  return: NODE_SIZES.return,
};

export function treeRoleSize(node: FocusTreeNode): Box {
  return TREE_ROLE_SIZE[treeRoleOf(node)];
}

export interface TreeLayout {
  positions: Map<string, Point>;
  bbox: BBox;
}

function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function accumulate(bbox: BBox, point: Point, size: Box): void {
  bbox.minX = Math.min(bbox.minX, point.x);
  bbox.minY = Math.min(bbox.minY, point.y);
  bbox.maxX = Math.max(bbox.maxX, point.x + size.width);
  bbox.maxY = Math.max(bbox.maxY, point.y + size.height);
}

/**
 * 聚焦树紧凑横向布局：深度定列 x（列宽=该列角色宽），子树高度后序累加、
 * 自顶向下分配 y 槽（父节点垂直居中于子跨度）。回程框放根左侧、与根同轴。
 * 坐标为元素左上角（内容坐标系，可为负）。
 */
export function layoutFocusTree(nodes: FocusTreeNode[]): TreeLayout {
  const positions = new Map<string, Point>();
  const bbox = emptyBBox();
  if (nodes.length === 0) return { positions, bbox };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = nodes.find((node) => node.depth === 0);
  if (!root) return { positions, bbox };

  const childrenOf = new Map<string, FocusTreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId || node.isReturn) continue;
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  const columnX = (depth: number): number => {
    let x = 0;
    for (let d = 0; d < depth; d += 1) x += TREE_ROLE_SIZE[d === 0 ? 'center' : d === 1 ? 'branch' : 'leaf'].width + GAPS.treeH;
    return x;
  };

  // 后序：子树高度 = max(自身, Σ子树 + 间距)
  const subtreeHeight = new Map<string, number>();
  const measure = (node: FocusTreeNode): number => {
    const children = childrenOf.get(node.id) ?? [];
    const childrenTotal = children.reduce((sum, child) => sum + measure(child), 0) + GAPS.treeV * Math.max(0, children.length - 1);
    const height = Math.max(TREE_ROLE_SIZE[treeRoleOf(node)].height, childrenTotal);
    subtreeHeight.set(node.id, height);
    return height;
  };
  measure(root);

  // 自顶向下：节点在自身槽内居中，子节点组在剩余空间内居中
  const place = (node: FocusTreeNode, top: number): void => {
    const size = TREE_ROLE_SIZE[treeRoleOf(node)];
    const x = node.isReturn ? -GAPS.treeH - NODE_SIZES.return.width : columnX(node.depth);
    const y = top + (subtreeHeight.get(node.id)! - size.height) / 2;
    positions.set(node.id, { x, y });

    const children = childrenOf.get(node.id) ?? [];
    const childrenTotal = children.reduce((sum, child) => sum + subtreeHeight.get(child.id)!, 0) + GAPS.treeV * Math.max(0, children.length - 1);
    let cursor = top + (subtreeHeight.get(node.id)! - childrenTotal) / 2;
    for (const child of children) {
      place(child, cursor);
      cursor += subtreeHeight.get(child.id)! + GAPS.treeV;
    }
  };
  place(root, 0);

  const returnNode = nodes.find((node) => node.isReturn);
  if (returnNode) {
    const rootPos = positions.get(root.id)!;
    const rootSize = NODE_SIZES.center;
    positions.set(returnNode.id, {
      x: -GAPS.treeH - NODE_SIZES.return.width,
      y: rootPos.y + (rootSize.height - NODE_SIZES.return.height) / 2,
    });
  }

  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos) accumulate(bbox, pos, TREE_ROLE_SIZE[treeRoleOf(node)]);
  }
  return { positions, bbox };
}

/**
 * 漫步步进链：当前驻足在原点；走过的站向左一列列排（与当前同轴）；
 * 下一跳候选在右侧一列，垂直居中于当前卡轴线。
 */
export function layoutWalkJourney(log: WalkStation[], hops: WalkHop[]): TreeLayout {
  const positions = new Map<string, Point>();
  const bbox = emptyBBox();
  if (log.length === 0) return { positions, bbox };

  const currentSize = NODE_SIZES.walkCurrent;
  positions.set(currentStationRef(log), { x: 0, y: 0 });
  accumulate(bbox, { x: 0, y: 0 }, currentSize);

  const walkedY = (currentSize.height - NODE_SIZES.walkPrev.height) / 2;
  for (let i = log.length - 2; i >= 0; i -= 1) {
    const columnsAway = log.length - 1 - i;
    const x = -(GAPS.walkH + NODE_SIZES.walkPrev.width) * columnsAway;
    positions.set(log[i].nodeRef, { x, y: walkedY });
    accumulate(bbox, { x, y: walkedY }, NODE_SIZES.walkPrev);
  }

  if (hops.length > 0) {
    const hopsTotal = NODE_SIZES.walkNext.height * hops.length + GAPS.walkV * (hops.length - 1);
    let y = currentSize.height / 2 - hopsTotal / 2;
    const hopX = currentSize.width + GAPS.walkH;
    for (const hop of hops) {
      positions.set(hop.nodeRef, { x: hopX, y });
      accumulate(bbox, { x: hopX, y }, NODE_SIZES.walkNext);
      y += NODE_SIZES.walkNext.height + GAPS.walkV;
    }
  }

  return { positions, bbox };
}

function currentStationRef(log: WalkStation[]): string {
  return log[log.length - 1].nodeRef;
}
