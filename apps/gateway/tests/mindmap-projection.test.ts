import { describe, expect, it } from "vitest";
import {
  MINDMAP_PROMPT_VERSION,
  MINDMAP_ROOT_REF,
  MindmapParseError,
  mindmapToProjection,
  parseAgentMindmap,
} from "../src/modules/knowledge/mindmap-projection.js";

const sampleTree = {
  topic: "连接器统一调研",
  branches: [
    {
      label: "现状梳理",
      children: [
        { label: "双链路并存", children: [{ label: "oo 与 managed" }] },
        { label: "状态存储分裂" },
      ],
    },
    { label: "目标架构", children: [{ label: "统一会话层" }] },
    { label: "风险与开放问题", children: [] },
    { label: "下一步", children: [] },
  ],
  digest: { summary: "统一连接器执行的调研结论" },
};

describe("parseAgentMindmap", () => {
  it("接受合法树并保留 digest", () => {
    const tree = parseAgentMindmap(sampleTree);
    expect(tree.topic).toBe("连接器统一调研");
    expect(tree.branches).toHaveLength(4);
    expect(tree.branches[0]!.children[0]!.children).toEqual([{ label: "oo 与 managed" }]);
    expect(tree.digest?.summary).toBe("统一连接器执行的调研结论");
  });

  it("截断超限层级与分支数", () => {
    const branches = Array.from({ length: 10 }, (_, i) => ({
      label: `分支${i}`,
      children: [
        {
          label: "子",
          children: [
            { label: "孙", children: [{ label: "曾孙不该出现" }] },
          ],
        },
      ],
    }));
    const tree = parseAgentMindmap({ topic: "t", branches });
    expect(tree.branches).toHaveLength(8);
    expect(tree.branches[0]!.children[0]!.children![0]!.label).toBe("孙");
  });

  it("清洗非法条目（空 label / 非对象跳过）", () => {
    const tree = parseAgentMindmap({
      topic: "  主题  ",
      branches: [{ label: "  " }, { label: "有效" }, "not-an-object", { label: "有效2", children: ["x"] }],
    });
    expect(tree.topic).toBe("主题");
    expect(tree.branches.map((b) => b.label)).toEqual(["有效", "有效2"]);
  });

  it("topic 缺失或 branches 全无效时抛错", () => {
    expect(() => parseAgentMindmap({ branches: [] })).toThrow(MindmapParseError);
    expect(() => parseAgentMindmap({ topic: "t", branches: [{ label: " " }] })).toThrow(MindmapParseError);
    expect(() => parseAgentMindmap(null)).toThrow(MindmapParseError);
  });
});

describe("mindmapToProjection", () => {
  const projection = mindmapToProjection({
    tree: parseAgentMindmap(sampleTree),
    scope: "document",
    roomId: "room-1",
    roomTitle: "连接器",
    documentId: "doc-9",
    documentTitle: "发布计划",
    generatedAt: "2026-09-19T00:00:00.000Z",
    requestVersion: 3,
  });

  it("nodeRef 命名稳定且根为 mindmap:root", () => {
    expect(projection.focusRootRef).toBe(MINDMAP_ROOT_REF);
    const root = projection.nodes.find((node) => node.id === MINDMAP_ROOT_REF);
    expect(root?.nodeType).toBe("document");
    expect(root?.label).toBe("连接器统一调研");
    expect(projection.nodes.find((node) => node.id === "mindmap:b0")?.label).toBe("现状梳理");
    expect(projection.nodes.find((node) => node.id === "mindmap:b0-0")?.label).toBe("双链路并存");
    expect(projection.nodes.find((node) => node.id === "mindmap:b0-0-0")?.label).toBe("oo 与 managed");
  });

  it("room 级根节点为 room 类型", () => {
    const roomProjection = mindmapToProjection({
      tree: parseAgentMindmap(sampleTree),
      scope: "room",
      roomId: "room-1",
      roomTitle: "连接器",
      documentId: null,
      documentTitle: null,
      generatedAt: "2026-09-19T00:00:00.000Z",
      requestVersion: 1,
    });
    expect(roomProjection.nodes[0]?.nodeType).toBe("room");
  });

  it("卡片数=一级分支数且 nodeRef/path 对应（卡片⇄图联动）", () => {
    expect(projection.cards).toHaveLength(4);
    projection.cards.forEach((card, index) => {
      expect(card.nodeRef).toBe(`mindmap:b${index}`);
      expect(card.kind).toBe("viewpoint");
      expect(card.sourceType).toBe("mindmap");
      expect(card.path?.nodeRefs).toEqual([MINDMAP_ROOT_REF, `mindmap:b${index}`]);
    });
  });

  it("边连通：每个非根节点的父都在 nodes 里且由边指向", () => {
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    expect(projection.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true);
    expect(new Set(projection.edges.map((edge) => edge.to))).toEqual(
      new Set(projection.nodes.map((node) => node.id).filter((id) => id !== MINDMAP_ROOT_REF)),
    );
    expect(projection.edges.every((edge) => edge.edgeLevel === "composed")).toBe(true);
  });

  it("透传 requestVersion/generatedAt 且不降级", () => {
    expect(projection.requestVersion).toBe(3);
    expect(projection.generatedAt).toBe("2026-09-19T00:00:00.000Z");
    expect(projection.degraded).toBe(false);
    expect(projection.degradedReason).toBeNull();
    expect(projection.scoreComponents).toBeNull();
    expect(MINDMAP_PROMPT_VERSION).toBeGreaterThan(0);
  });
});
