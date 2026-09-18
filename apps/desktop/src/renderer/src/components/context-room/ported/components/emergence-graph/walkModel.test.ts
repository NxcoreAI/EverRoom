import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import { backWalk, edgeBetween, initialWalkLog, nextHops, stepWalk } from './walkModel';

function node(id: string, roomRef?: { id: string; title: string } | null): EmergenceNodeDto {
  return { id, nodeType: 'fact', label: id, sourceGraph: 'roomGraph', roomRef: roomRef ?? null, updatedAt: null };
}

function edge(id: string, from: string, to: string, relationType = '关联'): EmergenceEdgeDto {
  return { id, from, to, relationType, edgeLevel: 'original', confidence: null };
}

const ROOM = 'room-1';
const foreign = { id: 'room-3', title: '连接器' };

describe('nextHops', () => {
  it('lists unvisited neighbors of the current station, capped and bridge-first', () => {
    const graph = {
      nodes: [node('a'), node('b'), node('c'), node('d'), node('e'), node('f', foreign)],
      edges: [
        edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'a', 'd'),
        edge('e4', 'a', 'e'), edge('e5', 'f', 'a'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    // 桥接 f 排最前，其余保持边顺序，共 3 个
    expect(hops.map((h) => h.nodeRef)).toEqual(['f', 'b', 'c']);
    expect(hops[0].bridgeRoom).toBe('连接器');
    expect(hops[1].bridgeRoom).toBeNull();
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
