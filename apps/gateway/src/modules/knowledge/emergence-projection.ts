/**
 * 知识涌现投影（PRD v3.0 §7/§8）：漫步模式的纯函数投影层。
 * （聚焦模式已改由 route-mindmap 承接写作路线导图，不在本投影内。）
 *
 * 职责边界（照 overview-projection 模式）：
 * - 本文件只做采样、去重、卡片/图谱塑形，不碰数据库、不调 LLM；
 * - 取数与编排在 emergence-service.ts；
 * - 输出 EmergenceProjectionResult 与渲染层 apps/desktop/src/shared/knowledge.ts
 *   中的 DTO 逐字段同形（跨进程契约双份维护，改动需两侧同步）。
 *
 * 漫步的硬性约束（PRD 7.5/7.9）：初始结果不调 LLM、沿真实关系游走、
 * 每个结果都能展示从起点到目标的完整路径；随机游走带可复现种子。
 */

import { createHash } from "node:crypto";

/** 漫步卡片上限（PRD 7.5）。 */
export const WANDER_DEFAULT_CARDS = 15;
/** 漫步知识脉络节点上限（PRD 7.9）。 */
export const WANDER_MAX_NODES = 35;
/** 漫步游走深度（PRD 7.5：二至四跳）。 */
export const WANDER_MIN_DEPTH = 2;
export const WANDER_MAX_DEPTH = 4;
/** 同主题组在结果中的最大连续占比（PRD 7.5：同一主题连续不超过三个）。 */
export const SAME_GROUP_MAX = 3;

export type EmergenceCardKind =
  | "evidence"
  | "decision"
  | "viewpoint"
  | "conflict"
  | "actor"
  | "case"
  | "question";

export const CARD_KIND_LABELS: Record<EmergenceCardKind, string> = {
  evidence: "直接证据",
  decision: "历史决策",
  viewpoint: "相邻观点",
  conflict: "冲突反例",
  actor: "人物与项目",
  case: "相似案例",
  question: "待回答问题",
};

export type EmergenceEdgeLevel = "original" | "composed" | "semantic";

export interface EmergencePath {
  /** nodeRef 链，含起点与终点。 */
  nodeRefs: string[];
  /** 每跳的简短关系说明，长度 = nodeRefs.length - 1。 */
  hops: string[];
}

export interface EmergenceNode {
  id: string;
  nodeType: "room" | "entity" | "fact" | "document" | "memory" | "wikiPage";
  label: string;
  sourceGraph: "roomGraph" | "entityFacts" | "linkGraph" | "wiki";
  roomRef: { id: string; title: string } | null;
  updatedAt: string | null;
}

export interface EmergenceEdge {
  id: string;
  from: string;
  to: string;
  relationType: string;
  edgeLevel: EmergenceEdgeLevel;
  confidence: number | null;
}

export interface EmergenceCard {
  id: string;
  kind: EmergenceCardKind;
  title: string;
  summary: string;
  sourceType: string;
  occurredAt: string | null;
  roomRef: { id: string; title: string } | null;
  reason: string;
  quote: string | null;
  path: EmergencePath | null;
  confidence: number;
  nodeRef: string | null;
}

export interface EmergenceProjectionResult {
  cards: EmergenceCard[];
  nodes: EmergenceNode[];
  edges: EmergenceEdge[];
  paths: EmergencePath[];
  /** 本次投影的树根（漫步=起点节点），客户端以它为钻取起点。 */
  focusRootRef: string | null;
  scoreComponents: Record<string, number> | null;
  requestVersion: number;
  degraded: boolean;
  degradedReason: string | null;
  generatedAt: string;
}

/** 投影图节点（服务层组装的统一对象层，漫步用）。 */
export interface ProjectionGraphNode extends EmergenceNode {
  /** 多样性分组键（实体名 / Wiki 首段路径 / 记忆类型等）。 */
  groupKey: string;
}

export interface ProjectionGraphEdge {
  from: string;
  to: string;
  relationType: string;
  edgeLevel: EmergenceEdgeLevel;
  confidence: number | null;
  /** 游走权重：桥接边（跨 Room/跨类型）加成，语义边降权。 */
  weight: number;
}

