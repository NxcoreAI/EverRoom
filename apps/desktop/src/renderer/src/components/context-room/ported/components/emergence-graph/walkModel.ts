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
  /** 候选目标的节点类型（类型多样性排序用）。 */
  nodeType: EmergenceNodeDto['nodeType'];
  /** 目标在切片内已无未访问邻居——走到即尽头：排序压底、UI 标灰。 */
  deadEnd: boolean;
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

function hopOf(edge: EmergenceEdgeDto, nodeOf: Map<string, EmergenceNodeDto>, roomId: string, target: string): Omit<WalkHop, 'nodeType' | 'deadEnd'> {
  return {
    nodeRef: target,
    edgeId: edge.id,
    viaRelation: edge.relationType,
    viaLevel: edge.edgeLevel,
    bridgeRoom: bridgeTitleOf(edge, nodeOf, roomId),
  };
}

/**
 * 当前驻足的下一跳候选：未访问过的邻居，最多 cap 个。排序是续走优先——
 * 目标还有未访问邻居（有下文）的先露出，其次跨 Room 桥接（漫游的价值在弱相关），
 * 已成尽头的压底；同类型最多先占两席（类型多样），占满再补位。尽头候选仍保留
 * （可能是用户想去的目标），只是排后并标记 deadEnd 给 UI 降权展示。
 */
export function nextHops(result: GraphSlice, roomId: string, log: WalkStation[], cap = 3): WalkHop[] {
  if (log.length === 0) return [];
  const nodeOf = new Map(result.nodes.map((node) => [node.id, node]));
  const cur = currentStation(log).nodeRef;
  const visited = new Set(log.map((station) => station.nodeRef));
  const openNeighborsOf = (target: string): number => {
    let count = 0;
    for (const edge of result.edges) {
      const other = edge.from === target ? edge.to : edge.to === target ? edge.from : null;
      if (!other || other === target || other === cur) continue;
      if (visited.has(other) || !nodeOf.has(other)) continue;
      count += 1;
    }
    return count;
  };
  const seenTargets = new Set<string>();
  const candidates: Array<{ hop: WalkHop; continuation: number; order: number }> = [];
  for (const edge of result.edges) {
    const target = edge.from === cur ? edge.to : edge.to === cur ? edge.from : null;
    if (!target || target === cur || seenTargets.has(target)) continue;
    if (visited.has(target) || !nodeOf.has(target)) continue;
    seenTargets.add(target);
    const node = nodeOf.get(target)!;
    candidates.push({
      hop: { ...hopOf(edge, nodeOf, roomId, target), nodeType: node.nodeType, deadEnd: false },
      continuation: openNeighborsOf(target),
      order: candidates.length,
    });
  }
  const ranked = candidates
    .map((item) => ({ ...item, hop: { ...item.hop, deadEnd: item.continuation === 0 } }))
    .sort((a, b) =>
      (b.hop.deadEnd ? 0 : 1) - (a.hop.deadEnd ? 0 : 1)
      || (b.hop.bridgeRoom ? 1 : 0) - (a.hop.bridgeRoom ? 1 : 0)
      || a.order - b.order);
  const chosen: WalkHop[] = [];
  const deferred: typeof ranked = [];
  const typeSeats = new Map<string, number>();
  for (const item of ranked) {
    if (chosen.length >= cap) break;
    const used = typeSeats.get(item.hop.nodeType) ?? 0;
    if (used >= 2) {
      deferred.push(item);
      continue;
    }
    typeSeats.set(item.hop.nodeType, used + 1);
    chosen.push(item.hop);
  }
  for (const item of deferred) {
    if (chosen.length >= cap) break;
    chosen.push(item.hop);
  }
  return chosen;
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

/**
 * 续走合并：以当前站为起点的新投影并回已有切片——节点/边/卡片按确定性
 * id 去重追加（网关 id 由内容哈希生成，跨请求稳定），路径链整体追加。
 * 旅程（walkLog）不动，只是脚下的世界变大。
 */
export function mergeWanderResult(
  base: EmergenceProjectionResultDto,
  patch: EmergenceProjectionResultDto,
): EmergenceProjectionResultDto {
  const mergeById = <T extends { id: string }>(items: T[], extra: T[]): T[] => {
    if (extra.length === 0) return items;
    const seen = new Set(items.map((item) => item.id));
    const merged = [...items];
    for (const item of extra) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  };
  return {
    ...base,
    nodes: mergeById(base.nodes, patch.nodes),
    edges: mergeById(base.edges, patch.edges),
    cards: mergeById(base.cards, patch.cards),
    paths: patch.paths.length > 0 ? [...base.paths, ...patch.paths] : base.paths,
  };
}
