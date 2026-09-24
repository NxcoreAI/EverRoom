import { describe, expect, it } from "vitest";

import {
  SAME_GROUP_MAX,
  WANDER_MAX_NODES,
  attachRoomContent,
  buildWanderProjection,
  mulberry32,
  type EmergenceNode,
  type ProjectionGraph,
  type ProjectionGraphEdge,
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

describe("mulberry32", () => {
  it("同 seed 同序列", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
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
    expect(a.focusRootRef).toBe("room:1");
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

describe("attachRoomContent", () => {
  function harness(room: { id: string; title: string } = { id: "room-1", title: "主 Room" }) {
    const nodes = new Map<string, ProjectionGraphNode>();
    const roomRef = `room:${room.id}`;
    nodes.set(roomRef, node(roomRef, { nodeType: "room", label: room.title, groupKey: "room:root" }));
    return { nodes, edges: [] as ProjectionGraphEdge[], roomRef, room };
  }

  function attach(
    base: ReturnType<typeof harness>,
    input: Partial<Parameters<typeof attachRoomContent>[0]> = {},
  ) {
    attachRoomContent({
      nodes: base.nodes,
      edges: base.edges,
      ownerRoomRef: base.roomRef,
      room: base.room,
      entities: [],
      facts: [],
      documents: [],
      references: [],
      entityLimit: 10,
      factLimit: 10,
      documentLimit: 10,
      ...input,
    });
  }

  const edgeText = (edges: ProjectionGraphEdge[]) =>
    edges.map((edge) => `${edge.from} -${edge.relationType}-> ${edge.to}`);

  it("事实挂到全部涉事实实体；「属性」型多实体事实不补实体间直达边", () => {
    const base = harness();
    attach(base, {
      entities: [
        { entityId: "e1", name: "张三", salience: 0.9, lastMentionAt: null },
        { entityId: "e2", name: "李四", salience: 0.8, lastMentionAt: null },
      ],
      facts: [
        { factId: "f1", content: "张三负责项目 A", type: "属性", entityIds: ["e1", "e2"], sourceCount: 2, lastMentionAt: null },
      ],
    });
    const text = edgeText(base.edges);
    expect(text).toContain("room:room-1 -提及-> entity:e1");
    expect(text).toContain("room:room-1 -提及-> entity:e2");
    expect(text).toContain("entity:e1 -事实-> fact:f1");
    expect(text).toContain("entity:e2 -事实-> fact:f1");
    expect(text.some((item) => item.startsWith("entity:e1 -") && item.endsWith("entity:e2"))).toBe(false);
  });

  it("「关系」型事实在前两个实体间补直达边，标签为截断后的事实内容", () => {
    const base = harness();
    attach(base, {
      entities: [
        { entityId: "e1", name: "张三", salience: 0.9, lastMentionAt: null },
        { entityId: "e2", name: "李四", salience: 0.8, lastMentionAt: null },
      ],
      facts: [
        { factId: "f9", content: "张三与李四在项目 A 中是长期合作伙伴关系", type: "关系", entityIds: ["e2", "e1"], sourceCount: 3, lastMentionAt: null },
      ],
    });
    const direct = base.edges.find((edge) => edge.from === "entity:e2" && edge.to === "entity:e1");
    expect(direct?.relationType).toBe("张三与李四在项目 A 中…");
    expect(direct?.weight).toBe(0.9);
  });

  it("解析不到实体的事实连房间根；实体按显著度截断，边界外实体的提及不挂节点", () => {
    const base = harness();
    attach(base, {
      entities: [
        { entityId: "e1", name: "张三", salience: 0.9, lastMentionAt: null },
        { entityId: "e2", name: "李四", salience: 0.2, lastMentionAt: null },
      ],
      facts: [
        { factId: "f1", content: "孤立事实", type: "属性", entityIds: ["e-missing"], sourceCount: 1, lastMentionAt: null },
        { factId: "f2", content: "边界事实", type: "属性", entityIds: ["e2"], sourceCount: 1, lastMentionAt: null },
      ],
      entityLimit: 1,
    });
    const text = edgeText(base.edges);
    expect(text).toContain("room:room-1 -事实-> fact:f1");
    expect(text).toContain("room:room-1 -事实-> fact:f2");
    expect(base.nodes.has("entity:e2")).toBe(false);
  });

  it("邻 Room 展开复用同一挂载：节点带邻 Room 的 roomRef（跨 Room 标记），共享实体不覆盖只补边", () => {
    const main = harness();
    attach(main, {
      entities: [{ entityId: "shared", name: "共享实体", salience: 0.9, lastMentionAt: null }],
    });
    const neighbor = { id: "room-2", title: "邻 Room" };
    const neighborRef = "room:room-2";
    main.nodes.set(neighborRef, node(neighborRef, { nodeType: "room", label: neighbor.title, groupKey: "room:neighbor" }));
    attachRoomContent({
      nodes: main.nodes,
      edges: main.edges,
      ownerRoomRef: neighborRef,
      room: neighbor,
      entities: [
        { entityId: "shared", name: "共享实体-改名也不覆盖", salience: 0.5, lastMentionAt: null },
        { entityId: "n1", name: "邻实体", salience: 0.7, lastMentionAt: null },
      ],
      facts: [{ factId: "nf1", content: "邻事实", type: "属性", entityIds: ["n1"], sourceCount: 1, lastMentionAt: null }],
      documents: [{ id: "nd1", title: "邻文档", updatedAt: null }],
      references: [],
      entityLimit: 6,
      factLimit: 6,
      documentLimit: 6,
    });
    expect(main.nodes.get("entity:shared")?.label).toBe("共享实体");
    expect(main.nodes.get("entity:n1")?.roomRef).toEqual(neighbor);
    const text = edgeText(main.edges);
    expect(text).toContain("room:room-2 -提及-> entity:shared");
    expect(text).toContain("room:room-2 -提及-> entity:n1");
    expect(text).toContain("entity:n1 -事实-> fact:nf1");
    expect(text).toContain("room:room-2 -收录-> doc:nd1");
  });

  it("文档引用对去重且只连两端都存在的文档", () => {
    const base = harness();
    attach(base, {
      documents: [
        { id: "d1", title: "文档一", updatedAt: null },
        { id: "d2", title: "文档二", updatedAt: null },
      ],
      references: [
        { sourceDocumentId: "d1", targetDocumentId: "d2" },
        { sourceDocumentId: "d2", targetDocumentId: "d1" },
        { sourceDocumentId: "d1", targetDocumentId: "d-missing" },
      ],
    });
    const referenceEdges = base.edges.filter((edge) => edge.relationType === "引用");
    expect(referenceEdges).toHaveLength(1);
  });
});
