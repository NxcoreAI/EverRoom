import { describe, expect, it } from 'vitest';

import type { EmergenceEdgeDto, EmergenceNodeDto } from '../../../../../../../shared/knowledge';
import {
  backWalk, edgeBetween, initialWalkLog, mergeWanderResult, nextHops, stepWalk,
} from './walkModel';

function node(id: string, roomRef?: { id: string; title: string } | null, nodeType: EmergenceNodeDto['nodeType'] = 'fact'): EmergenceNodeDto {
  return { id, nodeType, label: id, sourceGraph: 'roomGraph', roomRef: roomRef ?? null, updatedAt: null };
}

function edge(id: string, from: string, to: string, relationType = '关联', confidence: number | null = null): EmergenceEdgeDto {
  return { id, from, to, relationType, edgeLevel: 'original', confidence };
}

const ROOM = 'room-1';
const foreign = { id: 'room-3', title: '连接器' };

describe('nextHops · 内容价值排序', () => {
  it('多源事实领跑，实体居中，空桥垫底（事实不因叶子身份降权）', () => {
    const graph = {
      nodes: [node('a'), node('f1'), node('e1', null, 'entity'), node('b1', foreign, 'room')],
      edges: [
        edge('x1', 'a', 'f1', '事实', 0.9),
        edge('x2', 'a', 'e1', '提及'),
        edge('x3', 'a', 'b1', 'mixed'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    expect(hops.map((h) => h.nodeRef)).toEqual(['f1', 'e1', 'b1']);
    expect(hops[0].score).toBeGreaterThan(hops[1].score);
    expect(hops[1].score).toBeGreaterThan(hops[2].score);
    expect(hops[2].bridgeRoom).toBe('连接器');
    expect(hops[2].deadEnd).toBe(true);
  });

  it('洞察跳加成：relationType 本身是事实文本的边领跑', () => {
    const graph = {
      nodes: [node('a'), node('e1', null, 'entity'), node('e2', null, 'entity')],
      edges: [
        edge('x1', 'a', 'e1', '张三与李四合作', 0.67),
        edge('x2', 'a', 'e2', '提及'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    expect(hops.map((h) => h.nodeRef)).toEqual(['e1', 'e2']);
    expect(hops[0].score - hops[1].score).toBeGreaterThan(0.3);
  });

  it('文档尽头受罚，死事实仍压过死文档', () => {
    const graph = {
      nodes: [node('a'), node('d1', null, 'document'), node('f1')],
      edges: [
        edge('x1', 'a', 'd1', '收录'),
        edge('x2', 'a', 'f1', '事实', 0.33),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    expect(hops.map((h) => h.nodeRef)).toEqual(['f1', 'd1']);
    expect(hops[1].deadEnd).toBe(true);
  });

  it('富桥（对岸挂载多）排在空桥之前', () => {
    const rich = { id: 'room-9', title: '富桥' };
    const graph = {
      nodes: [
        node('a'),
        node('r1', rich, 'room'), node('r2', rich, 'entity'), node('r3', rich, 'entity'),
        node('r4', rich, 'entity'), node('r5', rich, 'entity'),
        node('h1', foreign, 'room'),
      ],
      edges: [
        edge('x1', 'a', 'r1', 'mixed'),
        edge('x2', 'a', 'h1', 'mixed'),
      ],
    };
    const hops = nextHops(graph, ROOM, initialWalkLog('a'));
    expect(hops.map((h) => h.nodeRef)).toEqual(['r1', 'h1']);
    expect(hops[0].bridgeRoom).toBe('富桥');
  });
});

describe('nextHops · 事实翻面', () => {
  it('事实站翻同一实体的兄弟事实，via 标签带锚实体，兄弟在则不是尽头', () => {
    const graph = {
      nodes: [node('start'), node('e', null, 'entity'), node('f1'), node('f2'), node('f3')],
      edges: [
        edge('x0', 'start', 'e', '提及'),
        edge('x1', 'e', 'f1', '事实', 0.5),
        edge('x2', 'e', 'f2', '事实', 0.5),
        edge('x3', 'e', 'f3', '事实', 0.5),
      ],
    };
    const log = stepWalk(graph, ROOM, stepWalk(graph, ROOM, initialWalkLog('start'), 'e')!, 'f1')!;
    const hops = nextHops(graph, ROOM, log);
    expect(hops.map((h) => h.nodeRef)).toEqual(['f2', 'f3']);
    expect(hops[0].flip).toBe(true);
    expect(hops[0].viaRelation).toBe('同实体·e');
    expect(hops[0].viaLevel).toBe('composed');
    expect(hops[0].deadEnd).toBe(false);
  });

  it('实体站借共同事实跳到共现实体，via 标签就是那条事实', () => {
    const graph = {
      nodes: [node('start'), node('e1', null, 'entity'), node('e2', null, 'entity'), node('e3', null, 'entity'), node('f1')],
      edges: [
        edge('x0', 'start', 'e1', '提及'),
        edge('x1', 'e1', 'f1', '事实', 0.5),
        edge('x2', 'f1', 'e2', '事实', 0.5),
        edge('x3', 'e1', 'e3', '提及'),
      ],
    };
    const log = stepWalk(graph, ROOM, initialWalkLog('start'), 'e1')!;
    const hops = nextHops(graph, ROOM, log);
    expect(hops.map((h) => h.nodeRef)).toEqual(['f1', 'e3', 'e2']);
    expect(hops[2].flip).toBe(true);
    expect(hops[2].viaRelation).toBe('f1');
  });
});

describe('nextHops · 通用约束', () => {
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
    expect(hops.map((h) => h.nodeType)).toEqual(['entity', 'entity', 'document']);
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
