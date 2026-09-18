import type { EmergenceEdgeDto, EmergenceNodeDto, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';

/** 漫步路径上的一站。via* 是走到这一站所沿的边（首站为空）。 */
export interface WalkStation {
  nodeRef: string;
  viaRelation: string;
  viaLevel: EmergenceEdgeDto['edgeLevel'] | null;
  /** 跨 Room 桥接边的对端房间名；非桥接为 null。 */
  bridgeRoom: string | null;
}

export interface WalkHop {
  nodeRef: string;
  edgeId: string;
  viaRelation: string;
  viaLevel: EmergenceEdgeDto['edgeLevel'];
  bridgeRoom: string | null;
}

type GraphSlice = Pick<EmergenceProjectionResultDto, 'nodes' | 'edges'>;

export function initialWalkLog(startRef: string): WalkStation[] {
  return [{ nodeRef: startRef, viaRelation: '', viaLevel: null, bridgeRoom: null }];
}

export function currentStation(log: WalkStation[]): WalkStation {
  return log[log.length - 1];
}

export function edgeBetween(result: GraphSlice, a: string, b: string): EmergenceEdgeDto | null {
  return result.edges.find(
    (edge) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
  ) ?? null;
}

function bridgeTitleOf(edge: EmergenceEdgeDto, nodeOf: Map<string, EmergenceNodeDto>, roomId: string): string | null {
  const from = nodeOf.get(edge.from);
  const to = nodeOf.get(edge.to);
  if (from?.roomRef && from.roomRef.id !== roomId) return from.roomRef.title;
  if (to?.roomRef && to.roomRef.id !== roomId) return to.roomRef.title;
  return null;
}

function hopOf(edge: EmergenceEdgeDto, nodeOf: Map<string, EmergenceNodeDto>, roomId: string, target: string): WalkHop {
  return {
    nodeRef: target,
    edgeId: edge.id,
    viaRelation: edge.relationType,
    viaLevel: edge.edgeLevel,
    bridgeRoom: bridgeTitleOf(edge, nodeOf, roomId),
  };
}

/**
 * 当前驻足的下一跳候选：未访问过的邻居，跨 Room 桥接优先（漫游的价值在弱相关），
 * 上限 cap 个。非桥接保持边顺序（稳定排序）。
 */
export function nextHops(result: GraphSlice, roomId: string, log: WalkStation[], cap = 3): WalkHop[] {
  if (log.length === 0) return [];
  const nodeOf = new Map(result.nodes.map((node) => [node.id, node]));
  const cur = currentStation(log).nodeRef;
  const visited = new Set(log.map((station) => station.nodeRef));
  const hops: WalkHop[] = [];
  for (const edge of result.edges) {
    const target = edge.from === cur ? edge.to : edge.to === cur ? edge.from : null;
    if (!target || target === cur) continue;
    if (visited.has(target) || !nodeOf.has(target)) continue;
    hops.push(hopOf(edge, nodeOf, roomId, target));
  }
  return hops
    .sort((a, b) => (b.bridgeRoom ? 1 : 0) - (a.bridgeRoom ? 1 : 0))
    .slice(0, cap);
}

/** 沿一步走：目标必须是当前驻足的邻居，否则返回 null（调用方忽略）。 */
export function stepWalk(result: GraphSlice, roomId: string, log: WalkStation[], nodeRef: string): WalkStation[] | null {
  const cur = currentStation(log).nodeRef;
  const edge = edgeBetween(result, cur, nodeRef);
  if (!edge) return null;
  const nodeOf = new Map(result.nodes.map((node) => [node.id, node]));
  return [...log, {
    nodeRef,
    viaRelation: edge.relationType,
    viaLevel: edge.edgeLevel,
    bridgeRoom: bridgeTitleOf(edge, nodeOf, roomId),
  }];
}

/** 回到走过的某一站：截断路径，首站永不清空。 */
export function backWalk(log: WalkStation[], index: number): WalkStation[] {
  return log.slice(0, Math.max(1, index + 1));
}
