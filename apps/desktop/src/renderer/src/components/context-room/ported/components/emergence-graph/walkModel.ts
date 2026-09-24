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
  /** 目标在切片内已无未访问邻居（含翻面）——走到即尽头：排序压底、UI 标灰。 */
  deadEnd: boolean;
  /** 二级跳（同实体翻事实/同事实共现实体）：非直接边，组合层虚线。 */
  flip: boolean;
  /** 内容价值分——排序依据，也供诊断日志展示。 */
  score: number;
}

/** 结构性关系标签——边本身不是内容；其余 relationType（「关系」型事实的实体直达边）
 *  的标签就是事实文本，这一跳自带洞察。 */
const STRUCTURAL_RELATIONS = new Set(['提及', '事实', '收录', '引用', '关联', 'mixed']);

/** 类型基分：事实是信息载荷，实体是通往事实簇的枢纽，文档是死重的末梢，
 *  Room 桥的身价完全取决于对岸挂载密度（在得分里另行加成）。 */
const TYPE_BASE: Record<EmergenceNodeDto['nodeType'], number> = {
  fact: 1.0,
  entity: 0.75,
  document: 0.55,
  room: 0.45,
  block: 0.4,
  memory: 0.4,
  wikiPage: 0.4,
  wikiTopic: 0.4,
};

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

function hopOf(edge: EmergenceEdgeDto, nodeOf: Map<string, EmergenceNodeDto>, roomId: string, target: string): Omit<WalkHop, 'nodeType' | 'deadEnd' | 'flip' | 'score'> {
  return {
    nodeRef: target,
    edgeId: edge.id,
    viaRelation: edge.relationType,
    viaLevel: edge.edgeLevel,
    bridgeRoom: bridgeTitleOf(edge, nodeOf, roomId),
  };
}

interface FlipTarget {
  nodeRef: string;
  viaLabel: string;
}

/** 二级跳目标：事实站翻同一实体的其他事实（来路实体正是共同锚点，允许已访问）；
 *  实体站借共同事实跳到共现实体——跳的标签就是那条事实，相关性自带解释。 */
function flipTargetsOf(
  result: GraphSlice,
  nodeOf: Map<string, EmergenceNodeDto>,
  visited: Set<string>,
  fromRef: string,
): FlipTarget[] {
  const node = nodeOf.get(fromRef);
  if (!node) return [];
  const seen = new Set<string>([fromRef]);
  const out: FlipTarget[] = [];
  const add = (ref: string, viaLabel: string) => {
    if (seen.has(ref) || visited.has(ref) || !nodeOf.has(ref)) return;
    seen.add(ref);
    out.push({ nodeRef: ref, viaLabel });
  };
  const otherEnd = (edge: EmergenceEdgeDto, ref: string): string | null =>
    edge.from === ref ? edge.to : edge.to === ref ? edge.from : null;
  if (node.nodeType === 'fact') {
    for (const edge of result.edges) {
      const anchor = otherEnd(edge, fromRef);
      if (!anchor || nodeOf.get(anchor)?.nodeType !== 'entity') continue;
      const anchorLabel = nodeOf.get(anchor)!.label;
      for (const second of result.edges) {
        const sibling = otherEnd(second, anchor);
        if (!sibling || sibling === fromRef) continue;
        if (nodeOf.get(sibling)?.nodeType !== 'fact') continue;
        add(sibling, `同实体·${anchorLabel}`);
      }
    }
  } else if (node.nodeType === 'entity') {
    for (const edge of result.edges) {
      const factRef = otherEnd(edge, fromRef);
      if (!factRef || nodeOf.get(factRef)?.nodeType !== 'fact') continue;
      const factLabel = nodeOf.get(factRef)!.label;
      for (const second of result.edges) {
        const coEntity = otherEnd(second, factRef);
        if (!coEntity || coEntity === fromRef) continue;
        if (nodeOf.get(coEntity)?.nodeType !== 'entity') continue;
        add(coEntity, factLabel);
      }
    }
  }
  return out;
}