export interface ProjectionGraph {
  nodes: Map<string, ProjectionGraphNode>;
  edges: ProjectionGraphEdge[];
}

// ───────────────────────── 内容挂载（统一图组装件） ─────────────────────────

/** attachRoomContent 的行形状：服务层取数后传入（结构化子集，便于纯函数测试）。 */
export interface AttachEntityRow {
  entityId: string;
  name: string;
  salience: number;
  lastMentionAt: string | null;
}

export interface AttachFactRow {
  factId: string;
  content: string;
  type: string;
  entityIds: string[];
  sourceCount: number;
  lastMentionAt: string | null;
}

export interface AttachDocumentRow {
  id: string;
  title: string;
  updatedAt: string | null;
}

export interface AttachReferenceRow {
  sourceDocumentId: string;
  targetDocumentId: string;
}

/** 「关系」型事实转实体间直达边的标签截断长度。 */
export const FACT_EDGE_LABEL_MAX = 12;

function factEdgeLabel(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= FACT_EDGE_LABEL_MAX ? trimmed : `${trimmed.slice(0, FACT_EDGE_LABEL_MAX)}…`;
}

/**
 * 把一个 Room 的内容星群挂进统一图（主 Room 与邻 Room 展开共用）：
 * Room→提及→实体、实体→事实→事实、Room→收录→文档、文档↔引用↔文档。
 * 事实挂到全部涉事实体（无实体可挂才连房间根）；「关系」型事实在前两个
 * 实体间补一条以事实内容为标签的直达边——把纯星形拓扑织成可续走的网。
 * 已存在的节点（跨 Room 共享的实体/文档）不覆盖，仍补挂载边。
 */
export function attachRoomContent(input: {
  nodes: Map<string, ProjectionGraphNode>;
  edges: ProjectionGraphEdge[];
  ownerRoomRef: string;
  room: { id: string; title: string };
  entities: AttachEntityRow[];
  facts: AttachFactRow[];
  documents: AttachDocumentRow[];
  references: AttachReferenceRow[];
  entityLimit: number;
  factLimit: number;
  documentLimit: number;
}): void {
  const { nodes, edges, ownerRoomRef } = input;
  const link = (from: string, to: string, relationType: string, edgeLevel: ProjectionGraphEdge["edgeLevel"], confidence: number | null, weight = 1) => {
    if (from === to) return;
    edges.push({ from, to, relationType, edgeLevel, confidence, weight });
  };

  const topEntities = [...input.entities]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, input.entityLimit);
  const knownEntityIds = new Set(topEntities.map((entity) => entity.entityId));
  for (const entity of topEntities) {
    const ref = `entity:${entity.entityId}`;
    if (!nodes.has(ref)) {
      nodes.set(ref, {
        id: ref,
        nodeType: "entity",
        label: entity.name,
        sourceGraph: "entityFacts",
        roomRef: { ...input.room },
        updatedAt: entity.lastMentionAt,
        groupKey: `entity:${entity.name}`,
      });
    }
    link(ownerRoomRef, ref, "提及", "original", entity.salience);
  }

  for (const fact of input.facts.slice(0, input.factLimit)) {
    const ref = `fact:${fact.factId}`;
    if (!nodes.has(ref)) {
      nodes.set(ref, {
        id: ref,
        nodeType: "fact",
        label: fact.content.slice(0, 60),
        sourceGraph: "entityFacts",
        roomRef: { ...input.room },
        updatedAt: fact.lastMentionAt,
        groupKey: `fact:${fact.content.slice(0, 24)}`,
      });
    }
    const confidence = Math.min(1, fact.sourceCount / 3);
    const owners = fact.entityIds.filter((id) => knownEntityIds.has(id));
    for (const owner of owners) link(`entity:${owner}`, ref, "事实", "original", confidence);
    if (owners.length === 0) link(ownerRoomRef, ref, "事实", "original", confidence);
    if (fact.type === "关系" && owners.length >= 2) {
      link(`entity:${owners[0]}`, `entity:${owners[1]}`, factEdgeLabel(fact.content), "original", confidence, 0.9);
    }
  }

  for (const doc of input.documents.slice(0, input.documentLimit)) {
    const ref = `doc:${doc.id}`;
    if (!nodes.has(ref)) {
      nodes.set(ref, {
        id: ref,
        nodeType: "document",
        label: doc.title,
        sourceGraph: "linkGraph",
        roomRef: { ...input.room },
        updatedAt: doc.updatedAt,
        groupKey: "document",
      });
    }
    link(ownerRoomRef, ref, "收录", "original", null);
  }

  const seenPairs = new Set<string>();
  for (const row of input.references) {
    const pairKey = [row.sourceDocumentId, row.targetDocumentId].sort().join("\n");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const from = `doc:${row.sourceDocumentId}`;
    const to = `doc:${row.targetDocumentId}`;
    if (!nodes.has(from) || !nodes.has(to)) continue;
    link(from, to, "引用", "original", null);
  }
}

