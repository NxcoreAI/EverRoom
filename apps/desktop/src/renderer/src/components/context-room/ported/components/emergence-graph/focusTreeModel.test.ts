import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import { buildFocusSubtree, resolveCenter } from './focusTreeModel';

function node(id: string, nodeType: EmergenceNodeDto['nodeType'] = 'fact'): EmergenceNodeDto {
  return { id, nodeType, label: id, sourceGraph: 'roomGraph', roomRef: null, updatedAt: null };
}

function edge(id: string, from: string, to: string): EmergenceEdgeDto {
  return { id, from, to, relationType: '关联', edgeLevel: 'original', confidence: null };
}

// 对齐浏览器 mock 的图形状：room → doc1 → {factD, person}，factD → {team, memory} → wiki
const nodes = [
  node('room:R', 'room'),
  node('doc:1', 'document'),
  node('doc:2', 'document'),
  node('entity:P', 'entity'),
  node('entity:T', 'entity'),
  node('fact:D'),
  node('fact:C'),
  node('memory:M', 'memory'),
  node('wiki:3', 'wikiPage'),
];

const edges = [
  edge('e1', 'room:R', 'doc:1'),
  edge('e2', 'doc:1', 'fact:D'),
  edge('e3', 'doc:1', 'entity:P'),
  edge('e4', 'fact:D', 'entity:T'),
  edge('e5', 'doc:2', 'fact:C'),
  edge('e6', 'entity:P', 'entity:T'),
  edge('e7', 'fact:D', 'memory:M'),
  edge('e8', 'memory:M', 'wiki:3'),
];

const graph = { nodes, edges };

describe('buildFocusSubtree', () => {
  it('collects the two-level undirected neighborhood of the center', () => {
    const tree = buildFocusSubtree(graph, 'room:R');
    const ids = tree.nodes.map((n) => n.id);
    expect(ids).toEqual(['room:R', 'doc:1', 'fact:D', 'entity:P']);
    expect(tree.nodes.find((n) => n.id === 'doc:1')?.depth).toBe(1);
    expect(tree.nodes.find((n) => n.id === 'fact:D')?.parentId).toBe('doc:1');
    expect(tree.nodes.find((n) => n.id === 'fact:D')?.via?.id).toBe('e2');
  });

  it('traverses edges pointing into the center as children too', () => {
    const tree = buildFocusSubtree(graph, 'fact:D');
    expect(tree.nodes.filter((n) => n.depth === 1).map((n) => n.id).sort()).toEqual(['doc:1', 'entity:T', 'memory:M']);
    // 第二层透过 doc:1 看到 room:R 与 entity:P，透过 memory:M 看到 wiki:3
    expect(tree.nodes.filter((n) => n.depth === 2).map((n) => n.id).sort()).toEqual(['entity:P', 'room:R', 'wiki:3']);
  });

  it('keeps the first discovered parent when a node is reachable from several', () => {
    // entity:T 可从 fact:D(e4) 与 entity:P(e6) 到达；BFS 先处理 doc:1 分支 → P 先发现 T？不：
    // fact:D 的邻居顺序是 e2(doc:1)、e4(T)、e7(M)。T 在 depth1 直接发现，parent=fact:D。
    const tree = buildFocusSubtree(graph, 'fact:D');
    expect(tree.nodes.find((n) => n.id === 'entity:T')?.parentId).toBe('fact:D');
  });

  it('marks expandable only for nodes with neighbors outside the window', () => {
    const tree = buildFocusSubtree(graph, 'room:R');
    const expandable = tree.nodes.filter((n) => n.expandable).map((n) => n.id).sort();
    // fact:D 窗外有 T/M；entity:P 窗外有 T；room:R 的邻居都在窗内
    expect(expandable).toEqual(['entity:P', 'fact:D']);
  });

  it('turns the previous center into a return capsule instead of a branch', () => {
    const tree = buildFocusSubtree(graph, 'fact:D', 'doc:1');
    const returnNode = tree.nodes.find((n) => n.id === 'doc:1');
    expect(returnNode?.isReturn).toBe(true);
    expect(returnNode?.expandable).toBe(false);
    // doc:1 不再作为子节点向左展开：depth1 只有 T/M
    expect(tree.nodes.filter((n) => n.depth === 1 && !n.isReturn).map((n) => n.id).sort()).toEqual(['entity:T', 'memory:M']);
    // 窗口可以透过 T 看到 P
    expect(tree.nodes.some((n) => n.id === 'entity:P')).toBe(true);
  });

  it('returns an empty node list when the center is unknown', () => {
    expect(buildFocusSubtree(graph, 'nope').nodes).toEqual([]);
  });

  it('ignores dangling edges and self loops', () => {
    const dirty = {
      nodes,
      edges: [...edges, edge('e9', 'room:R', 'ghost'), edge('e10', 'room:R', 'room:R')],
    };
    const tree = buildFocusSubtree(dirty, 'room:R');
    expect(tree.nodes.map((n) => n.id)).toEqual(['room:R', 'doc:1', 'fact:D', 'entity:P']);
  });

  it('attaches edge-less nodes from the slice to the center instead of dropping them', () => {
    const sparse = { nodes: [...nodes, node('fact:L')], edges };
    const tree = buildFocusSubtree(sparse, 'room:R');
    const loose = tree.nodes.find((n) => n.id === 'fact:L');
    expect(loose?.depth).toBe(1);
    expect(loose?.parentId).toBe('room:R');
    expect(loose?.via).toBeNull();
  });
});

describe('resolveCenter', () => {
  it('prefers the requested center when present', () => {
    expect(resolveCenter(graph, 'doc:1')).toBe('doc:1');
  });

  it('falls back to the room node, then the first node, then empty', () => {
    expect(resolveCenter(graph, 'missing')).toBe('room:R');
    const noRoom = { nodes: [node('a'), node('b')], edges: [] };
    expect(resolveCenter(noRoom, 'missing')).toBe('a');
    expect(resolveCenter(null, 'x')).toBe('');
    expect(resolveCenter({ nodes: [], edges: [] }, 'x')).toBe('');
  });
});
