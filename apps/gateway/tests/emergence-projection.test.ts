import { describe, expect, it } from "vitest";

import {
  SAME_GROUP_MAX,
  WANDER_MAX_NODES,
  buildFocusProjection,
  buildWanderProjection,
  mulberry32,
  tokenize,
  type EmergenceCandidate,
  type EmergenceNode,
  type ProjectionGraph,
  type ProjectionGraphNode,
} from "../src/modules/knowledge/emergence-projection.js";

const GENERATED_AT = "2026-09-15T00:00:00.000Z";

function node(
  id: string,
  overrides: Partial<ProjectionGraphNode> = {},
): ProjectionGraphNode {
  return {
    id,
    nodeType: "entity",
    label: id,
    sourceGraph: "entityFacts",
    roomRef: null,
    updatedAt: null,
    groupKey: `group:${id}`,
    ...overrides,
  };
}

function graph(nodes: ProjectionGraphNode[], edges: Array<{ from: string; to: string; weight?: number; relationType?: string }>): ProjectionGraph {
  return {
    nodes: new Map(nodes.map((item) => [item.id, item])),
    edges: edges.map((edge, index) => ({
      from: edge.from,
      to: edge.to,
      relationType: edge.relationType ?? "关联",
      edgeLevel: "original" as const,
      confidence: null,
      weight: edge.weight ?? 1,
      id: `edge:${index}`,
    })),
  };
}

function candidate(overrides: Partial<EmergenceCandidate> & { nodeRef: string }): EmergenceCandidate {
  return {
    kind: "evidence",
    title: overrides.nodeRef,
    summary: "",
    sourceType: "entity",
    occurredAt: null,
    roomRef: null,
    quote: null,
    groupKey: `group:${overrides.nodeRef}`,
    path: null,
    edgeLevel: "original",
    evidence: 0.5,
    ...overrides,
  };
}

const FOCUS_NODE: EmergenceNode = node("room:1", { nodeType: "room", label: "目标 Room" });

describe("tokenize", () => {
  it("切出 CJK 短语与西文词", () => {
    const tokens = tokenize("PyTorch 支持 动态计算图 与 automatic differentiation");
    expect(tokens).toContain("pytorch");
    expect(tokens).toContain("动态计算图");
    expect(tokens).toContain("automatic");
    expect(tokens.some((token) => token.length < 2)).toBe(false);
  });
});