/** 卡片源数据（toCard 的输入形状，漫步终点节点转卡片）。 */
interface CardSource {
  nodeRef: string;
  kind: EmergenceCardKind;
  title: string;
  summary: string;
  sourceType: string;
  occurredAt: string | null;
  roomRef: { id: string; title: string } | null;
  quote: string | null;
  groupKey: string;
  path: EmergencePath | null;
  edgeLevel: EmergenceEdgeLevel;
  evidence: number;
}

// ───────────────────────── 基础件 ─────────────────────────

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/** 可复现随机序列（mulberry32）：同 seed 同结果，支撑「再走一次」与路径复现。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pathSummary(path: EmergencePath | null): string {
  if (!path || path.nodeRefs.length < 2) return "";
  return path.nodeRefs
    .slice(1)
    .map((ref, index) => `${path.hops[index] ?? "相关"}→${ref}`)
    .join("，");
}

function toCard(
  candidate: CardSource,
  reason: string,
  confidence: number,
): EmergenceCard {
  return {
    id: `card:${sha(`${candidate.nodeRef}:${candidate.kind}`)}`,
    kind: candidate.kind,
    title: candidate.title,
    summary: candidate.summary,
    sourceType: candidate.sourceType,
    occurredAt: candidate.occurredAt,
    roomRef: candidate.roomRef,
    reason,
    quote: candidate.quote,
    path: candidate.path,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    nodeRef: candidate.nodeRef,
  };
}

/** 从选中候选的路径链解析图谱节点/边（路径中间节点从统一图取详情）。 */
function collectGraphFragments(
  focusNode: EmergenceNode,
  cards: EmergenceCard[],
  graph: ProjectionGraph,
): { nodes: EmergenceNode[]; edges: EmergenceEdge[]; paths: EmergencePath[] } {
  const nodes = new Map<string, EmergenceNode>();
  const edges = new Map<string, EmergenceEdge>();
  const pushNode = (node: EmergenceNode | undefined, ref: string) => {
    if (node && !nodes.has(ref)) nodes.set(ref, node);
  };
  pushNode(focusNode, focusNode.id);
  const edgeByEndpoints = new Map<string, ProjectionGraphEdge>();
  for (const edge of graph.edges) {
    edgeByEndpoints.set(`${edge.from}\n${edge.to}`, edge);
    edgeByEndpoints.set(`${edge.to}\n${edge.from}`, edge);
  }
  const linkChain = (path: EmergencePath) => {
    for (let index = 0; index < path.nodeRefs.length; index += 1) {
      const ref = path.nodeRefs[index]!;
      if (index > 0) {
        const previous = path.nodeRefs[index - 1]!;
        // 路径声明了关联但图里没有真实边（如评分选中的事实直连房间）→ 按 hops 合成语义边，
        // 保证返回的图谱片段连通，否则渲染层按边展开会丢节点
        if (previous !== ref) {
          const real = edgeByEndpoints.get(`${previous}\n${ref}`);
          const from = real?.from ?? previous;
          const to = real?.to ?? ref;
          const relationType = real?.relationType ?? path.hops[index - 1]?.trim() ?? "关联";
          const edgeId = `edge:${sha(`${from}\n${to}\n${relationType}`)}`;
          if (!edges.has(edgeId)) {
            edges.set(edgeId, {
              id: edgeId,
              from,
              to,
              relationType,
              edgeLevel: real?.edgeLevel ?? "semantic",
              confidence: real?.confidence ?? null,
            });
          }
        }
      }
      pushNode(graph.nodes.get(ref), ref);
    }
  };
  for (const card of cards) {
    if (card.path) linkChain(card.path);
    const node = graph.nodes.get(card.nodeRef ?? "");
    if (node) pushNode(node, node.id);
  }
  const paths = cards.map((card) => card.path).filter((path): path is EmergencePath => Boolean(path));
  return { nodes: [...nodes.values()], edges: [...edges.values()], paths };
}