/**
 * 当前驻足的下一跳候选：未访问过的邻居 + 二级翻面跳，最多 cap 个。排序是内容
 * 价值优先——多源事实与「关系」洞察跳领跑；桥接按对岸真实挂载密度计身价，空桥
 * 掉队；事实不再因叶子身份垫底（同实体翻面即下文）。可走性只是小权重，不再是
 * 一票否决；真正的尽头（含翻面后仍无路）压底标灰但保留。同类型最多先占两席。
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
      if (!other || other === target || visited.has(other) || !nodeOf.has(other)) continue;
      count += 1;
    }
    return count;
  };
  // 事实的「事实」边携带 sourceCount 置信——翻面候选没有直接边，从目标自己的事实边取
  const factConfidenceOf = (ref: string): number => {
    for (const edge of result.edges) {
      if (edge.relationType !== '事实') continue;
      if (edge.from === ref || edge.to === ref) return edge.confidence ?? 0.5;
    }
    return 0.5;
  };
  const continuationOf = (target: string): number =>
    openNeighborsOf(target) + flipTargetsOf(result, nodeOf, visited, target).length;
  const densityOf = (roomRefId: string): number => {
    let count = 0;
    for (const node of result.nodes) {
      if (node.roomRef?.id === roomRefId) count += 1;
    }
    return count;
  };
  const foreignRoomOf = (ref: string): string | null => {
    const roomRef = nodeOf.get(ref)?.roomRef;
    return roomRef && roomRef.id !== roomId ? roomRef.title : null;
  };

  const seenTargets = new Set<string>();
  const ranked: Array<{ hop: WalkHop; score: number; order: number }> = [];
  for (const edge of result.edges) {
    const target = edge.from === cur ? edge.to : edge.to === cur ? edge.from : null;
    if (!target || target === cur || seenTargets.has(target)) continue;
    if (visited.has(target) || !nodeOf.has(target)) continue;
    seenTargets.add(target);
    const node = nodeOf.get(target)!;
    const cont = continuationOf(target);
    const bridgeRoomRef = node.roomRef && node.roomRef.id !== roomId ? node.roomRef : null;
    const score = (TYPE_BASE[node.nodeType] ?? 0.5)
      + 0.5 * (edge.confidence ?? 0.5)
      + (0.25 * Math.min(cont, 3)) / 3
      + (STRUCTURAL_RELATIONS.has(edge.relationType) ? 0 : 0.35)
      + (bridgeRoomRef ? 0.3 * Math.min(densityOf(bridgeRoomRef.id) / 8, 1) : 0)
      - (node.nodeType === 'document' && cont === 0 ? 0.35 : 0);
    ranked.push({
      hop: { ...hopOf(edge, nodeOf, roomId, target), nodeType: node.nodeType, deadEnd: cont === 0, flip: false, score },
      score,
      order: ranked.length,
    });
  }
  for (const flip of flipTargetsOf(result, nodeOf, visited, cur)) {
    if (seenTargets.has(flip.nodeRef)) continue;
    seenTargets.add(flip.nodeRef);
    const node = nodeOf.get(flip.nodeRef)!;
    const cont = continuationOf(flip.nodeRef);
    const bridgeRoom = foreignRoomOf(flip.nodeRef);
    const bridgeRoomRef = node.roomRef && node.roomRef.id !== roomId ? node.roomRef : null;
    const score = (TYPE_BASE[node.nodeType] ?? 0.5)
      + 0.5 * factConfidenceOf(flip.nodeRef)
      + (0.25 * Math.min(cont, 3)) / 3
      + (bridgeRoomRef ? 0.3 * Math.min(densityOf(bridgeRoomRef.id) / 8, 1) : 0)
      - 0.1;
    ranked.push({
      hop: {
        nodeRef: flip.nodeRef,
        edgeId: `flip:${cur}\n${flip.viaLabel}\n${flip.nodeRef}`,
        viaRelation: flip.viaLabel,
        viaLevel: 'composed',
        bridgeRoom,
        nodeType: node.nodeType,
        deadEnd: cont === 0,
        flip: true,
        score,
      },
      score,
      order: ranked.length,
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
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
