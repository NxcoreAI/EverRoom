import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import {
  backWalk, edgeBetween, initialWalkLog, mergeWanderResult, nextHops, stepWalk,
} from './walkModel';

function node(id: string, roomRef?: { id: string; title: string } | null, nodeType: EmergenceNodeDto['nodeType'] = 'fact'): EmergenceNodeDto {
  return { id, nodeType, label: id, sourceGraph: 'roomGraph', roomRef: roomRef ?? null, updatedAt: null };
}

function edge(id: string, from: string, to: string, relationType = '关联'): EmergenceEdgeDto {
  return { id, from, to, relationType, edgeLevel: 'original', confidence: null };
}

const ROOM = 'room-1';
const foreign = { id: 'room-3', title: '连接器' };

describe('nextHops', () => {
  it('ranks continuation candidates ahead of dead ends, bridge next', () => {
    const graph = {
      nodes: [node('a'), node('b'), node('c'), node('d'), node('e'), node('f', foreign), node('g')],
      edges: [
        edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'a', 'd'),
        edge('e4', 'a', 'e'), edge('e5', 'f', 'a'), edge('e6', 'a', 'g'),
        edge('x1', 'b', 'g'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    // b、g 背后还有未访问邻居（有下文）排前；桥接 f 是尽头排第三；其余尽头更后
    expect(hops.map((h) => h.nodeRef)).toEqual(['b', 'g', 'f']);
    expect(hops[0].deadEnd).toBe(false);
    expect(hops[0].nodeType).toBe('fact');
    expect(hops[2].bridgeRoom).toBe('连接器');
    expect(hops[2].deadEnd).toBe(true);
  });

  it('marks leaf candidates as deadEnd but still offers them last', () => {
    const graph = {
      nodes: [node('a'), node('hub'), node('leaf1'), node('leaf2'), node('beyond')],
      edges: [
        edge('e1', 'a', 'leaf1'), edge('e2', 'a', 'leaf2'), edge('e3', 'a', 'hub'),
        edge('e4', 'hub', 'beyond'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    expect(hops.map((h) => h.nodeRef)).toEqual(['hub', 'leaf1', 'leaf2']);
    expect(hops.map((h) => h.deadEnd)).toEqual([false, true, true]);
  });

  it('caps same nodeType at two seats before filling with other types', () => {
    const graph = {
      nodes: [
        node('a'), node('doc1', null, 'document'), node('doc2', null, 'document'),
        node('doc3', null, 'document'), node('ent1', null, 'entity'), node('ent2', null, 'entity'),
      ],
      edges: [
        edge('e1', 'a', 'doc1'), edge('e2', 'a', 'doc2'), edge('e3', 'a', 'doc3'),
        edge('e4', 'a', 'ent1'), edge('e5', 'a', 'ent2'),
        edge('x1', 'doc1', 'ent1'), edge('x2', 'doc2', 'ent1'), edge('x3', 'doc3', 'ent1'),
        edge('x4', 'ent1', 'ent2'), edge('x5', 'doc1', 'doc2'), edge('x6', 'doc2', 'doc3'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    // document 先占两席，第三席给 entity（都有下文，按边序 document 在前）
    expect(hops.map((h) => h.nodeType)).toEqual(['document', 'document', 'entity']);
  });

  it('skips already visited stations', () => {
    const graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'a', 'c')],
    };
    const log = stepWalk(graph, ROOM, initialWalkLog('a'), 'b')!;
    const hops = nextHops(graph, ROOM, log);
    expect(hops.map((h) => h.nodeRef)).toEqual(['c']);
    expect(hops[0].viaRelation).toBe('关联');
    expect(hops[0].viaLevel).toBe('original');
  });

  it('returns empty when the walk exhausted the local graph', () => {
    const graph = { nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] };
    expect(nextHops(graph, ROOM, stepWalk(graph, ROOM, initialWalkLog('a'), 'b')!)).toEqual([]);
  });

  it('returns empty instead of throwing on an empty log (reset not applied yet)', () => {
    const graph = { nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] };
    expect(nextHops(graph, ROOM, [])).toEqual([]);
  });
});

describe('mergeWanderResult', () => {
  const base = {
    nodes: [node('a'), node('b')],
    edges: [edge('e1', 'a', 'b')],
    cards: [],
    paths: [{ nodeRefs: ['a', 'b'], hops: ['关联'] }],
    focusRootRef: null,
    scoreComponents: null,
    requestVersion: 1,
    degraded: false,
    degradedReason: null,
    generatedAt: '2026-09-24T00:00:00.000Z',
  };

  it('dedupes nodes/edges by deterministic id and appends new paths', () => {
    const patch = {
      ...base,
      nodes: [node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c', '提及')],
      paths: [{ nodeRefs: ['b', 'c'], hops: ['提及'] }],
    };
    const merged = mergeWanderResult(base, patch);
    expect(merged.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(merged.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(merged.paths).toHaveLength(2);
    expect(merged.requestVersion).toBe(1);
  });

  it('keeps the base untouched when the patch adds nothing', () => {
    const merged = mergeWanderResult(base, { ...base, nodes: [node('a')], edges: [], paths: [] });
    expect(merged.nodes).toHaveLength(2);
    expect(merged.edges).toHaveLength(1);
    expect(merged.paths).toHaveLength(1);
  });
});

describe('stepWalk / backWalk', () => {
  const graph = {
    nodes: [node('a'), node('b', foreign), node('c')],
    edges: [edge('e1', 'a', 'b', '引用'), edge('e2', 'b', 'c')],
  };

  it('appends the station with the walked edge metadata', () => {
    const log = stepWalk(graph, ROOM, initialWalkLog('a'), 'b')!;
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ nodeRef: 'b', viaRelation: '引用', bridgeRoom: '连接器' });
  });

  it('rejects non-adjacent targets', () => {
    expect(stepWalk(graph, ROOM, initialWalkLog('a'), 'c')).toBeNull();
  });

  it('truncates back to a station without ever emptying the log', () => {
    const log = stepWalk(graph, ROOM, stepWalk(graph, ROOM, initialWalkLog('a'), 'b')!, 'c')!;
    expect(backWalk(log, 0)).toHaveLength(1);
    expect(backWalk(log, 1)).toHaveLength(2);
    expect(backWalk(log, -5)).toHaveLength(1);
  });
});

describe('edgeBetween', () => {
  it('matches edges in either direction', () => {
    const graph = { nodes: [], edges: [edge('e1', 'a', 'b')] };
    expect(edgeBetween(graph, 'a', 'b')?.id).toBe('e1');
    expect(edgeBetween(graph, 'b', 'a')?.id).toBe('e1');
    expect(edgeBetween(graph, 'a', 'c')).toBeNull();
  });
});
