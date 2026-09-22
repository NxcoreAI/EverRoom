import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import { FOCUS_TREE_MAX_DEPTH, buildFocusTree, resolveCenter } from './focusTreeModel';

function node(id: string, nodeType: EmergenceNodeDto['nodeType'] = 'entity'): EmergenceNodeDto {
  return { id, nodeType, label: id, sourceGraph: 'roomGraph', roomRef: null, updatedAt: null };
}

function edge(id: string, from: string, to: string): EmergenceEdgeDto {
  return { id, from, to, relationType: 'route', edgeLevel: 'composed', confidence: null };
}

// 对齐写作路线投影的树形状：root → b1 → {b1-1, b1-2}，root → b2，b2 → b2-1
const nodes = [
  node('route:root', 'document'),
  node('route:b1'),
  node('route:b2'),
  node('route:b1-1'),
  node('route:b1-2'),
  node('route:b2-1'),
  node('fact:orphan'),
];

const edges = [
  edge('e1', 'route:root', 'route:b1'),
  edge('e2', 'route:root', 'route:b2'),
  edge('e3', 'route:b1', 'route:b1-1'),
  edge('e4', 'route:b1', 'route:b1-2'),
  edge('e5', 'route:b2', 'route:b2-1'),
];

const graph = { nodes, edges };

describe('buildFocusTree', () => {
  it('builds the full parent-to-child tree from the root', () => {
    const tree = buildFocusTree(graph, 'route:root');
    expect(tree.nodes.map((n) => n.id)).toEqual([
      'route:root', 'route:b1', 'route:b1-1', 'route:b1-2', 'route:b2', 'route:b2-1',
    ]);
    expect(tree.nodes.find((n) => n.id === 'route:b1')?.depth).toBe(1);
    expect(tree.nodes.find((n) => n.id === 'route:b1-1')?.parentId).toBe('route:b1');
    expect(tree.childrenOf.get('route:b1')).toEqual(['route:b1-1', 'route:b1-2']);
  });

  it('marks hasChildren on parents only; orphan/edge-less nodes stay out of the tree', () => {
    const tree = buildFocusTree(graph, 'route:root');
    const parents = tree.nodes.filter((n) => n.hasChildren).map((n) => n.id).sort();
    expect(parents).toEqual(['route:b1', 'route:b2', 'route:root']);
    expect(tree.byId.has('fact:orphan')).toBe(false);
  });

  it('returns an empty tree when the root is unknown', () => {
    const tree = buildFocusTree(graph, 'nope');
    expect(tree.nodes).toEqual([]);
    expect(tree.childrenOf.size).toBe(0);
  });

  it('ignores dangling edges, self loops, and back edges (cycle guard)', () => {
    const dirty = {
      nodes,
      edges: [...edges, edge('e9', 'route:root', 'ghost'), edge('e10', 'route:root', 'route:root'), edge('e11', 'route:b1-1', 'route:root')],
    };
    const tree = buildFocusTree(dirty, 'route:root');
    expect(tree.nodes.map((n) => n.id)).toEqual([
      'route:root', 'route:b1', 'route:b1-1', 'route:b1-2', 'route:b2', 'route:b2-1',
    ]);
    expect(tree.nodes.find((n) => n.id === 'route:b1-1')?.hasChildren).toBe(false);
  });

  it('keeps deep route chains intact up to the defensive cap', () => {
    const chainNodes = Array.from({ length: FOCUS_TREE_MAX_DEPTH + 8 }, (_, i) => node(`n${i}`));
    const chainEdges = Array.from({ length: FOCUS_TREE_MAX_DEPTH + 7 }, (_, i) => edge(`ce${i}`, `n${i}`, `n${i + 1}`));
    const tree = buildFocusTree({ nodes: chainNodes, edges: chainEdges }, 'n0');
    expect(tree.nodes.length).toBe(FOCUS_TREE_MAX_DEPTH + 1);
    expect(tree.nodes.at(-1)?.depth).toBe(FOCUS_TREE_MAX_DEPTH);
    // 被截断的最深节点不再标记 hasChildren（childrenOf 没写入）
    expect(tree.nodes.at(-1)?.hasChildren).toBe(false);
  });
});

describe('resolveCenter', () => {
  it('prefers the requested center when present', () => {
    expect(resolveCenter(graph, 'route:b1')).toBe('route:b1');
  });

  it('falls back to the room node, then the first node, then empty', () => {
    expect(resolveCenter(graph, 'missing')).toBe('route:root');
    const withRoom = { nodes: [node('route:root', 'document'), node('room:R', 'room')], edges: [] };
    expect(resolveCenter(withRoom, 'missing')).toBe('room:R');
    const noRoom = { nodes: [node('a'), node('b')], edges: [] };
    expect(resolveCenter(noRoom, 'missing')).toBe('a');
    expect(resolveCenter(null, 'x')).toBe('');
    expect(resolveCenter({ nodes: [], edges: [] }, 'x')).toBe('');
  });
});