// ───────────────────────── 漫步投影（PRD 7.5） ─────────────────────────

interface WalkState {
  nodeRef: string;
  depth: number;
  path: EmergencePath;
}

/**
 * 带 seed 的加权游走：从起点 BFS 展开二至四跳，逐层按边权 + 种子随机
 * 采样控制分支规模；终点候选按桥接价值/新颖度/跨范围/关系距离排序，
 * 同主题组截断后取前 N。每个结果携带完整路径（硬性要求）。
 */
export function buildWanderProjection(input: {
  startNode: EmergenceNode;
  graph: ProjectionGraph;
  seed: number;
  cardsLimit: number;
  requestVersion: number;
  generatedAt: string;
}): EmergenceProjectionResult {
  const random = mulberry32(input.seed);
  const cardsLimit = Math.max(1, Math.min(input.cardsLimit || WANDER_DEFAULT_CARDS, 20));
  const adjacency = new Map<string, Array<{ to: string; edge: ProjectionGraphEdge }>>();
  for (const edge of input.graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push({ to: edge.to, edge });
    adjacency.get(edge.to)!.push({ to: edge.from, edge });
  }

  // 逐层扩展：每层按（边权 × 随机因子）保序采样，避免高分支节点淹没游走
  const reached = new Map<string, WalkState>([
    [input.startNode.id, { nodeRef: input.startNode.id, depth: 0, path: { nodeRefs: [input.startNode.id], hops: [] } }],
  ]);
  let frontier: string[] = [input.startNode.id];
  const PER_LAYER_MAX = 14;
  for (let depth = 1; depth <= WANDER_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const state = reached.get(current)!;
      const neighbors = (adjacency.get(current) ?? [])
        .filter(({ to }) => reached.get(to)?.depth === undefined || reached.get(to)!.depth > depth)
        .map(({ to, edge }) => ({ to, edge, priority: edge.weight * (0.5 + random()) }))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 6);
      for (const neighbor of neighbors) {
        if (reached.has(neighbor.to)) continue;
        const hopLabel = `${neighbor.edge.relationType}`;
        reached.set(neighbor.to, {
          nodeRef: neighbor.to,
          depth,
          path: {
            nodeRefs: [...state.path.nodeRefs, neighbor.to],
            hops: [...state.path.hops, hopLabel],
          },
        });
        next.push(neighbor.to);
      }
    }
    // 层内采样：控制图规模并引入可复现的随机性（「再走一次」的差异来源）
    const nextShuffled: string[] = [];
    next.map((ref) => ({ ref, key: random() }))
      .sort((a, b) => a.key - b.key)
      .forEach(({ ref }) => nextShuffled.push(ref));
    frontier = nextShuffled.slice(0, PER_LAYER_MAX * 2);
  }

  // 终点候选：深度 ≥2（一跳太直白），按桥接/新颖/跨范围/距离打分
  const startRoom = input.graph.nodes.get(input.startNode.id)?.roomRef?.id ?? null;
  const typeSeen = new Map<string, number>();
  const candidates = [...reached.values()]
    .filter((state) => state.depth >= WANDER_MIN_DEPTH)
    .map((state) => {
      const node = input.graph.nodes.get(state.nodeRef);
      if (!node) return null;
      const bridge = (node.roomRef && node.roomRef.id !== startRoom ? 0.5 : 0)
        + (node.nodeType !== input.startNode.nodeType ? 0.5 : 0);
      const novelty = 1 / (1 + (typeSeen.get(node.nodeType) ?? 0));
      typeSeen.set(node.nodeType, (typeSeen.get(node.nodeType) ?? 0) + 1);
      const crossScope = node.roomRef && node.roomRef.id !== startRoom ? 1 : 0;
      const distance = state.depth >= WANDER_MIN_DEPTH && state.depth <= WANDER_MAX_DEPTH ? 1 : 0.5;
      const score = 0.3 * bridge + 0.25 * novelty + 0.2 * crossScope + 0.15 * distance + 0.1 * (0.5 + random() * 0.5);
      return { state, node, score };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score);

  const groupCount = new Map<string, number>();
  const chosen: Array<{ state: WalkState; node: ProjectionGraphNode; score: number }> = [];
  for (const item of candidates) {
    const count = groupCount.get(item.node.groupKey) ?? 0;
    if (count >= SAME_GROUP_MAX) continue;
    groupCount.set(item.node.groupKey, count + 1);
    chosen.push(item);
    if (chosen.length >= cardsLimit) break;
  }

  const cards: EmergenceCard[] = chosen.map(({ state, node, score }) => {
    const via = pathSummary(state.path);
    const reason = via ? `从「${input.startNode.label}」出发：${via}` : `从「${input.startNode.label}」出发发现`;
    return toCard(
      {
        nodeRef: node.id,
        kind: wanderKindOf(node),
        title: node.label,
        summary: truncate(groupSummary(node), 160),
        sourceType: node.nodeType,
        occurredAt: node.updatedAt,
        roomRef: node.roomRef,
        quote: null,
        groupKey: node.groupKey,
        path: state.path,
        edgeLevel: "original",
        evidence: 0.5,
      },
      reason,
      score,
    );
  });

  // 节点上限：超限时从长路径末端收缩，保证每张卡的路径完整
  const fragments = collectGraphFragments(input.startNode, cards, input.graph);
  const trimmed = trimNodes(fragments.nodes, fragments.edges, fragments.paths, input.startNode.id);

  return {
    cards,
    nodes: trimmed.nodes,
    edges: trimmed.edges,
    paths: fragments.paths,
    focusRootRef: input.startNode.id,
    scoreComponents: null,
    requestVersion: input.requestVersion,
    degraded: false,
    degradedReason: null,
    generatedAt: input.generatedAt,
  };
}

