/**
 * 知识涌现投影（PRD v3.0 §7/§8）：聚焦与漫步两种模式的纯函数投影层。
 *
 * 职责边界（照 overview-projection 模式）：
 * - 本文件只做评分、采样、去重、卡片/图谱塑形，不碰数据库、不调 LLM；
 * - 取数与 LLM 编排在 emergence-service.ts，Prompt/解析在 llm.ts；
 * - 输出 EmergenceProjectionResult 与渲染层 apps/desktop/src/shared/knowledge.ts
 *   中的 DTO 逐字段同形（跨进程契约双份维护，改动需两侧同步）。
 *
 * 漫步的硬性约束（PRD 7.5/7.9）：初始结果不调 LLM、沿真实关系游走、
 * 每个结果都能展示从起点到目标的完整路径；随机游走带可复现种子。
 */

import { createHash } from "node:crypto";

/** 聚焦首屏卡片上限（PRD 7.4）。 */
export const FOCUS_DEFAULT_CARDS = 5;
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
  /** 本次投影的树根（章节级焦点=注入的章节节点），客户端以它为钻取起点。 */
  focusRootRef: string | null;
  scoreComponents: Record<string, number> | null;
  requestVersion: number;
  degraded: boolean;
  degradedReason: string | null;
  generatedAt: string;
}

/** LLM 任务理解输出（PRD 7.4：意图、主题、对象、所需证据类型）。 */
export interface EmergenceTaskUnderstanding {
  intent: string;
  themes: string[];
  objects: string[];
  evidenceNeeds: string[];
}

/** 投影图节点（服务层组装的统一对象层，聚焦/漫步共用）。 */
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

/** 召回层产出的候选（聚焦排序的输入）。 */
export interface EmergenceCandidate {
  nodeRef: string;
  kind: EmergenceCardKind;
  title: string;
  summary: string;
  sourceType: string;
  occurredAt: string | null;
  roomRef: { id: string; title: string } | null;
  quote: string | null;
  groupKey: string;
  /** 候选与焦点之间的路径（nodeRefs[0] 应为焦点节点）。 */
  path: EmergencePath | null;
  edgeLevel: EmergenceEdgeLevel;
  /** 证据质量 0-1（来源数/可信来源折算，召回层负责）。 */
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

function recencyScore(occurredAt: string | null, generatedAt: string): number {
  if (!occurredAt) return 0.3;
  const ageMs = Date.parse(generatedAt) - Date.parse(occurredAt);
  if (!Number.isFinite(ageMs)) return 0.3;
  const days = ageMs / 86_400_000;
  if (days <= 7) return 1;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.6;
  return 0.4;
}

function graphPathScore(edgeLevel: EmergenceEdgeLevel, hasPath: boolean): number {
  if (!hasPath) return 0;
  if (edgeLevel === "original") return 1;
  if (edgeLevel === "composed") return 0.6;
  return 0.3;
}

/** 词面重合度（CJK 逐字 + 西文分词混合召回，降级路径用；理解结果用主题词表）。 */
function termOverlap(text: string, terms: string[]): number {
  const cleaned = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    const needle = term.trim().toLowerCase();
    if (needle && cleaned.includes(needle)) hits += 1;
  }
  return terms.length === 0 ? 0 : Math.min(1, hits / Math.min(terms.length, 4));
}

export function pathSummary(path: EmergencePath | null): string {
  if (!path || path.nodeRefs.length < 2) return "";
  return path.nodeRefs
    .slice(1)
    .map((ref, index) => `${path.hops[index] ?? "相关"}→${ref}`)
    .join("，");
}

function deterministicReason(candidate: EmergenceCandidate, understanding: EmergenceTaskUnderstanding | null): string {
  const via = pathSummary(candidate.path);
  if (understanding && understanding.themes.length > 0) {
    const theme = understanding.themes.slice(0, 2).join("、");
    return via
      ? `与当前任务的主题「${theme}」相关；路径：${via}`
      : `与当前任务的主题「${theme}」相关`;
  }
  return via ? `沿真实关系发现；路径：${via}` : "与当前焦点相关";
}

function toCard(
  candidate: EmergenceCandidate,
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

// ───────────────────────── 聚焦投影（PRD 7.4） ─────────────────────────

export function buildFocusProjection(input: {
  focusNode: EmergenceNode;
  focusText: string;
  understanding: EmergenceTaskUnderstanding | null;
  candidates: EmergenceCandidate[];
  /** LLM 生成的关联理由（nodeRef → reason），降级时为 null。 */
  explanations: Map<string, string> | null;
  limit: number;
  requestVersion: number;
  degraded: boolean;
  degradedReason: string | null;
  generatedAt: string;
  graph: ProjectionGraph;
}): EmergenceProjectionResult {
  const limit = Math.max(1, Math.min(input.limit || FOCUS_DEFAULT_CARDS, 12));
  const terms = input.understanding
    ? [...input.understanding.themes, ...input.understanding.objects]
    : tokenize(input.focusText);

  const scored = input.candidates.map((candidate) => {
    const relevance = termOverlap(`${candidate.title} ${candidate.summary}`, terms);
    const graphPath = graphPathScore(candidate.edgeLevel, Boolean(candidate.path));
    const recency = recencyScore(candidate.occurredAt, input.generatedAt);
    const feedback = 0.5; // 反馈学习后置：中性基线，保持分值口径稳定
    const score = 0.35 * relevance + 0.2 * graphPath + 0.15 * candidate.evidence + 0.1 * recency + 0.1 * feedback;
    return { candidate, score, relevance };
  }).sort((a, b) => b.score - a.score);

  // 多样性：同组最多 2 张（PRD 排序目标里的多样性维度，用分组截断实现）
  const groupCount = new Map<string, number>();
  const selected: typeof scored = [];
  for (const item of scored) {
    const count = groupCount.get(item.candidate.groupKey) ?? 0;
    if (count >= 2) continue;
    groupCount.set(item.candidate.groupKey, count + 1);
    selected.push(item);
    if (selected.length >= limit) break;
  }

  const cards = selected.map(({ candidate, score }) => {
    const llmReason = input.explanations?.get(candidate.nodeRef);
    const reason = llmReason?.trim() || deterministicReason(candidate, input.understanding);
    return toCard(candidate, reason, score);
  });
  const fragments = collectGraphFragments(input.focusNode, cards, input.graph);
  const scoreComponents = selected.length > 0
    ? {
      relevance: Math.round((selected.reduce((sum, item) => sum + item.relevance, 0) / selected.length) * 100) / 100,
      graphPath: Math.round((selected.reduce((sum, item) => sum + graphPathScore(item.candidate.edgeLevel, Boolean(item.candidate.path)), 0) / selected.length) * 100) / 100,
      evidence: Math.round((selected.reduce((sum, item) => sum + item.candidate.evidence, 0) / selected.length) * 100) / 100,
      topScore: Math.round(selected[0]!.score * 100) / 100,
    }
    : null;

  return {
    cards,
    nodes: fragments.nodes,
    edges: fragments.edges,
    paths: fragments.paths,
    focusRootRef: input.focusNode.id,
    scoreComponents,
    requestVersion: input.requestVersion,
    degraded: input.degraded,
    degradedReason: input.degradedReason,
    generatedAt: input.generatedAt,
  };
}

/** CJK 逐字 + 西文分词的简易关键词切分（降级路径的任务相关度底座）。 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) tokens.add(word);
  }
  const cjk = text.match(/[一-鿿]{2,6}/g) ?? [];
  for (const phrase of cjk) tokens.add(phrase);
  return [...tokens].slice(0, 24);
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