describe("mulberry32", () => {
  it("同 seed 同序列", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("buildFocusProjection", () => {
  it("相关性高的候选排前，LLM 理由优先于确定性理由", () => {
    const relevant = candidate({ nodeRef: "entity:1", title: "动态计算图实现", summary: "动态计算图" });
    const irrelevant = candidate({ nodeRef: "entity:2", title: "无关实体", summary: "完全无关" });
    const result = buildFocusProjection({
      focusNode: FOCUS_NODE,
      focusText: "动态计算图",
      understanding: null,
      candidates: [irrelevant, relevant],
      explanations: new Map([["entity:1", "LLM 理由"]]),
      limit: 5,
      requestVersion: 3,
      degraded: false,
      degradedReason: null,
      generatedAt: GENERATED_AT,
      graph: graph([node("entity:1"), node("entity:2")], []),
    });
    expect(result.requestVersion).toBe(3);
    expect(result.cards[0]!.nodeRef).toBe("entity:1");
    expect(result.cards[0]!.reason).toBe("LLM 理由");
    expect(result.cards[1]!.reason).not.toBe("LLM 理由");
    expect(result.scoreComponents).not.toBeNull();
  });

  it("同组候选最多 2 张（多样性截断）", () => {
    const candidates = ["a", "b", "c", "d"].map((key) => candidate({
      nodeRef: `entity:${key}`,
      groupKey: "same-group",
      title: `候选${key}`,
      summary: "",
    }));
    const result = buildFocusProjection({
      focusNode: FOCUS_NODE,
      focusText: "",
      understanding: null,
      candidates,
      explanations: null,
      limit: 5,
      requestVersion: 1,
      degraded: false,
      degradedReason: null,
      generatedAt: GENERATED_AT,
      graph: graph(candidates.map((item) => node(item.nodeRef)), []),
    });
    expect(result.cards.length).toBe(2);
  });

  it("降级标记透传", () => {
    const result = buildFocusProjection({
      focusNode: FOCUS_NODE,
      focusText: "",
      understanding: null,
      candidates: [candidate({ nodeRef: "entity:1" })],
      explanations: null,
      limit: 5,
      requestVersion: 1,
      degraded: true,
      degradedReason: "llm_unavailable",
      generatedAt: GENERATED_AT,
      graph: graph([node("entity:1")], []),
    });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("llm_unavailable");
  });
});

describe("buildWanderProjection", () => {
  function chainGraph(): ProjectionGraph {
    // room:1 — e1 — e2 — e3 — e4 — e5（线性链，深度即跳数）
    const nodes = [
      node("room:1", { nodeType: "room", label: "Room 根" }),
      node("entity:e1"), node("entity:e2"), node("entity:e3"), node("entity:e4"), node("entity:e5"),
    ];
    const edges = [
      { from: "room:1", to: "entity:e1" },
      { from: "entity:e1", to: "entity:e2" },
      { from: "entity:e2", to: "entity:e3" },
      { from: "entity:e3", to: "entity:e4" },
      { from: "entity:e4", to: "entity:e5" },
    ];
    return graph(nodes, edges);
  }

  it("同 seed 结果完全可复现", () => {
    const input = {
      startNode: node("room:1", { nodeType: "room", label: "Room 根" }) as EmergenceNode,
      graph: chainGraph(),
      cardsLimit: 5,
      requestVersion: 7,
      generatedAt: GENERATED_AT,
    };
    const a = buildWanderProjection({ ...input, seed: 123 });
    const b = buildWanderProjection({ ...input, seed: 123 });
    expect(a.cards).toEqual(b.cards);
    expect(a.nodes).toEqual(b.nodes);
  });

  it("结果都带完整路径：起点打头、深度≥2、hops 与节点数对齐", () => {
    const result = buildWanderProjection({
      startNode: node("room:1", { nodeType: "room", label: "Room 根" }) as EmergenceNode,
      graph: chainGraph(),
      seed: 5,
      cardsLimit: 5,
      requestVersion: 1,
      generatedAt: GENERATED_AT,
    });
    expect(result.cards.length).toBeGreaterThan(0);
    for (const card of result.cards) {
      expect(card.path).not.toBeNull();
      expect(card.path!.nodeRefs[0]).toBe("room:1");
      expect(card.path!.nodeRefs.at(-1)).toBe(card.nodeRef);
      expect(card.path!.hops.length).toBe(card.path!.nodeRefs.length - 1);
      // 深度 ≥2（一跳太直白不进候选）
      expect(card.path!.nodeRefs.length).toBeGreaterThanOrEqual(3);
      expect(card.reason).toContain("Room 根");
    }
  });

  it("节点上限：图超过 35 节点时收缩", () => {
    const nodes = [node("room:1", { nodeType: "room", label: "Room 根" })];
    const edges: Array<{ from: string; to: string; weight?: number }> = [];
    for (let index = 1; index <= 60; index += 1) {
      const id = `entity:n${index}`;
      nodes.push(node(id, { groupKey: `group:${index % 10}` }));
      edges.push({ from: "room:1", to: id, weight: 1 });
    }
    // 串联一部分边制造 ≥2 跳的候选
    for (let index = 1; index <= 55; index += 1) {
      edges.push({ from: `entity:n${index}`, to: `entity:n${index + 1}`, weight: 1 });
    }
    const result = buildWanderProjection({
      startNode: node("room:1", { nodeType: "room", label: "Room 根" }) as EmergenceNode,
      graph: graph(nodes, edges),
      seed: 9,
      cardsLimit: 20,
      requestVersion: 1,
      generatedAt: GENERATED_AT,
    });
    expect(result.nodes.length).toBeLessThanOrEqual(WANDER_MAX_NODES);
    expect(result.cards.length).toBeLessThanOrEqual(20);
  });

  it("同组截断：同 groupKey 不超过上限", () => {
    const nodes = [node("room:1", { nodeType: "room", label: "Room 根" })];
    const edges: Array<{ from: string; to: string }> = [];
    for (let index = 1; index <= 8; index += 1) {
      const id = `entity:g${index}`;
      nodes.push(node(id, { groupKey: "same-group" }));
      edges.push({ from: "room:1", to: id });
    }
    for (let index = 1; index <= 7; index += 1) {
      edges.push({ from: `entity:g${index}`, to: `entity:g${index + 1}` });
    }
    const result = buildWanderProjection({
      startNode: node("room:1", { nodeType: "room", label: "Room 根" }) as EmergenceNode,
      graph: graph(nodes, edges),
      seed: 3,
      cardsLimit: 15,
      requestVersion: 1,
      generatedAt: GENERATED_AT,
    });
    expect(result.cards.length).toBeLessThanOrEqual(SAME_GROUP_MAX);
  });
});