function wanderKindOf(node: ProjectionGraphNode): EmergenceCardKind {
  switch (node.nodeType) {
    case "room": return "case";
    case "entity": return "actor";
    case "fact": return "evidence";
    case "memory": return "viewpoint";
    case "wikiPage": return "viewpoint";
    default: return "evidence";
  }
}

function groupSummary(node: ProjectionGraphNode): string {
  const graphLabel: Record<ProjectionGraphNode["sourceGraph"], string> = {
    roomGraph: "关联 Room",
    entityFacts: "实体与事实",
    linkGraph: "内容建联",
    wiki: "Wiki 知识页",
  };
  const roomSuffix = node.roomRef ? `（来自 ${node.roomRef.title}）` : "";
  return `${graphLabel[node.sourceGraph]}${roomSuffix}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 节点数超上限时丢弃「只在最长路径中间出现」的节点，重算剩余边。 */
function trimNodes(
  nodes: EmergenceNode[],
  edges: EmergenceEdge[],
  paths: EmergencePath[],
  startRef: string,
): { nodes: EmergenceNode[]; edges: EmergenceEdge[] } {
  if (nodes.length <= WANDER_MAX_NODES) return { nodes, edges };
  const keep = new Set<string>([startRef]);
  const sortedPaths = [...paths].sort((a, b) => a.nodeRefs.length - b.nodeRefs.length);
  for (const path of sortedPaths) {
    for (const ref of path.nodeRefs) {
      if (keep.size >= WANDER_MAX_NODES) break;
      keep.add(ref);
    }
  }
  return {
    nodes: nodes.filter((node) => keep.has(node.id)),
    edges: edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}
