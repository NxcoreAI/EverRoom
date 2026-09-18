import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import { buildFocusSubtree } from './focusTreeModel';
import { GAPS, NODE_SIZES, layoutFocusTree, layoutWalkJourney } from './treeLayout';
import type { WalkHop, WalkStation } from './walkModel';

function node(id: string): import('./focusTreeModel').FocusTreeNode['node'] {
  return { id, nodeType: 'fact', label: id, sourceGraph: 'roomGraph', roomRef: null, updatedAt: null };
}

function edge(id: string, from: string, to: string): EmergenceEdgeDto {
  return { id, from, to, relationType: 'r', edgeLevel: 'original', confidence: null };
}

const asNodes = (ids: string[]): EmergenceNodeDto[] => ids.map(node);

describe('layoutFocusTree', () => {
  it('stacks a single chain into cumulative columns', () => {
    // R → A → B 单链
    const tree = buildFocusSubtree(
      { nodes: asNodes(['R', 'A', 'B']), edges: [edge('x1', 'R', 'A'), edge('x2', 'A', 'B')] },
      'R',
    );
    const { positions, bbox } = layoutFocusTree(tree.nodes);
    expect(positions.get('R')).toEqual({ x: 0, y: 0 });
    expect(positions.get('A')!.x).toBe(NODE_SIZES.center.width + GAPS.treeH);
    expect(positions.get('B')!.x).toBe(NODE_SIZES.center.width + GAPS.treeH + NODE_SIZES.branch.width + GAPS.treeH);
    // 子树高度被自身高度托底：A 居中于 R 的槽
    expect(positions.get('A')!.y).toBeCloseTo((NODE_SIZES.center.height - NODE_SIZES.branch.height) / 2);
    expect(positions.get('B')!.y).toBeCloseTo((NODE_SIZES.center.height - NODE_SIZES.leaf.height) / 2);
    expect(bbox.maxX).toBe(positions.get('B')!.x + NODE_SIZES.leaf.width);
  });

  it('centers the parent on the stacked children span', () => {
    // R 带两个枝干 A、B（各带一片叶子，保证子树高度不同）
    const tree = buildFocusSubtree(
      {
        nodes: asNodes(['R', 'A', 'B', 'A1', 'B1', 'B2']),
        edges: [
          edge('x1', 'R', 'A'), edge('x2', 'R', 'B'),
          edge('x3', 'A', 'A1'),
          edge('x4', 'B', 'B1'), edge('x5', 'B', 'B2'),
        ],
      },
      'R',
    );
    const { positions } = layoutFocusTree(tree.nodes);
    const a = positions.get('A')!;
    const b = positions.get('B')!;
    // A 子树（高30）+ 间距 + B 子树（高70）填满根槽；根垂直居中于整个子跨度
    const totalH = 30 + GAPS.treeV + 70;
    const rootCenterY = positions.get('R')!.y + NODE_SIZES.center.height / 2;
    expect(a.y).toBe(0);
    expect(rootCenterY).toBeCloseTo(totalH / 2);
    // B 的两片叶子填满 B 子树，B 垂直居中于两叶中心的中点
    const b1 = positions.get('B1')!;
    const b2 = positions.get('B2')!;
    expect(b.y + NODE_SIZES.branch.height / 2).toBeCloseTo((b1.y + b2.y + NODE_SIZES.leaf.height) / 2);
    expect(b2.y - b1.y).toBeCloseTo(NODE_SIZES.leaf.height + GAPS.treeV);
  });

  it('places the return capsule left of the root on the same axis', () => {
    const tree = buildFocusSubtree(
      { nodes: asNodes(['R', 'A', 'P']), edges: [edge('x1', 'R', 'A'), edge('x2', 'A', 'P')] },
      'A',
      'R',
    );
    const { positions, bbox } = layoutFocusTree(tree.nodes);
    const root = positions.get('A')!;
    const ret = positions.get('R')!;
    expect(ret.x).toBe(-(GAPS.treeH + NODE_SIZES.return.width));
    expect(ret.y).toBeCloseTo(root.y + (NODE_SIZES.center.height - NODE_SIZES.return.height) / 2);
    expect(bbox.minX).toBe(ret.x);
  });
});

describe('layoutWalkJourney', () => {
  const station = (nodeRef: string): WalkStation => ({ nodeRef, viaRelation: '', viaLevel: null, bridgeRoom: null });
  const hop = (nodeRef: string): WalkHop => ({ nodeRef, edgeId: nodeRef, viaRelation: '', viaLevel: 'original', bridgeRoom: null });

  it('walks previous stations leftward one column each and hops right', () => {
    const log = [station('a'), station('b'), station('c')];
    const hops = [hop('h1'), hop('h2')];
    const { positions, bbox } = layoutWalkJourney(log, hops);
    expect(positions.get('c')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')!.x).toBe(-(GAPS.walkH + NODE_SIZES.walkPrev.width));
    expect(positions.get('a')!.x).toBe(-(GAPS.walkH + NODE_SIZES.walkPrev.width) * 2);
    const hopX = NODE_SIZES.walkCurrent.width + GAPS.walkH;
    expect(positions.get('h1')!.x).toBe(hopX);
    expect(positions.get('h2')!.x).toBe(hopX);
    expect(positions.get('h2')!.y - positions.get('h1')!.y).toBeCloseTo(NODE_SIZES.walkNext.height + GAPS.walkV);
    expect(bbox.minX).toBe(positions.get('a')!.x);
    expect(bbox.maxX).toBe(hopX + NODE_SIZES.walkNext.width);
  });

  it('centers a single hop on the current card axis', () => {
    const log = [station('a'), station('c')];
    const { positions } = layoutWalkJourney(log, [hop('h1')]);
    expect(positions.get('h1')!.y).toBeCloseTo((NODE_SIZES.walkCurrent.height - NODE_SIZES.walkNext.height) / 2);
  });
});
