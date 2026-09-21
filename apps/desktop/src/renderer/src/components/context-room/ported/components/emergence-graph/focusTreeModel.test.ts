import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import { buildFocusTree, defaultCollapsed, revealAncestors, resolveCenter } from './focusTreeModel';

function node(id: string, nodeType: EmergenceNodeDto['nodeType'] = 'fact'): EmergenceNodeDto {
  return { id, nodeType, label: id, sourceGraph: 'roomGraph', roomRef: null, updatedAt: null };
}

function edge(id: string, from: string, to: string): EmergenceEdgeDto {
  return { id, from, to, relationType: '分支', edgeLevel: 'composed', confidence: null };
}

// 对齐思维导图投影的树形状：root → b1 → {b1-1, b1-2}，root → b2，b2 → b2-1
const nodes = [
  node('mindmap:root', 'document'),
  node('mindmap:b1', 'mindmapTopic'),
  node('mindmap:b2', 'mindmapTopic'),
  node('mindmap:b1-1', 'mindmapTopic'),
  node('mindmap:b1-2', 'mindmapTopic'),
  node('mindmap:b2-1', 'mindmapTopic'),
  node('fact:orphan'),
];

const edges = [
  edge('e1', 'mindmap:root', 'mindmap:b1'),
  edge('e2', 'mindmap:root', 'mindmap:b2'),
  edge('e3', 'mindmap:b1', 'mindmap:b1-1'),
  edge('e4', 'mindmap:b1', 'mindmap:b1-2'),
  edge('e5', 'mindmap:b2', 'mindmap:b2-1'),
];

const graph = { nodes, edges };

describe('buildFocusTree', () => {
  it('builds the full parent-to-child tree from the root', () => {
    const tree = buildFocusTree(graph, 'mindmap:root');
    expect(tree.nodes.map((n) => n.id)).toEqual([
      'mindmap:root', 'mindmap:b1', 'mindmap:b1-1', 'mindmap:b1-2', 'mindmap:b2', 'mindmap:b2-1',
    ]);
    expect(tree.nodes.find((n) => n.id === 'mindmap:b1')?.depth).toBe(1);
    expect(tree.nodes.find((n) => n.id === 'mindmap:b1-1')?.parentId).toBe('mindmap:b1');
    expect(tree.childrenOf.get('mindmap:b1')).toEqual(['mindmap:b1-1', 'mindmap:b1-2']);
  });

  it('marks hasChildren on parents only; orphan/edge-less nodes stay out of the tree', () => {
    const tree = buildFocusTree(graph, 'mindmap:root');
    const parents = tree.nodes.filter((n) => n.hasChildren).map((n) => n.id).sort();
    expect(parents).toEqual(['mindmap:b1', 'mindmap:b2', 'mindmap:root']);
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
      edges: [...edges, edge('e9', 'mindmap:root', 'ghost'), edge('e10', 'mindmap:root', 'mindmap:root'), edge('e11', 'mindmap:b1-1', 'mindmap:root')],
    };
    const tree = buildFocusTree(dirty, 'mindmap:root');
    expect(tree.nodes.map((n) => n.id)).toEqual([
      'mindmap:root', 'mindmap:b1', 'mindmap:b1-1', 'mindmap:b1-2', 'mindmap:b2', 'mindmap:b2-1',
    ]);
    expect(tree.nodes.find((n) => n.id === 'mindmap:b1-1')?.hasChildren).toBe(false);
  });

  it('caps runaway depth beyond FOCUS_TREE_MAX_DEPTH', () => {
    const chainNodes = Array.from({ length: 8 }, (_, i) => node(`n${i}`));
    const chainEdges = Array.from({ length: 7 }, (_, i) => edge(`ce${i}`, `n${i}`, `n${i + 1}`));
    const tree = buildFocusTree({ nodes: chainNodes, edges: chainEdges }, 'n0');
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(tree.nodes.length).toBe(5);
    // 被截断的最深节点不再标记 hasChildren（childrenOf 没写入）
    expect(tree.nodes.at(-1)?.hasChildren).toBe(false);
  });
});

describe('defaultCollapsed', () => {
  it('collapses every parent except the root — first screen shows root + level-1 only', () => {
    const tree = buildFocusTree(graph, 'mindmap:root');
    const collapsed = defaultCollapsed(tree);
    expect([...collapsed].sort()).toEqual(['mindmap:b1', 'mindmap:b2']);
    expect(collapsed.has('mindmap:root')).toBe(false);
  });

  it('empty for a flat tree (no second level)', () => {
    const flat = { nodes: [node('r', 'room'), node('a'), node('b')], edges: [edge('f1', 'r', 'a'), edge('f2', 'r', 'b')] };
    expect([...defaultCollapsed(buildFocusTree(flat, 'r'))]).toEqual([]);
  });
});

describe('revealAncestors', () => {
  const tree = buildFocusTree(graph, 'mindmap:root');

  it('expands the ancestor chain when a leaf is selected (parent becomes visible)', () => {
    const revealed = revealAncestors(tree, defaultCollapsed(tree), 'mindmap:b1-1');
    expect(revealed).not.toBeNull();
    expect(revealed!.has('mindmap:b1')).toBe(false);
    expect(revealed!.has('mindmap:b2')).toBe(true);
  });

  it('leaves the selected node itself collapsed (mid-node interaction unchanged)', () => {
    expect(revealAncestors(tree, defaultCollapsed(tree), 'mindmap:b2')).toBeNull();
  });

  it('keeps the root expanded when selected (children stay visible)', () => {
    const collapsed = new Set(defaultCollapsed(tree));
    collapsed.add('mindmap:root');
    const revealed = revealAncestors(tree, collapsed, 'mindmap:root');
    expect(revealed).not.toBeNull();
    expect(revealed!.has('mindmap:root')).toBe(false);
    expect(revealed!.has('mindmap:b1')).toBe(true);
  });

  it('returns null when nothing to reveal or the node is unknown', () => {
    expect(revealAncestors(tree, new Set(), 'mindmap:b1-1')).toBeNull();
    expect(revealAncestors(tree, defaultCollapsed(tree), 'fact:orphan')).toBeNull();
  });
});

describe('resolveCenter', () => {
  it('prefers the requested center when present', () => {
    expect(resolveCenter(graph, 'mindmap:b1')).toBe('mindmap:b1');
  });

  it('falls back to the room node, then the first node, then empty', () => {
    expect(resolveCenter(graph, 'missing')).toBe('mindmap:root');
    const withRoom = { nodes: [node('mindmap:root', 'document'), node('room:R', 'room')], edges: [] };
    expect(resolveCenter(withRoom, 'missing')).toBe('room:R');
    const noRoom = { nodes: [node('a'), node('b')], edges: [] };
    expect(resolveCenter(noRoom, 'missing')).toBe('a');
    expect(resolveCenter(null, 'x')).toBe('');
    expect(resolveCenter({ nodes: [], edges: [] }, 'x')).toBe('');
  });
});
